import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { codeInterpreterTool, tool, webSearchTool } from '@openai/agents';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const MAX_TEXT_BYTES = 200_000;
const MAX_SHELL_OUTPUT = 100_000;
const SKIPPED_DIRECTORIES = new Set(['.git', '.nano-agent', 'node_modules', 'dist']);

function resolvePath(workspaceRoot: string, requestedPath: string): string {
  return path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.resolve(workspaceRoot, requestedPath);
}

function truncate(value: string, limit = MAX_SHELL_OUTPUT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[输出已截断，共 ${value.length} 字符]`;
}

export async function readLocalFile(
  workspaceRoot: string,
  requestedPath: string,
): Promise<string> {
  const content = await readFile(resolvePath(workspaceRoot, requestedPath), 'utf8');
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) {
    throw new Error(`文件超过 ${MAX_TEXT_BYTES} 字节限制，请使用 Shell 分段读取`);
  }
  return content;
}

export async function writeLocalFile(
  workspaceRoot: string,
  requestedPath: string,
  content: string,
): Promise<string> {
  const target = resolvePath(workspaceRoot, requestedPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return `已写入 ${target}（${Buffer.byteLength(content, 'utf8')} 字节）`;
}

export async function editLocalFile(
  workspaceRoot: string,
  requestedPath: string,
  oldText: string,
  newText: string,
  replaceAll = false,
): Promise<{ path: string; replacements: number }> {
  if (!oldText) throw new Error('oldText 不能为空');
  const target = resolvePath(workspaceRoot, requestedPath);
  const content = await readLocalFile(workspaceRoot, requestedPath);
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) throw new Error('未找到要替换的原文');
  const next = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
  await writeFile(target, next, 'utf8');
  return { path: target, replacements: replaceAll ? occurrences : 1 };
}

export async function moveLocalFile(
  workspaceRoot: string,
  sourcePath: string,
  destinationPath: string,
  overwrite = false,
): Promise<{ from: string; to: string }> {
  const source = resolvePath(workspaceRoot, sourcePath);
  const destination = resolvePath(workspaceRoot, destinationPath);
  if (!overwrite) {
    try {
      await stat(destination);
      throw new Error(`目标已存在：${destination}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(source, destination);
  return { from: source, to: destination };
}

export interface FileSearchMatch {
  path: string;
  line?: number;
  text?: string;
  match: 'path' | 'content';
}

export async function searchLocalFiles(
  workspaceRoot: string,
  query: string,
  requestedPath = '.',
  maxResults = 50,
): Promise<FileSearchMatch[]> {
  const root = resolvePath(workspaceRoot, requestedPath);
  const needle = query.toLowerCase();
  const results: FileSearchMatch[] = [];

  const visit = async (target: string): Promise<void> => {
    if (results.length >= maxResults) return;
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
        await visit(path.join(target, entry));
        if (results.length >= maxResults) break;
      }
      return;
    }
    if (!info.isFile() || info.size > MAX_TEXT_BYTES) return;
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

  await visit(root);
  return results;
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
  const response = await fetch(target, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutSeconds * 1_000)])
      : AbortSignal.timeout(timeoutSeconds * 1_000),
  });
  return {
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers),
    body: truncate(await response.text()),
  };
}

export async function runShellCommand(
  workspaceRoot: string,
  command: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('/bin/zsh', ['-lc', command], {
      cwd: workspaceRoot,
      timeout: timeoutSeconds * 1_000,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
      signal,
    });
    return { exitCode: 0, stdout: truncate(stdout), stderr: truncate(stderr) };
  } catch (error) {
    const result = error as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: typeof result.code === 'number' ? result.code : 1,
      stdout: truncate(result.stdout ?? ''),
      stderr: truncate(result.stderr ?? result.message),
    };
  }
}

export function createTools(workspaceRoot: string, includeOpenAIHostedTools = true) {
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
    execute: async ({ path: requestedPath }) =>
      readLocalFile(workspaceRoot, requestedPath),
  });

  const writeFileTool = tool({
    name: 'write_file',
    description: '创建或覆盖本机文本文件，支持绝对路径或相对当前工作区的路径。',
    parameters: z.object({
      path: z.string().min(1),
      content: z.string(),
    }),
    execute: async ({ path: requestedPath, content }) =>
      writeLocalFile(workspaceRoot, requestedPath, content),
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
    execute: async ({ path: requestedPath, oldText, newText, replaceAll }) =>
      editLocalFile(workspaceRoot, requestedPath, oldText, newText, replaceAll),
  });

  const moveFile = tool({
    name: 'move_file',
    description: '移动或重命名文件；默认不覆盖已有目标。',
    parameters: z.object({
      source: z.string().min(1),
      destination: z.string().min(1),
      overwrite: z.boolean().default(false),
    }),
    execute: async ({ source, destination, overwrite }) =>
      moveLocalFile(workspaceRoot, source, destination, overwrite),
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
    execute: async ({ query, path: requestedPath, maxResults }) =>
      searchLocalFiles(workspaceRoot, query, requestedPath, maxResults),
  });

  const shell = tool({
    name: 'run_shell',
    description:
      '在本机 zsh 中执行任意命令。可用于搜索文件、Git、网络请求、安装依赖、运行代码和系统自动化。',
    parameters: z.object({
      command: z.string().min(1),
      timeoutSeconds: z.number().int().min(1).max(300).default(60),
    }),
    execute: async ({ command, timeoutSeconds }, _context, details) =>
      runShellCommand(workspaceRoot, command, timeoutSeconds, details?.signal),
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
    writeFileTool,
    editFile,
    moveFile,
    listDirectory,
    searchFiles,
    shell,
    calculate,
    httpRequest,
  ];

  if (!includeOpenAIHostedTools) return [...localTools, webSearch];
  return [
    ...localTools,
    webSearchTool({ searchContextSize: 'low', externalWebAccess: true }),
    codeInterpreterTool(),
  ];
}
