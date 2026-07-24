import { isTerminalRunInterruption } from '../runtime/run-outcome.js';

function errorStatus(error: unknown): number | undefined {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  if (typeof value.status === 'number') return value.status;
  const message = error instanceof Error ? error.message : String(error);
  const messageStatus = /^(\d{3})(?:\s|$)/.exec(message)?.[1];
  return messageStatus ? Number(messageStatus) : undefined;
}

function isNonRetryableRunFailure(error: unknown): boolean {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message : String(error);
  return isTerminalRunInterruption(error)
    || value.name === 'ContextProtocolBudgetError'
    || value.name === 'MaxTurnsExceededError'
    || /^Max turns \(\d+\) exceeded$/i.test(message);
}

export function eventFailureAttemptLimit(
  error: unknown,
  claimedAttempts: number,
  configuredMaxAttempts: number,
): number {
  if (isNonRetryableRunFailure(error)) return Math.max(1, claimedAttempts);
  const status = errorStatus(error);
  // Background conversation retries happen within seconds. Retrying a rejected
  // request, exhausted quota, or rate limit only burns attempts/credits and can
  // produce a stale IM reply later; dead-letter once and require an explicit retry.
  if (status !== undefined && status >= 400 && status < 500
    && status !== 408 && status !== 409 && status !== 425) {
    return Math.max(1, claimedAttempts);
  }
  return configuredMaxAttempts;
}
