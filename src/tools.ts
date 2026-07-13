import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { codeInterpreterTool, tool, webSearchTool } from '@openai/agents';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const MAX_TEXT_BYTES = 200_000;
const MAX_SHELL_OUTPUT = 100_000;

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

export async function runShellCommand(
  workspaceRoot: string,
  command: string,
  timeoutSeconds: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('/bin/zsh', ['-lc', command], {
      cwd: workspaceRoot,
      timeout: timeoutSeconds * 1_000,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
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

  const shell = tool({
    name: 'run_shell',
    description:
      '在本机 zsh 中执行任意命令。可用于搜索文件、Git、网络请求、安装依赖、运行代码和系统自动化。',
    parameters: z.object({
      command: z.string().min(1),
      timeoutSeconds: z.number().int().min(1).max(300).default(60),
    }),
    execute: async ({ command, timeoutSeconds }) =>
      runShellCommand(workspaceRoot, command, timeoutSeconds),
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

  const localTools = [
    currentTime,
    readFileTool,
    writeFileTool,
    listDirectory,
    shell,
    calculate,
  ];

  if (!includeOpenAIHostedTools) return localTools;
  return [
    ...localTools,
    webSearchTool({ searchContextSize: 'low', externalWebAccess: true }),
    codeInterpreterTool(),
  ];
}
