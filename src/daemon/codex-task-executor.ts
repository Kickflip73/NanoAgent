import { spawn } from 'node:child_process';
import { accessSync, constants, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export interface CodexTaskRequest {
  objective: string;
  successCriteria?: string;
  context?: string;
  workspaceRoot: string;
  workspaceAccess: 'read' | 'write';
  threadId?: string;
  outputJsonlPath?: string;
  signal?: AbortSignal;
  onStarted?: (pid: number) => void;
  onProgress?: (event: Record<string, unknown>) => void;
}

export interface CodexTaskResult {
  threadId?: string;
  answer: string;
  usage?: unknown;
  exitCode: number;
}

export function resolveCodexExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  const configured = environment.MIMI_CODEX_PATH?.trim();
  if (configured) return configured;
  const pathCandidates = (environment.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, platform === 'win32' ? 'codex.exe' : 'codex'));
  const commonCandidates = platform === 'darwin'
    ? [
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        path.join(os.homedir(), '.local/bin/codex'),
        '/Applications/ChatGPT.app/Contents/Resources/codex',
      ]
    : platform === 'win32'
      ? []
      : ['/usr/local/bin/codex', path.join(os.homedir(), '.local/bin/codex')];
  for (const candidate of [...pathCandidates, ...commonCandidates]) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through known installation locations before preserving the
      // original PATH-based behavior and its useful ENOENT diagnostic.
    }
  }
  return 'codex';
}

export function codexExecutionEnvironment(
  executable: string,
  source: NodeJS.ProcessEnv = process.env,
  nodeExecutable = process.execPath,
): NodeJS.ProcessEnv {
  const inheritedPath = source.PATH ?? '';
  const entries = [
    path.dirname(nodeExecutable),
    ...(path.isAbsolute(executable) ? [path.dirname(executable)] : []),
    ...inheritedPath.split(path.delimiter).filter(Boolean),
  ];
  return {
    ...source,
    PATH: [...new Set(entries)].join(path.delimiter),
  };
}

function prompt(request: CodexTaskRequest): string {
  return [
    '你是 MimiAgent 的可选后台执行器。请在指定工作区自主完成任务。',
    `目标：${request.objective}`,
    request.successCriteria ? `验收标准：${request.successCriteria}` : '',
    request.context ? `必要上下文：${request.context}` : '',
    '完成前运行与改动相称的验证。最终答复简洁列出实际改动、验证结果、未满足条件和需要用户操作的阻塞；不要把自我声明当作验收证据。',
  ].filter(Boolean).join('\n\n');
}

export class CodexCliTaskExecutor {
  private readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(
    executable?: string,
    environment: NodeJS.ProcessEnv = process.env,
    nodeExecutable = process.execPath,
  ) {
    this.executable = executable ?? resolveCodexExecutable(environment);
    this.environment = codexExecutionEnvironment(this.executable, environment, nodeExecutable);
  }

  execute(request: CodexTaskRequest): Promise<CodexTaskResult> {
    request.signal?.throwIfAborted();
    const args = request.threadId
      ? ['exec', 'resume', request.threadId, '--json', prompt(request)]
      : [
          'exec', '--json', '-C', request.workspaceRoot,
          '--sandbox', request.workspaceAccess === 'read' ? 'read-only' : 'workspace-write',
          prompt(request),
        ];
    return new Promise<CodexTaskResult>((resolve, reject) => {
      const child = spawn(this.executable, args, {
        cwd: request.workspaceRoot,
        env: this.environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      const lines = readline.createInterface({ input: child.stdout });
      const output = request.outputJsonlPath
        ? createWriteStream(request.outputJsonlPath, { flags: 'a', mode: 0o600 })
        : undefined;
      let outputError: Error | undefined;
      output?.once('error', (error) => { outputError = error; });
      let threadId: string | undefined;
      let answer = '';
      let usage: unknown;
      let stderr = '';
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      const terminate = () => {
        if (!child.pid) return;
        try {
          if (process.platform === 'win32') child.kill('SIGTERM');
          else process.kill(-child.pid, 'SIGTERM');
        } catch {
          // The process may have reached a terminal state concurrently.
        }
        killTimer = setTimeout(() => {
          try {
            if (process.platform === 'win32') child.kill('SIGKILL');
            else if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch {
            // The process group may already have exited.
          }
        }, 5_000);
        killTimer.unref();
      };
      const onAbort = () => terminate();
      request.signal?.addEventListener('abort', onAbort, { once: true });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < 64_000) stderr += chunk.slice(0, 64_000 - stderr.length);
      });
      lines.on('line', (line) => {
        if (Buffer.byteLength(line, 'utf8') > 1024 * 1024) return;
        output?.write(`${line}\n`);
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          request.onProgress?.(event);
          if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
            threadId = event.thread_id;
          }
          if (event.type === 'item.completed') {
            const item = event.item && typeof event.item === 'object'
              ? event.item as Record<string, unknown>
              : undefined;
            if (item?.type === 'agent_message' && typeof item.text === 'string') answer = item.text;
          }
          if (event.type === 'turn.completed') usage = event.usage;
        } catch {
          // `--json` should be JSONL; ignore one malformed diagnostic line and
          // let the process exit status remain authoritative.
        }
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        request.signal?.removeEventListener('abort', onAbort);
        output?.end();
        const wrapped = new Error(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? `Codex CLI 不可用：${this.executable}`
            : `Codex CLI 启动失败：${error.message}`,
          { cause: error },
        ) as NodeJS.ErrnoException;
        wrapped.code = (error as NodeJS.ErrnoException).code;
        reject(wrapped);
      });
      child.once('close', async (code, signal) => {
        if (settled) {
          if (killTimer) clearTimeout(killTimer);
          return;
        }
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        request.signal?.removeEventListener('abort', onAbort);
        if (output) await new Promise<void>((done) => output.end(done));
        if (request.signal?.aborted) {
          reject(request.signal.reason ?? new Error('Codex 后台任务已取消'));
          return;
        }
        if (code !== 0) {
          reject(new Error(`Codex CLI 执行失败（code=${code ?? 'null'}, signal=${signal ?? 'none'}）：${stderr.trim()}`));
          return;
        }
        if (outputError) {
          reject(new Error(`无法持久化 Codex JSONL 输出：${outputError.message}`, { cause: outputError }));
          return;
        }
        resolve({ threadId, answer: answer.trim(), usage, exitCode: code });
      });
      if (child.pid) {
        try {
          request.onStarted?.(child.pid);
        } catch (error) {
          settled = true;
          terminate();
          output?.end();
          request.signal?.removeEventListener('abort', onAbort);
          reject(error);
        }
      }
    });
  }
}
