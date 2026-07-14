import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { codeInterpreterTool, tool, webSearchTool } from '@openai/agents';
import { z } from 'zod';
import { withExclusiveFileLock } from './core/state-file.js';

const MAX_TEXT_BYTES = 200_000;
const MAX_SHELL_OUTPUT = 100_000;
const MAX_HTTP_BYTES = 200_000;
const SKIPPED_DIRECTORIES = new Set(['.git', '.nano-agent', 'node_modules', 'dist']);

function resolvePath(workspaceRoot: string, requestedPath: string): string {
  return path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.resolve(workspaceRoot, requestedPath);
}

function containsPath(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function assertPathAllowed(target: string, protectedPaths: string[]): Promise<void> {
  const candidates = [path.resolve(target)];
  try {
    candidates.push(await realpath(target));
  } catch {
    try {
      candidates.push(path.join(await realpath(path.dirname(target)), path.basename(target)));
    } catch {
      // The lexical check still protects non-existing paths under a protected root.
    }
  }
  const protectedCandidates = (await Promise.all(protectedPaths.map(async (protectedPath) => [
    path.resolve(protectedPath),
    await canonicalPotentialPath(protectedPath),
  ]))).flat();
  if (protectedCandidates.some((protectedPath) => candidates.some((candidate) => containsPath(protectedPath, candidate)))) {
    throw new Error('该路径属于 NanoAgent 私有运行数据，当前 Session 无权通过文件工具访问');
  }
}

async function canonicalPotentialPath(target: string): Promise<string> {
  let current = path.resolve(target);
  const suffix: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(current), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

export interface ToolAccessPolicy {
  readablePaths?: string[];
  writablePaths?: string[];
  allowWrite?: boolean;
  allowShell?: boolean;
  allowProtectedPathShellAccess?: boolean;
}

async function assertScopedPath(
  workspaceRoot: string,
  target: string,
  declaredPaths: string[] | undefined,
  operation: '读取' | '写入',
): Promise<void> {
  if (declaredPaths === undefined) return;
  const workspace = path.resolve(workspaceRoot);
  const lexicalTarget = path.resolve(target);
  const lexicallyWithinWorkspace = containsPath(workspace, lexicalTarget);
  const lexicalRoots = declaredPaths.map((value) => resolvePath(workspace, value));
  if (lexicalRoots.some((root) => !containsPath(workspace, root))) {
    throw new Error(`声明的${operation}路径不能超出当前工作区`);
  }
  if (lexicallyWithinWorkspace && !lexicalRoots.some((root) => containsPath(root, lexicalTarget))) {
    throw new Error(`${operation}路径超出当前声明的 paths`);
  }
  const [canonicalWorkspace, canonicalTarget, canonicalRoots] = await Promise.all([
    canonicalPotentialPath(workspace),
    canonicalPotentialPath(lexicalTarget),
    Promise.all(lexicalRoots.map(canonicalPotentialPath)),
  ]);
  const canonicallyWithinWorkspace = containsPath(canonicalWorkspace, canonicalTarget);
  if (!lexicallyWithinWorkspace && !canonicallyWithinWorkspace) {
    throw new Error(`${operation}路径不能超出当前工作区`);
  }
  if (!canonicallyWithinWorkspace || !canonicalRoots.some((root) => containsPath(root, canonicalTarget))) {
    const boundary = operation === '读取' ? '读取范围' : '声明的 paths';
    throw new Error(`${operation}路径通过符号链接超出当前${boundary}`);
  }
}

async function assertReadablePath(
  workspaceRoot: string,
  target: string,
  readablePaths: string[] | undefined,
): Promise<void> {
  return assertScopedPath(workspaceRoot, target, readablePaths, '读取');
}

async function assertWritablePath(
  workspaceRoot: string,
  target: string,
  writablePaths: string[] | undefined,
): Promise<void> {
  return assertScopedPath(workspaceRoot, target, writablePaths, '写入');
}

function sandboxProfile(protectedPaths: string[]): string {
  const quote = (value: string) => `"${path.resolve(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return [
    '(version 1)',
    '(allow default)',
    ...protectedPaths.flatMap((protectedPath) => [
      `(deny file-read* (subpath ${quote(protectedPath)}))`,
      `(deny file-write* (subpath ${quote(protectedPath)}))`,
    ]),
  ].join(' ');
}

function truncate(value: string, limit = MAX_SHELL_OUTPUT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[输出已截断，共 ${value.length} 字符]`;
}

export async function readLocalFile(
  workspaceRoot: string,
  requestedPath: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const handle = await open(resolvePath(workspaceRoot, requestedPath), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('只支持读取常规文本文件');
    if (info.size > MAX_TEXT_BYTES) throw new Error(`文件超过 ${MAX_TEXT_BYTES} 字节限制，请使用 Shell 分段读取`);
    const buffer = Buffer.alloc(Math.min(MAX_TEXT_BYTES + 1, Math.max(1, info.size + 1)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    signal?.throwIfAborted();
    if (bytesRead > MAX_TEXT_BYTES) throw new Error(`文件超过 ${MAX_TEXT_BYTES} 字节限制，请使用 Shell 分段读取`);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function withMutationLocks<R>(targets: string[], operation: () => Promise<R>): Promise<R> {
  const canonical = [...new Set(await Promise.all(targets.map(canonicalPotentialPath)))].sort();
  const acquire = (index: number): Promise<R> => index >= canonical.length
    ? operation()
    : withExclusiveFileLock(canonical[index]!, () => acquire(index + 1));
  return acquire(0);
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const mode = await stat(target).then((info) => info.mode & 0o777).catch(() => 0o666);
  const temporary = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode });
    await rename(temporary, target);
  } finally {
    await import('node:fs/promises').then(({ rm }) => rm(temporary, { force: true }));
  }
}

export async function writeLocalFile(
  workspaceRoot: string,
  requestedPath: string,
  content: string,
  validate?: (target: string) => Promise<void>,
): Promise<string> {
  const target = resolvePath(workspaceRoot, requestedPath);
  let writtenTarget = target;
  await withMutationLocks([target], async () => {
    writtenTarget = await canonicalPotentialPath(target);
    await validate?.(writtenTarget);
    await atomicWrite(writtenTarget, content);
  });
  return `已写入 ${writtenTarget}（${Buffer.byteLength(content, 'utf8')} 字节）`;
}

export async function editLocalFile(
  workspaceRoot: string,
  requestedPath: string,
  oldText: string,
  newText: string,
  replaceAll = false,
  validate?: (target: string) => Promise<void>,
): Promise<{ path: string; replacements: number }> {
  if (!oldText) throw new Error('oldText 不能为空');
  const target = resolvePath(workspaceRoot, requestedPath);
  return withMutationLocks([target], async () => {
    const operationTarget = await canonicalPotentialPath(target);
    await validate?.(operationTarget);
    const content = await readLocalFile('/', operationTarget);
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) throw new Error('未找到要替换的原文');
    const next = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
    await atomicWrite(operationTarget, next);
    return { path: target, replacements: replaceAll ? occurrences : 1 };
  });
}

export async function moveLocalFile(
  workspaceRoot: string,
  sourcePath: string,
  destinationPath: string,
  overwrite = false,
  validate?: (source: string, destination: string) => Promise<void>,
): Promise<{ from: string; to: string }> {
  const source = resolvePath(workspaceRoot, sourcePath);
  const destination = resolvePath(workspaceRoot, destinationPath);
  return withMutationLocks([source, destination], async () => {
    const operationSourceParent = await canonicalPotentialPath(path.dirname(source));
    const operationDestinationParent = await canonicalPotentialPath(path.dirname(destination));
    const checkedSource = path.join(operationSourceParent, path.basename(source));
    const checkedDestination = path.join(operationDestinationParent, path.basename(destination));
    await validate?.(checkedSource, checkedDestination);
    if (!overwrite) {
      try {
        await stat(checkedDestination);
        throw new Error(`目标已存在：${checkedDestination}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await mkdir(path.dirname(checkedDestination), { recursive: true });
    await rename(checkedSource, checkedDestination);
    return { from: source, to: destination };
  });
}

export interface FileSearchMatch {
  path: string;
  line?: number;
  text?: string;
  match: 'path' | 'content';
}

export interface FileSearchLimits {
  maxScannedEntries?: number;
  maxDepth?: number;
  maxReadBytes?: number;
}

export async function searchLocalFiles(
  workspaceRoot: string,
  query: string,
  requestedPath = '.',
  maxResults = 50,
  signal?: AbortSignal,
  limits: FileSearchLimits = {},
): Promise<FileSearchMatch[]> {
  const root = resolvePath(workspaceRoot, requestedPath);
  const needle = query.toLowerCase();
  const results: FileSearchMatch[] = [];
  const maxScannedEntries = limits.maxScannedEntries ?? 10_000;
  const maxDepth = limits.maxDepth ?? 64;
  const maxReadBytes = limits.maxReadBytes ?? 20_000_000;
  let scannedEntries = 0;
  let readBytes = 0;

  const visit = async (target: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (results.length >= maxResults) return;
    if (depth > maxDepth) throw new Error(`文件搜索目录深度超过 ${maxDepth} 层`);
    scannedEntries += 1;
    if (scannedEntries > maxScannedEntries) throw new Error(`文件搜索扫描项超过 ${maxScannedEntries} 个`);
    let info;
    try {
      info = await lstat(target);
    } catch {
      return;
    }
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      if (target !== root && SKIPPED_DIRECTORIES.has(path.basename(target))) return;
      for (const entry of await readdir(target)) {
        await visit(path.join(target, entry), depth + 1);
        if (results.length >= maxResults) break;
      }
      return;
    }
    if (!info.isFile() || info.size > MAX_TEXT_BYTES) return;
    readBytes += info.size;
    if (readBytes > maxReadBytes) throw new Error(`文件搜索读取总量超过 ${maxReadBytes} 字节`);
    const relativePath = path.relative(workspaceRoot, target);
    if (relativePath.toLowerCase().includes(needle)) {
      results.push({ path: relativePath, match: 'path' });
      if (results.length >= maxResults) return;
    }
    let content: string;
    try {
      content = await readFile(target, 'utf8');
    } catch {
      return;
    }
    if (content.includes('\0')) return;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index]!.toLowerCase().includes(needle)) continue;
      results.push({
        path: relativePath,
        line: index + 1,
        text: truncate(lines[index]!.trim(), 240),
        match: 'content',
      });
      if (results.length >= maxResults) break;
    }
  };

  await visit(root, 0);
  return results;
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = MAX_HTTP_BYTES - bytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        bytes = MAX_HTTP_BYTES;
        await reader.cancel('response limit reached');
        return `${Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')}\n...[响应已截断，超过 ${MAX_HTTP_BYTES} 字节]`;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

export async function requestUrl(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutSeconds: number,
  signal?: AbortSignal,
) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('只支持 HTTP 和 HTTPS URL');
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutSeconds * 1_000)])
    : AbortSignal.timeout(timeoutSeconds * 1_000);
  const response = await fetch(target, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
    signal: requestSignal,
  });
  return {
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers),
    body: await readBoundedResponse(response, requestSignal),
  };
}

export async function runShellCommand(
  workspaceRoot: string,
  command: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
  protectedPaths: string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (protectedPaths.length && process.platform !== 'darwin') {
    return { exitCode: 1, stdout: '', stderr: '当前平台缺少私有目录沙箱，已禁用 Shell 工具以保护 Session 隔离' };
  }
  const canonicalProtectedPaths = await Promise.all(protectedPaths.map(async (protectedPath) => {
    try {
      return await realpath(protectedPath);
    } catch {
      return path.resolve(protectedPath);
    }
  }));
  const localShell = process.platform === 'win32'
    ? (process.env.ComSpec ?? 'cmd.exe')
    : process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
  const executable = canonicalProtectedPaths.length && process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : localShell;
  const args = canonicalProtectedPaths.length && process.platform === 'darwin'
    ? ['-p', sandboxProfile(canonicalProtectedPaths), '/bin/zsh', '-lc', command]
    : process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];

  if (signal?.aborted) {
    const message = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? '命令已取消');
    return { exitCode: 1, stdout: '', stderr: message };
  }

  return new Promise((resolve) => {
    const outputLimit = 2 * 1024 * 1024;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminating = false;
    let terminationMessage = '';
    let closed = false;
    let closeCode: number | null = null;
    let spawnError: Error | undefined;
    let killFinished = false;
    let settled = false;
    let hardKillTimer: NodeJS.Timeout | undefined;
    const child = spawn(executable, args, {
      cwd: workspaceRoot,
      detached: process.platform !== 'win32',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const finish = (): void => {
      if (settled || !closed || (terminating && !killFinished)) return;
      settled = true;
      clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', abort);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      resolve({
        exitCode: terminating || spawnError ? 1 : (closeCode ?? 1),
        stdout: truncate(stdout),
        stderr: truncate([stderr, terminationMessage, spawnError?.message].filter(Boolean).join('\n')),
      });
    };

    const kill = (force = false): void => {
      if (!child.pid) return;
      const signalName = force ? 'SIGKILL' : 'SIGTERM';
      try {
        if (process.platform === 'win32') child.kill(signalName);
        else process.kill(-child.pid, signalName);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signalName);
      }
    };
    const terminate = (message: string): void => {
      if (terminating) return;
      terminating = true;
      terminationMessage = message;
      kill(false);
      hardKillTimer = setTimeout(() => {
        kill(true);
        killFinished = true;
        finish();
      }, 150);
    };
    const abort = (): void => terminate(
      signal?.reason instanceof Error ? signal.reason.message : String(signal?.reason ?? '命令已取消'),
    );
    const timeoutTimer = setTimeout(
      () => terminate(`命令执行超过 ${timeoutSeconds} 秒，已终止`),
      timeoutSeconds * 1_000,
    );
    timeoutTimer.unref();
    signal?.addEventListener('abort', abort, { once: true });

    const capture = (target: Buffer[], chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      if (stream === 'stdout') stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      const total = stream === 'stdout' ? stdoutBytes : stderrBytes;
      if (total <= outputLimit) target.push(chunk);
      if (total > outputLimit) terminate(`${stream} 超过 ${outputLimit} 字节限制，已终止命令`);
    };
    child.stdout.on('data', (chunk: Buffer) => capture(stdoutChunks, chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => capture(stderrChunks, chunk, 'stderr'));
    child.once('error', (error) => {
      spawnError = error;
      if (!child.pid) {
        closed = true;
        killFinished = true;
        finish();
      }
    });
    child.once('close', (code) => {
      closed = true;
      closeCode = code;
      if (!terminating) killFinished = true;
      finish();
    });
  });
}

export function createTools(
  workspaceRoot: string,
  includeOpenAIHostedTools = true,
  protectedPaths: string[] = [],
  access: ToolAccessPolicy = {},
) {
  const currentTime = tool({
    name: 'current_time',
    description: '获取当前日期、时间和时区。',
    parameters: z.object({}),
    execute: async () => ({
      iso: new Date().toISOString(),
      local: new Date().toString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  });

  const readFileTool = tool({
    name: 'read_file',
    description: '读取本机 UTF-8 文本文件，支持绝对路径或相对当前工作区的路径。',
    parameters: z.object({ path: z.string().min(1) }),
    execute: async ({ path: requestedPath }, _context, details) => {
      const target = resolvePath(workspaceRoot, requestedPath);
      await Promise.all([
        assertPathAllowed(target, protectedPaths),
        assertReadablePath(workspaceRoot, target, access.readablePaths),
      ]);
      return readLocalFile(workspaceRoot, requestedPath, details?.signal);
    },
  });

  const writeFileTool = tool({
    name: 'write_file',
    description: '创建或覆盖本机文本文件，支持绝对路径或相对当前工作区的路径。',
    parameters: z.object({
      path: z.string().min(1),
      content: z.string(),
    }),
    execute: async ({ path: requestedPath, content }) => {
      const target = resolvePath(workspaceRoot, requestedPath);
      return writeLocalFile(workspaceRoot, requestedPath, content, async () => Promise.all([
        assertPathAllowed(target, protectedPaths),
        assertWritablePath(workspaceRoot, target, access.writablePaths),
      ]).then(() => undefined));
    },
  });

  const editFile = tool({
    name: 'edit_file',
    description: '在文本文件中精确替换一段原文，适合小范围修改而无需重写整个文件。',
    parameters: z.object({
      path: z.string().min(1),
      oldText: z.string().min(1),
      newText: z.string(),
      replaceAll: z.boolean().default(false),
    }),
    execute: async ({ path: requestedPath, oldText, newText, replaceAll }) => {
      const target = resolvePath(workspaceRoot, requestedPath);
      return editLocalFile(workspaceRoot, requestedPath, oldText, newText, replaceAll, async () => Promise.all([
        assertPathAllowed(target, protectedPaths),
        assertWritablePath(workspaceRoot, target, access.writablePaths),
      ]).then(() => undefined));
    },
  });

  const moveFile = tool({
    name: 'move_file',
    description: '移动或重命名文件；默认不覆盖已有目标。',
    parameters: z.object({
      source: z.string().min(1),
      destination: z.string().min(1),
      overwrite: z.boolean().default(false),
    }),
    execute: async ({ source, destination, overwrite }) => {
      const sourceTarget = resolvePath(workspaceRoot, source);
      const destinationTarget = resolvePath(workspaceRoot, destination);
      return moveLocalFile(workspaceRoot, source, destination, overwrite, async () => Promise.all([
        assertPathAllowed(sourceTarget, protectedPaths),
        assertPathAllowed(destinationTarget, protectedPaths),
        assertWritablePath(workspaceRoot, sourceTarget, access.writablePaths),
        assertWritablePath(workspaceRoot, destinationTarget, access.writablePaths),
      ]).then(() => undefined));
    },
  });

  const listDirectory = tool({
    name: 'list_directory',
    description: '列出本机目录内容，支持绝对路径或相对当前工作区的路径。',
    parameters: z.object({
      path: z.string().default('.'),
      includeHidden: z.boolean().default(false),
    }),
    execute: async ({ path: requestedPath, includeHidden }) => {
      const target = resolvePath(workspaceRoot, requestedPath);
      await Promise.all([
        assertPathAllowed(target, protectedPaths),
        assertReadablePath(workspaceRoot, target, access.readablePaths),
      ]);
      const entries = await readdir(target, { withFileTypes: true });
      return entries
        .filter((entry) => includeHidden || !entry.name.startsWith('.'))
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory()
            ? 'directory'
            : entry.isSymbolicLink()
              ? 'symlink'
              : 'file',
        }));
    },
  });

  const searchFiles = tool({
    name: 'search_files',
    description: '在工作区中按文件名和文本内容搜索，自动跳过 .git、node_modules、dist 和运行数据。',
    parameters: z.object({
      query: z.string().min(1),
      path: z.string().default('.'),
      maxResults: z.number().int().min(1).max(200).default(50),
    }),
    execute: async ({ query, path: requestedPath, maxResults }, _context, details) => {
      const target = resolvePath(workspaceRoot, requestedPath);
      await Promise.all([
        assertPathAllowed(target, protectedPaths),
        assertReadablePath(workspaceRoot, target, access.readablePaths),
      ]);
      return searchLocalFiles(workspaceRoot, query, requestedPath, maxResults, details?.signal);
    },
  });

  const shell = tool({
    name: 'run_shell',
    description:
      '在本机系统 Shell 中执行命令。可用于搜索文件、Git、网络请求、安装依赖、运行代码和系统自动化。',
    parameters: z.object({
      command: z.string().min(1),
      timeoutSeconds: z.number().int().min(1).max(300).default(60),
    }),
    execute: async ({ command, timeoutSeconds }, _context, details) =>
      runShellCommand(
        workspaceRoot,
        command,
        timeoutSeconds,
        details?.signal,
        access.allowProtectedPathShellAccess ? [] : protectedPaths,
      ),
  });

  const calculate = tool({
    name: 'calculate',
    description: '执行两个数字之间的基础数学运算。',
    parameters: z.object({
      operation: z.enum(['add', 'subtract', 'multiply', 'divide', 'power']),
      a: z.number(),
      b: z.number(),
    }),
    execute: async ({ operation, a, b }) => {
      if (operation === 'add') return a + b;
      if (operation === 'subtract') return a - b;
      if (operation === 'multiply') return a * b;
      if (operation === 'divide') {
        if (b === 0) throw new Error('不能除以零');
        return a / b;
      }
      return a ** b;
    },
  });

  const httpRequest = tool({
    name: 'http_request',
    description: '发送 HTTP/HTTPS 请求并返回状态、响应头和正文，适合调用 JSON API 或读取网页。',
    parameters: z.object({
      url: z.url(),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
      headers: z.record(z.string(), z.string()).default({}),
      body: z.string().optional(),
      timeoutSeconds: z.number().int().min(1).max(120).default(30),
    }),
    execute: async ({ url, method, headers, body, timeoutSeconds }, _context, details) =>
      requestUrl(url, method, headers, body, timeoutSeconds, details?.signal),
  });

  const httpGet = tool({
    name: 'http_get',
    description: '以只读 GET 请求读取 HTTP/HTTPS 资源；不能发送请求正文或使用写入方法。',
    parameters: z.object({
      url: z.url(),
      headers: z.record(z.string(), z.string()).default({}),
      timeoutSeconds: z.number().int().min(1).max(120).default(30),
    }),
    execute: async ({ url, headers, timeoutSeconds }, _context, details) =>
      requestUrl(url, 'GET', headers, undefined, timeoutSeconds, details?.signal),
  });

  const webSearch = tool({
    name: 'web_search',
    description: '搜索互联网（Bing，无需配置）。适用于查找最新资讯、教程、文档、图片等。也可配置 GOOGLE_CSE_API_KEY+GOOGLE_CSE_CX 使用 Google 搜索。',
    parameters: z.object({
      query: z.string().min(1).describe('搜索关键词，尽量精确'),
      num: z.number().int().min(1).max(10).default(5).describe('返回结果数量，默认 5，最多 10'),
    }),
    execute: async ({ query, num }, _context, details) => {
      const signals = [AbortSignal.timeout(15_000)];
      if (details?.signal) signals.push(details.signal);
      const signal = AbortSignal.any(signals);
      // 优先使用 Google CSE（如果有配置）
      const apiKey = process.env.GOOGLE_CSE_API_KEY;
      const cx = process.env.GOOGLE_CSE_CX;
      if (apiKey && cx) {
        const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=${num}`;
        const res = await fetch(url, { signal });
        if (!res.ok) throw new Error(`Google CSE 返回 ${res.status}: ${await res.text()}`);
        const data = await res.json() as { items?: Array<{ title?: string; link?: string; snippet?: string }> };
        if (!data.items?.length) return '未找到结果';
        return data.items.map((item, i) =>
          `${i + 1}. ${item.title ?? '无标题'}\n   链接: ${item.link ?? ''}\n   摘要: ${item.snippet ?? ''}`
        ).join('\n\n');
      }
      // 默认使用 Bing 搜索（无需 API Key）
      const response = await fetch(
        `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9',
          },
          signal,
        },
      );
      if (!response.ok) throw new Error(`Bing 返回 ${response.status}: ${await response.text()}`);
      const html = await response.text();
      const algoBlocks = html.match(/<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>[\s\S]*?<\/li>/g);
      if (!algoBlocks?.length) return '未找到搜索结果';
      return algoBlocks.slice(0, num).map((block, i) => {
        const urlMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/);
        const titleMatch = block.match(/<a[^>]*>([\s\S]*?)<\/a>/);
        const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
        const url = urlMatch ? urlMatch[1]!.replace(/&amp;/g, '&') : '';
        const title = titleMatch ? titleMatch[1]!.replace(/<[^>]+>/g, '').trim() : '';
        const snippet = snippetMatch ? snippetMatch[1]!.replace(/<[^>]+>/g, '').trim() : '';
        if (!title) return '';
        return `${i + 1}. ${title}\n   链接: ${url}\n   摘要: ${snippet.slice(0, 200)}`;
      }).filter(Boolean).join('\n\n');
    },
  });

  const localTools = [
    currentTime,
    readFileTool,
    ...(access.allowWrite === false ? [] : [writeFileTool, editFile, moveFile]),
    listDirectory,
    searchFiles,
    ...(access.allowShell === false ? [] : [shell]),
    calculate,
    httpGet,
    httpRequest,
  ];

  if (!includeOpenAIHostedTools) return [...localTools, webSearch];
  return [
    ...localTools,
    webSearchTool({ searchContextSize: 'low', externalWebAccess: true }),
    codeInterpreterTool(),
  ];
}
