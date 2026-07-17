export class RunInterruptedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunInterruptedError';
  }
}

/** An owner decision that must not be resumed automatically. */
export class TerminalRunInterruptedError extends RunInterruptedError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TerminalRunInterruptedError';
  }
}

export function assertRunCanComplete(
  result: { cancelled?: boolean; interruptions?: readonly unknown[] },
  signal?: AbortSignal,
): void {
  if (signal?.aborted || result.cancelled) {
    const reason = signal?.reason;
    throw reason instanceof Error
      ? new RunInterruptedError(reason.message, { cause: reason })
      : new RunInterruptedError(String(reason ?? '任务已取消'));
  }
  if (result.interruptions?.length) {
    throw new RunInterruptedError(`任务暂停：有 ${result.interruptions.length} 个工具调用等待审批`);
  }
}

export function isRunInterrupted(error: unknown, signal?: AbortSignal): boolean {
  return error instanceof RunInterruptedError || signal?.aborted === true;
}

export function isTerminalRunInterruption(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof TerminalRunInterruptedError) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}
