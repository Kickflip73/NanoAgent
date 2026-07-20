import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { isIP, type LookupFunction } from 'node:net';
import path from 'node:path';
import { codeInterpreterTool, tool, webSearchTool } from '@openai/agents';
import { Agent as HttpAgent, fetch } from 'undici';
import { z } from 'zod';
import { PRE_MIMI_DATA_DIRECTORY } from './core/mimi-legacy.js';
import { withExclusiveFileLock } from './core/state-file.js';

const MAX_TEXT_BYTES = 200_000;
const MAX_RANGED_TEXT_BYTES = 5_000_000;
const MAX_SHELL_OUTPUT = 100_000;
const MAX_HTTP_BYTES = 200_000;
const MAX_HTTP_REDIRECTS = 5;
const SKIPPED_DIRECTORIES = new Set([
  '.git', '.mimi-agent', PRE_MIMI_DATA_DIRECTORY, 'node_modules', 'dist',
]);

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
    throw new Error('该路径属于 MimiAgent 私有运行数据（含旧目录），当前 Session 无权通过文件工具访问');
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
  shellEnvironment?: NodeJS.ProcessEnv;
  shellDetachedProcessGroup?: boolean;
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

export interface LocalFileView {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  bytes: number;
  sha256: string;
  truncated: boolean;
}

export async function readLocalFileView(
  workspaceRoot: string,
  requestedPath: string,
  options: { startLine?: number; endLine?: number; maxLines?: number } = {},
  signal?: AbortSignal,
): Promise<LocalFileView> {
  signal?.throwIfAborted();
  const target = resolvePath(workspaceRoot, requestedPath);
  const info = await stat(target);
  if (!info.isFile()) throw new Error('只支持读取常规文本文件');
  const ranged = options.startLine !== undefined || options.endLine !== undefined || options.maxLines !== undefined;
  const byteLimit = ranged ? MAX_RANGED_TEXT_BYTES : MAX_TEXT_BYTES;
  if (info.size > byteLimit) {
    throw new Error(`文件超过 ${byteLimit} 字节限制，请缩小目标文件或使用 Shell 分段读取`);
  }
  const buffer = await readFile(target, { signal });
  signal?.throwIfAborted();
  const content = buffer.toString('utf8');
  if (content.includes('\0')) throw new Error('只支持读取 UTF-8 文本文件');
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  const startLine = options.startLine ?? 1;
  if (startLine > totalLines) throw new Error(`起始行 ${startLine} 超出文件总行数 ${totalLines}`);
  const requestedEnd = options.endLine ?? totalLines;
  if (requestedEnd < startLine) throw new Error('endLine 不能小于 startLine');
  const maxLines = options.maxLines ?? (ranged ? 400 : totalLines);
  const endLine = Math.min(totalLines, requestedEnd, startLine + maxLines - 1);
  return {
    path: target,
    content: lines.slice(startLine - 1, endLine).join('\n'),
    startLine,
    endLine,
    totalLines,
    bytes: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    truncated: startLine > 1 || endLine < totalLines,
  };
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

interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

interface ParsedFilePatch {
  oldPath: string | null;
  newPath: string | null;
  hunks: PatchHunk[];
}

export interface PatchFileResult {
  path: string;
  created: boolean;
  additions: number;
  deletions: number;
  oldSha256?: string;
  newSha256: string;
}

function patchPath(value: string): string | null {
  const raw = value.split('\t', 1)[0]!.trim();
  if (raw === '/dev/null') return null;
  if (!raw || raw.startsWith('"')) throw new Error(`暂不支持带引号的 patch 路径：${raw}`);
  return raw.replace(/^[ab]\//, '');
}

function parseUnifiedPatch(patch: string): ParsedFilePatch[] {
  if (!patch.trim()) throw new Error('patch 不能为空');
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const files: ParsedFilePatch[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index]!.startsWith('--- ')) {
      index += 1;
      continue;
    }
    const oldPath = patchPath(lines[index]!.slice(4));
    index += 1;
    if (!lines[index]?.startsWith('+++ ')) throw new Error('patch 的 --- 文件头后必须紧跟 +++ 文件头');
    const newPath = patchPath(lines[index]!.slice(4));
    index += 1;
    const hunks: PatchHunk[] = [];
    while (index < lines.length && !lines[index]!.startsWith('--- ')) {
      const header = lines[index]!.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u);
      if (!header) {
        index += 1;
        continue;
      }
      const hunk: PatchHunk = {
        oldStart: Number(header[1]),
        oldCount: Number(header[2] ?? '1'),
        newStart: Number(header[3]),
        newCount: Number(header[4] ?? '1'),
        lines: [],
      };
      index += 1;
      let oldLines = 0;
      let newLines = 0;
      while (index < lines.length && (oldLines < hunk.oldCount || newLines < hunk.newCount)) {
        const line = lines[index]!;
        if (line === '\\ No newline at end of file') {
          index += 1;
          continue;
        }
        const marker = line[0] ?? '';
        if (![' ', '+', '-'].includes(marker)) break;
        hunk.lines.push(line);
        if (marker !== '+') oldLines += 1;
        if (marker !== '-') newLines += 1;
        index += 1;
      }
      if (oldLines !== hunk.oldCount || newLines !== hunk.newCount) {
        throw new Error(`patch hunk 行数不匹配：期望 -${hunk.oldCount}/+${hunk.newCount}，实际 -${oldLines}/+${newLines}`);
      }
      hunks.push(hunk);
    }
    if (!hunks.length) throw new Error(`patch 文件 ${newPath ?? oldPath ?? 'unknown'} 没有 hunk`);
    if (newPath === null) throw new Error('apply_patch 暂不支持删除文件');
    if (oldPath !== null && oldPath !== newPath) throw new Error('apply_patch 暂不支持重命名文件，请使用 move_file');
    files.push({ oldPath, newPath, hunks });
  }
  if (!files.length) throw new Error('未找到有效的 unified diff 文件头');
  const paths = files.map((file) => file.newPath!);
  if (new Set(paths).size !== paths.length) throw new Error('同一文件不能在一个 patch 中重复出现');
  return files;
}

function textLines(content: string): { lines: string[]; finalNewline: boolean } {
  if (!content) return { lines: [], finalNewline: false };
  const finalNewline = content.endsWith('\n');
  const body = finalNewline ? content.slice(0, -1) : content;
  return { lines: body.split(/\r?\n/), finalNewline };
}

function applyHunks(content: string, file: ParsedFilePatch): string {
  const original = textLines(content);
  const next: string[] = [];
  let cursor = 0;
  for (const hunk of file.hunks) {
    const target = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (target < cursor || target > original.lines.length) throw new Error(`patch hunk 起始行无效：${hunk.oldStart}`);
    next.push(...original.lines.slice(cursor, target));
    cursor = target;
    for (const line of hunk.lines) {
      const marker = line[0]!;
      const value = line.slice(1);
      if (marker === '+') {
        next.push(value);
        continue;
      }
      if (original.lines[cursor] !== value) {
        throw new Error(`patch 上下文不匹配：第 ${cursor + 1} 行期望 ${JSON.stringify(value)}`);
      }
      if (marker === ' ') next.push(value);
      cursor += 1;
    }
  }
  next.push(...original.lines.slice(cursor));
  const joined = next.join('\n');
  return joined && (original.finalNewline || file.oldPath === null) ? `${joined}\n` : joined;
}

export async function applyLocalPatch(
  workspaceRoot: string,
  patch: string,
  expectedFiles: Array<{ path: string; sha256: string }> = [],
  validate?: (target: string) => Promise<void>,
): Promise<{ files: PatchFileResult[] }> {
  const parsed = parseUnifiedPatch(patch);
  const targets = parsed.map((file) => resolvePath(workspaceRoot, file.newPath!));
  const expected = new Map(expectedFiles.map((item) => [resolvePath(workspaceRoot, item.path), item.sha256.toLowerCase()]));
  return withMutationLocks(targets, async () => {
    const prepared: Array<{ target: string; content: string; result: PatchFileResult }> = [];
    for (let index = 0; index < parsed.length; index += 1) {
      const file = parsed[index]!;
      const target = await canonicalPotentialPath(targets[index]!);
      await validate?.(target);
      let original = '';
      let originalBuffer: Buffer | undefined;
      try {
        originalBuffer = await readFile(target);
        original = originalBuffer.toString('utf8');
        if (file.oldPath === null) throw new Error(`创建目标已存在：${file.newPath}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (file.oldPath !== null) throw new Error(`patch 目标不存在：${file.oldPath}`);
      }
      const oldSha256 = originalBuffer
        ? createHash('sha256').update(originalBuffer).digest('hex')
        : undefined;
      const expectedSha256 = expected.get(targets[index]!);
      if (expectedSha256 && oldSha256 !== expectedSha256) {
        throw new Error(`文件已变化，拒绝应用过期 patch：${file.newPath}`);
      }
      const content = applyHunks(original, file);
      const additions = file.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line[0] === '+').length, 0);
      const deletions = file.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line[0] === '-').length, 0);
      prepared.push({
        target,
        content,
        result: {
          path: file.newPath!,
          created: file.oldPath === null,
          additions,
          deletions,
          ...(oldSha256 ? { oldSha256 } : {}),
          newSha256: createHash('sha256').update(content).digest('hex'),
        },
      });
    }
    for (const item of prepared) await atomicWrite(item.target, item.content);
    return { files: prepared.map((item) => item.result) };
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
  context?: Array<{ line: number; text: string }>;
  match: 'path' | 'content';
}

export interface FileSearchLimits {
  maxScannedEntries?: number;
  maxDepth?: number;
  maxReadBytes?: number;
  regex?: boolean;
  caseSensitive?: boolean;
  globs?: string[];
  contextLines?: number;
  excludedPaths?: string[];
  pathsOnly?: boolean;
}

function globPattern(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*' && pattern[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
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
  const flags = limits.caseSensitive ? 'u' : 'iu';
  const matcher = limits.regex
    ? new RegExp(query, flags)
    : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  const globs = limits.globs?.map(globPattern) ?? [];
  const contextLines = limits.contextLines ?? 0;
  const excludedRoots = (limits.excludedPaths ?? []).map((value) => resolvePath(workspaceRoot, value));
  const results: FileSearchMatch[] = [];
  const maxScannedEntries = limits.maxScannedEntries ?? 10_000;
  const maxDepth = limits.maxDepth ?? 64;
  const maxReadBytes = limits.maxReadBytes ?? 20_000_000;
  let scannedEntries = 0;
  let readBytes = 0;

  const visit = async (target: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (results.length >= maxResults) return;
    if (excludedRoots.some((excluded) => containsPath(excluded, target))) return;
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
    if (!info.isFile()) return;
    const relativePath = path.relative(workspaceRoot, target).split(path.sep).join('/');
    if (globs.length && !globs.some((glob) => glob.test(relativePath))) return;
    if (matcher.test(relativePath)) {
      results.push({ path: relativePath, match: 'path' });
      if (results.length >= maxResults) return;
    }
    if (limits.pathsOnly || info.size > MAX_TEXT_BYTES) return;
    readBytes += info.size;
    if (readBytes > maxReadBytes) throw new Error(`文件搜索读取总量超过 ${maxReadBytes} 字节`);
    let content: string;
    try {
      content = await readFile(target, 'utf8');
    } catch {
      return;
    }
    if (content.includes('\0')) return;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!matcher.test(lines[index]!)) continue;
      const contextStart = Math.max(0, index - contextLines);
      const contextEnd = Math.min(lines.length, index + contextLines + 1);
      results.push({
        path: relativePath,
        line: index + 1,
        text: truncate(lines[index]!.trim(), 240),
        ...(contextLines ? {
          context: lines.slice(contextStart, contextEnd).map((line, contextIndex) => ({
            line: contextStart + contextIndex + 1,
            text: truncate(line, 240),
          })),
        } : {}),
        match: 'content',
      });
      if (results.length >= maxResults) break;
    }
  };

  await visit(root, 0);
  return results;
}

interface DirectCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  missing?: boolean;
}

async function runDirectCommand(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  maxBytes = 5_000_000,
): Promise<DirectCommandResult> {
  signal?.throwIfAborted();
  return new Promise((resolve) => {
    const allowedEnvironment = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SystemRoot', 'ComSpec', 'PATHEXT'];
    const environment = Object.fromEntries(allowedEnvironment
      .map((name) => [name, process.env[name]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined));
    const child = spawn(command, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (result: DirectCommandResult): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = (): void => {
      child.kill('SIGTERM');
      finish({
        exitCode: 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: signal?.reason instanceof Error ? signal.reason.message : String(signal?.reason ?? '命令已取消'),
      });
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBytes) stdout.push(chunk);
      else child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBytes) stderr.push(chunk);
      else child.kill('SIGTERM');
    });
    child.once('error', (error) => finish({
      exitCode: 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: error.message,
      ...((error as NodeJS.ErrnoException).code === 'ENOENT' ? { missing: true } : {}),
    }));
    child.once('close', (code) => finish({
      exitCode: code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: [Buffer.concat(stderr).toString('utf8'), stdoutBytes > maxBytes || stderrBytes > maxBytes
        ? `输出超过 ${maxBytes} 字节限制`
        : ''].filter(Boolean).join('\n'),
    }));
  });
}

function ripgrepBaseArgs(workspaceRoot: string, options: FileSearchLimits): string[] {
  const args = [
    '--hidden', '--max-filesize', '200K',
    '--glob', '!.git/**',
    '--glob', '!.mimi-agent/**',
    '--glob', `!${PRE_MIMI_DATA_DIRECTORY}/**`,
    '--glob', '!node_modules/**',
    '--glob', '!dist/**',
  ];
  for (const excludedPath of options.excludedPaths ?? []) {
    const relative = path.relative(workspaceRoot, resolvePath(workspaceRoot, excludedPath)).split(path.sep).join('/');
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    args.push('--glob', `!${relative}`, '--glob', `!${relative}/**`);
  }
  for (const glob of options.globs ?? []) args.push('--glob', glob);
  return args;
}

function isExcludedSearchPath(workspaceRoot: string, relativePath: string, options: FileSearchLimits): boolean {
  const target = resolvePath(workspaceRoot, relativePath);
  return (options.excludedPaths ?? [])
    .some((excludedPath) => containsPath(resolvePath(workspaceRoot, excludedPath), target));
}

export async function searchWorkspaceFiles(
  workspaceRoot: string,
  query: string,
  requestedPath = '.',
  maxResults = 50,
  signal?: AbortSignal,
  options: FileSearchLimits = {},
): Promise<FileSearchMatch[]> {
  const target = resolvePath(workspaceRoot, requestedPath);
  const expressionFlags = options.caseSensitive ? 'u' : 'iu';
  const expression = options.regex
    ? new RegExp(query, expressionFlags)
    : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), expressionFlags);
  const baseArgs = ripgrepBaseArgs(workspaceRoot, options);
  const [fileResult, contentResult] = await Promise.all([
    runDirectCommand('rg', [...baseArgs, '--files', target], workspaceRoot, signal),
    options.pathsOnly ? Promise.resolve<DirectCommandResult>({ exitCode: 1, stdout: '', stderr: '' }) : runDirectCommand('rg', [
      ...baseArgs,
      '--json', '--line-number',
      ...(options.caseSensitive ? [] : ['--ignore-case']),
      ...(options.regex ? [] : ['--fixed-strings']),
      ...(options.contextLines ? ['--context', String(options.contextLines)] : []),
      '--', query, target,
    ], workspaceRoot, signal, 20_000_000),
  ]);
  if (fileResult.missing || contentResult.missing) {
    return searchLocalFiles(workspaceRoot, query, requestedPath, maxResults, signal, options);
  }
  if (![0, 1].includes(fileResult.exitCode) || ![0, 1].includes(contentResult.exitCode)) {
    throw new Error(`ripgrep 搜索失败：${contentResult.stderr || fileResult.stderr}`);
  }
  const results: FileSearchMatch[] = [];
  for (const file of fileResult.stdout.split(/\r?\n/).filter(Boolean)) {
    const relative = path.relative(workspaceRoot, path.resolve(workspaceRoot, file)).split(path.sep).join('/');
    if (isExcludedSearchPath(workspaceRoot, relative, options)) continue;
    if (!expression.test(relative)) continue;
    results.push({ path: relative, match: 'path' });
    if (results.length >= maxResults) return results;
  }
  if (options.pathsOnly) return results;
  const contentLines = new Map<string, Map<number, string>>();
  const contentMatches: Array<{ path: string; line: number; text: string }> = [];
  for (const line of contentResult.stdout.split(/\r?\n/).filter(Boolean)) {
    let event: {
      type?: string;
      data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
    };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (!['match', 'context'].includes(event.type ?? '') || !event.data?.path?.text || !event.data.line_number) continue;
    const relative = path.relative(workspaceRoot, path.resolve(workspaceRoot, event.data.path.text)).split(path.sep).join('/');
    if (isExcludedSearchPath(workspaceRoot, relative, options)) continue;
    const text = truncate((event.data.lines?.text ?? '').replace(/\r?\n$/, ''), 240);
    const fileLines = contentLines.get(relative) ?? new Map<number, string>();
    fileLines.set(event.data.line_number, text);
    contentLines.set(relative, fileLines);
    if (event.type === 'match') contentMatches.push({ path: relative, line: event.data.line_number, text });
  }
  const contextLines = options.contextLines ?? 0;
  for (const match of contentMatches) {
    const fileLines = contentLines.get(match.path) ?? new Map<number, string>();
    results.push({
      path: match.path,
      line: match.line,
      text: match.text,
      ...(contextLines ? {
        context: Array.from({ length: contextLines * 2 + 1 }, (_, index) => match.line - contextLines + index)
          .filter((lineNumber) => fileLines.has(lineNumber))
          .map((lineNumber) => ({ line: lineNumber, text: fileLines.get(lineNumber)! })),
      } : {}),
      match: 'content',
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

export interface WorkspaceChanges {
  git: boolean;
  status: string;
  diffStat: string;
  diff?: string;
  truncated: boolean;
}

export async function inspectWorkspaceChanges(
  workspaceRoot: string,
  paths: string[] = [],
  includeDiff = true,
  signal?: AbortSignal,
  excludedPaths: string[] = [],
): Promise<WorkspaceChanges> {
  const exclusions = [...new Set([
    '.mimi-agent', PRE_MIMI_DATA_DIRECTORY, ...excludedPaths,
  ].map((value) => value.split(path.sep).join('/')).filter((value) => value && value !== '.'))];
  const pathspec = [
    '--', ...(paths.length ? paths : ['.']),
    ...exclusions.flatMap((value) => [`:(exclude)${value}`, `:(exclude)${value}/**`]),
  ];
  const status = await runDirectCommand(
    'git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--short', '--untracked-files=all', ...pathspec], workspaceRoot, signal, MAX_TEXT_BYTES,
  );
  if (status.missing || (status.exitCode !== 0 && /not a git repository/iu.test(status.stderr))) {
    return { git: false, status: '', diffStat: '', truncated: false };
  }
  if (status.exitCode !== 0) throw new Error(`git status 失败：${status.stderr}`);
  const [unstagedStat, stagedStat, unstagedDiff, stagedDiff] = await Promise.all([
    runDirectCommand('git', ['diff', '--no-ext-diff', '--no-textconv', '--stat', ...pathspec], workspaceRoot, signal, MAX_TEXT_BYTES),
    runDirectCommand('git', ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--stat', ...pathspec], workspaceRoot, signal, MAX_TEXT_BYTES),
    includeDiff
      ? runDirectCommand('git', ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', ...pathspec], workspaceRoot, signal, MAX_TEXT_BYTES)
      : Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    includeDiff
      ? runDirectCommand('git', ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--unified=3', ...pathspec], workspaceRoot, signal, MAX_TEXT_BYTES)
      : Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
  ]);
  const commands = [unstagedStat, stagedStat, unstagedDiff, stagedDiff];
  const failed = commands.find((result) => result.exitCode !== 0);
  if (failed) throw new Error(`git diff 失败：${failed.stderr}`);
  const diff = [unstagedDiff.stdout, stagedDiff.stdout].filter(Boolean).join('\n');
  return {
    git: true,
    status: truncate(status.stdout, MAX_TEXT_BYTES),
    diffStat: truncate([unstagedStat.stdout, stagedStat.stdout].filter(Boolean).join('\n'), MAX_TEXT_BYTES),
    ...(includeDiff ? { diff: truncate(diff, MAX_TEXT_BYTES) } : {}),
    truncated: [status, ...commands].some((result) => /输出超过/u.test(result.stderr)),
  };
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
  allowPrivateNetwork = false,
) {
  let target = new URL(url);
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutSeconds * 1_000)])
    : AbortSignal.timeout(timeoutSeconds * 1_000);
  let requestMethod = method;
  let requestBody = body;
  let requestHeaders = { ...headers };
  const dispatcher = allowPrivateNetwork ? undefined : new HttpAgent({
    connect: { lookup: guardedPublicLookup },
  });
  try {
    for (let redirects = 0; redirects <= MAX_HTTP_REDIRECTS; redirects += 1) {
      await assertPublicHttpTarget(target, allowPrivateNetwork);
      const response = await fetch(target, {
        method: requestMethod,
        headers: requestHeaders,
        body: requestMethod === 'GET' || requestMethod === 'HEAD' ? undefined : requestBody,
        signal: requestSignal,
        redirect: 'manual',
        ...(dispatcher ? { dispatcher } : {}),
      });
      const location = response.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
        return {
          status: response.status,
          ok: response.ok,
          headers: Object.fromEntries(response.headers),
          body: await readBoundedResponse(response as unknown as Response, requestSignal),
        };
      }
      if (redirects === MAX_HTTP_REDIRECTS) throw new Error(`HTTP 重定向超过 ${MAX_HTTP_REDIRECTS} 次限制`);
      await response.body?.cancel();
      const next = new URL(location, target);
      if (target.protocol === 'https:' && next.protocol === 'http:') {
        throw new Error('HTTP 重定向不允许从 HTTPS 降级到 HTTP');
      }
      if (next.origin !== target.origin) {
        if (!['GET', 'HEAD'].includes(requestMethod.toUpperCase()) || requestBody !== undefined) {
          throw new Error('HTTP 工具拒绝跨源重定向写请求或请求正文');
        }
        requestHeaders = Object.fromEntries(Object.entries(requestHeaders).filter(([name]) => (
          ['accept', 'accept-language'].includes(name.toLowerCase())
        )));
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestMethod === 'POST')) {
        requestMethod = 'GET';
        requestBody = undefined;
        for (const name of Object.keys(requestHeaders)) {
          if (['content-length', 'content-type', 'transfer-encoding'].includes(name.toLowerCase())) {
            delete requestHeaders[name];
          }
        }
      }
      target = next;
    }
    throw new Error('HTTP 请求未能完成');
  } finally {
    await dispatcher?.close();
  }
}

const guardedPublicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error, '', 0);
      return;
    }
    const selected = addresses.find(({ address }) => isPublicAddress(address));
    if (!selected || addresses.some(({ address }) => !isPublicAddress(address))) {
      const denied = Object.assign(new Error('DNS 解析包含非公网地址，HTTP 请求已拒绝'), { code: 'EACCES' });
      callback(denied, '', 0);
      return;
    }
    callback(null, selected.address, selected.family);
  });
};

async function assertPublicHttpTarget(target: URL, allowPrivateNetwork: boolean): Promise<void> {
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('只支持 HTTP 和 HTTPS URL');
  if (target.username || target.password) throw new Error('HTTP URL 不允许包含用户名或密码');
  if (allowPrivateNetwork) return;
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('HTTP 工具只允许访问公网地址；loopback、内网、link-local 和 metadata 地址已拒绝');
  }
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number);
    const [a = 0, b = 0] = parts;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19)));
  }
  if (isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  const groups = expandIpv6(normalized);
  if (!groups) return false;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return isPublicAddress(`${groups[6]! >>> 8}.${groups[6]! & 0xff}.${groups[7]! >>> 8}.${groups[7]! & 0xff}`);
  }
  return normalized !== '::' && normalized !== '::1'
    && !normalized.startsWith('fc') && !normalized.startsWith('fd')
    && !normalized.startsWith('fe8') && !normalized.startsWith('fe9')
    && !normalized.startsWith('fea') && !normalized.startsWith('feb')
    && !normalized.startsWith('ff');
}

function expandIpv6(address: string): number[] | undefined {
  let normalized = address;
  const dotted = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const bytes = dotted.split('.').map(Number);
    if (bytes.length !== 4 || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return undefined;
    normalized = `${normalized.slice(0, -dotted.length)}${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (zeros < 0 || (halves.length === 1 && left.length !== 8)) return undefined;
  const values = [...left, ...Array.from({ length: zeros }, () => '0'), ...right]
    .map((group) => Number.parseInt(group, 16));
  return values.length === 8 && values.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffff)
    ? values
    : undefined;
}

export async function runShellCommand(
  workspaceRoot: string,
  command: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
  protectedPaths: string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
  detachedProcessGroup = process.platform !== 'win32',
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (/(?:^|[;&|()\s])(?:nohup|disown|setsid)(?:$|[;&|()\s])/u.test(command)
    || /(^|[^&])&(?!&)(?:\s*(?:#.*)?)$/u.test(command)
    || /(^|[^&])&(?!&)[\s;]+disown(?:\s|;|$)/u.test(command)) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'run_shell 不允许创建脱离 MimiAgent 管理的后台进程；请使用 delegate_background_task 提交可跟踪的后台任务',
    };
  }
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
      detached: process.platform !== 'win32' && detachedProcessGroup,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const finish = (): void => {
      if (settled || !closed || !killFinished) return;
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

    const kill = (force = false): boolean => {
      if (!child.pid) return false;
      const signalName = force ? 'SIGKILL' : 'SIGTERM';
      try {
        if (process.platform === 'win32' || !detachedProcessGroup) child.kill(signalName);
        else process.kill(-child.pid, signalName);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          child.kill(signalName);
          return true;
        }
        return false;
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
      if (!terminating && process.platform !== 'win32' && detachedProcessGroup && kill(false)) {
        // A successful shell may still have background descendants in its
        // process group. The Run owns that group until every descendant exits.
        hardKillTimer = setTimeout(() => {
          kill(true);
          killFinished = true;
          finish();
        }, 150);
      } else if (!terminating) {
        killFinished = true;
      }
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
    description: '读取本机 UTF-8 文本文件；大型文件优先指定 startLine/endLine 分段读取。指定行范围或 includeMetadata 时返回行范围、总行数和 SHA-256。',
    parameters: z.object({
      path: z.string().min(1),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
      maxLines: z.number().int().min(1).max(2_000).optional(),
      includeMetadata: z.boolean().default(false),
    }),
    execute: async ({ path: requestedPath, startLine, endLine, maxLines, includeMetadata }, _context, details) => {
      const target = resolvePath(workspaceRoot, requestedPath);
      await Promise.all([
        assertPathAllowed(target, protectedPaths),
        assertReadablePath(workspaceRoot, target, access.readablePaths),
      ]);
      if (!includeMetadata && startLine === undefined && endLine === undefined && maxLines === undefined) {
        return readLocalFile(workspaceRoot, requestedPath, details?.signal);
      }
      return readLocalFileView(workspaceRoot, requestedPath, { startLine, endLine, maxLines }, details?.signal);
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

  const applyPatch = tool({
    name: 'apply_patch',
    description: '应用一个或多个文件的 unified diff。所有 hunk 会先校验；可用读取结果的 SHA-256 拒绝覆盖并发变化。当前不处理删除；重命名使用 move_file。',
    parameters: z.object({
      patch: z.string().min(1),
      expectedFiles: z.array(z.object({
        path: z.string().min(1),
        sha256: z.string().regex(/^[a-fA-F0-9]{64}$/u),
      })).max(100).default([]),
    }),
    execute: async ({ patch, expectedFiles }) => applyLocalPatch(
      workspaceRoot,
      patch,
      expectedFiles,
      async (target) => Promise.all([
        assertPathAllowed(target, protectedPaths),
        assertWritablePath(workspaceRoot, target, access.writablePaths ?? ['.']),
      ]).then(() => undefined),
    ),
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
    description: '列出本机目录；可用 depth 有界递归，并用 globs 筛选相对路径。默认只列一层。',
    parameters: z.object({
      path: z.string().default('.'),
      includeHidden: z.boolean().default(false),
      depth: z.number().int().min(1).max(8).default(1),
      maxEntries: z.number().int().min(1).max(2_000).default(200),
      globs: z.array(z.string().min(1).max(200)).max(20).default([]),
    }),
    execute: async ({ path: requestedPath, includeHidden, depth, maxEntries, globs }, _context, details) => {
      const target = resolvePath(workspaceRoot, requestedPath);
      await Promise.all([
        assertPathAllowed(target, protectedPaths),
        assertReadablePath(workspaceRoot, target, access.readablePaths),
      ]);
      const matchers = globs.map(globPattern);
      const results: Array<{ name: string; type: 'directory' | 'symlink' | 'file' }> = [];
      const visit = async (directory: string, currentDepth: number): Promise<void> => {
        details?.signal?.throwIfAborted();
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (results.length >= maxEntries) return;
          if (!includeHidden && entry.name.startsWith('.')) continue;
          const entryPath = path.join(directory, entry.name);
          if (protectedPaths.some((protectedPath) => containsPath(resolvePath(workspaceRoot, protectedPath), entryPath))) continue;
          const name = path.relative(target, entryPath).split(path.sep).join('/');
          const type = entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file';
          if (!matchers.length || matchers.some((matcher) => matcher.test(name))) results.push({ name, type });
          if (entry.isDirectory() && currentDepth < depth && !SKIPPED_DIRECTORIES.has(entry.name)) {
            await visit(entryPath, currentDepth + 1);
          }
        }
      };
      await visit(target, 1);
      if (depth === 1 && maxEntries === 200 && !globs.length) return results;
      return { entries: results, truncated: results.length >= maxEntries };
    },
  });

  const searchFiles = tool({
    name: 'search_files',
    description: '使用 ripgrep（不可用时自动回退）搜索文件名和文本；pathsOnly 可只列匹配路径且不读取文件内容。',
    parameters: z.object({
      query: z.string().default(''),
      path: z.string().default('.'),
      regex: z.boolean().default(false),
      caseSensitive: z.boolean().default(false),
      globs: z.array(z.string().min(1).max(200)).max(20).default([]),
      contextLines: z.number().int().min(0).max(10).default(0),
      pathsOnly: z.boolean().default(false),
      maxResults: z.number().int().min(1).max(200).default(50),
    }),
    execute: async ({ query, path: requestedPath, regex, caseSensitive, globs, contextLines, pathsOnly, maxResults }, _context, details) => {
      if (!pathsOnly && !query) throw new Error('搜索文件内容时 query 不能为空');
      const target = resolvePath(workspaceRoot, requestedPath);
      await Promise.all([
        assertPathAllowed(target, protectedPaths),
        assertReadablePath(workspaceRoot, target, access.readablePaths),
      ]);
      return searchWorkspaceFiles(workspaceRoot, query, requestedPath, maxResults, details?.signal, {
        regex, caseSensitive, globs, contextLines, pathsOnly, excludedPaths: protectedPaths,
      });
    },
  });

  const inspectChanges = tool({
    name: 'inspect_changes',
    description: '只读检查当前 Git 工作区的 status、diffstat 和有界 diff；文件修改后用它复核最终结果和已有用户改动。',
    parameters: z.object({
      paths: z.array(z.string().min(1).max(500)).max(100).default([]),
      includeDiff: z.boolean().default(true),
    }),
    execute: async ({ paths, includeDiff }, _context, details) => {
      const relativePaths = await Promise.all(paths.map(async (requestedPath) => {
        const target = resolvePath(workspaceRoot, requestedPath);
        await Promise.all([
          assertPathAllowed(target, protectedPaths),
          assertReadablePath(workspaceRoot, target, access.readablePaths),
        ]);
        return path.relative(workspaceRoot, target);
      }));
      const excludedPaths = protectedPaths
        .map((protectedPath) => path.relative(workspaceRoot, protectedPath))
        .filter((relative) => relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      return inspectWorkspaceChanges(workspaceRoot, relativePaths, includeDiff, details?.signal, excludedPaths);
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
        access.shellEnvironment,
        access.shellDetachedProcessGroup,
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

  const httpHeaders = z.array(z.object({
    name: z.string().min(1),
    value: z.string(),
  })).max(50).default([]);

  const httpRequest = tool({
    name: 'http_request',
    description: '发送 HTTP/HTTPS 请求并返回状态、响应头和正文；headers 使用 name/value 数组。',
    parameters: z.object({
      url: z.string().min(1),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
      headers: httpHeaders,
      body: z.string().nullable().default(null),
      timeoutSeconds: z.number().int().min(1).max(120).default(30),
    }),
    execute: async ({ url, method, headers, body, timeoutSeconds }, _context, details) =>
      requestUrl(
        url,
        method,
        Object.fromEntries(headers.map((header) => [header.name, header.value])),
        body ?? undefined,
        timeoutSeconds,
        details?.signal,
      ),
  });

  const httpGet = tool({
    name: 'http_get',
    description: '以只读 GET 请求读取 HTTP/HTTPS 资源；headers 使用 name/value 数组。',
    parameters: z.object({
      url: z.string().min(1),
      headers: httpHeaders,
      timeoutSeconds: z.number().int().min(1).max(120).default(30),
    }),
    execute: async ({ url, headers, timeoutSeconds }, _context, details) =>
      requestUrl(
        url,
        'GET',
        Object.fromEntries(headers.map((header) => [header.name, header.value])),
        undefined,
        timeoutSeconds,
        details?.signal,
      ),
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
    ...(access.allowWrite === false ? [] : [writeFileTool, editFile, applyPatch, moveFile]),
    listDirectory,
    searchFiles,
    inspectChanges,
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
