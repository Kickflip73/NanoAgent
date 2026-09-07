import { spawn } from 'node:child_process';

/** Owns a local command and its process group through completion, timeout and cancellation. */
export function runManagedCommand(command: string, args: readonly string[], options: {
  environment?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string }> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.environment,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const cleanupGroup = (): void => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* process group already gone */ }
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      cleanupGroup();
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    const abort = (): void => finish(options.signal?.reason instanceof Error
      ? options.signal.reason : new Error('Command aborted'));
    const timer = setTimeout(() => finish(new Error(`Command timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const append = (chunks: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { finish(new Error('Command output exceeded 1MiB')); return; }
      chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
    child.once('error', (error) => finish(error));
    child.once('exit', cleanupGroup);
    child.once('close', (code, signal) => finish(code === 0 ? undefined
      : new Error(`Command failed (${code ?? signal}): ${Buffer.concat(stderr).toString('utf8').slice(0, 2_000)}`)));
  });
}
