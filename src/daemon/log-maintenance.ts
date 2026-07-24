import { chmod, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { MimiPaths } from './client-runtime.js';

export const DAEMON_LOG_ROTATION_BYTES = 10 * 1024 * 1024;
export const DAEMON_LOG_ROTATION_FILES = 5;

export interface DaemonLogRotation {
  file: 'stdout' | 'stderr';
  rotated: boolean;
  previousBytes: number;
}

async function renameIfPresent(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function rotateLog(
  file: string,
  label: DaemonLogRotation['file'],
  maximumBytes: number,
  retainedFiles: number,
): Promise<DaemonLogRotation> {
  let previousBytes = 0;
  try {
    const info = await stat(file);
    previousBytes = info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { file: label, rotated: false, previousBytes };
    }
    throw error;
  }
  if (previousBytes < maximumBytes) return { file: label, rotated: false, previousBytes };
  await rm(`${file}.${retainedFiles}`, { force: true });
  for (let index = retainedFiles - 1; index >= 1; index -= 1) {
    await renameIfPresent(`${file}.${index}`, `${file}.${index + 1}`);
  }
  await rename(file, `${file}.1`);
  await writeFile(file, '', { flag: 'wx', mode: 0o600 });
  await chmod(`${file}.1`, 0o600);
  return { file: label, rotated: true, previousBytes };
}

export async function rotateDaemonLogs(
  paths: Pick<MimiPaths, 'stdoutLog' | 'stderrLog'>,
  maximumBytes = DAEMON_LOG_ROTATION_BYTES,
  retainedFiles = DAEMON_LOG_ROTATION_FILES,
): Promise<DaemonLogRotation[]> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error('日志轮转阈值必须是正安全整数');
  }
  if (!Number.isSafeInteger(retainedFiles) || retainedFiles < 1 || retainedFiles > 20) {
    throw new Error('日志保留份数必须是 1 到 20 的安全整数');
  }
  return Promise.all([
    rotateLog(paths.stdoutLog, 'stdout', maximumBytes, retainedFiles),
    rotateLog(paths.stderrLog, 'stderr', maximumBytes, retainedFiles),
  ]);
}
