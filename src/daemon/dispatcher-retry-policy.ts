import { APIConnectionError } from 'openai';
import { isTerminalRunInterruption } from '../runtime/run-outcome.js';
import {
  runFailureDisposition,
  runFailureRecord,
  type RunFailureDisposition,
  type RunFailureRecord,
} from '../runtime/run-failure.js';

function errorStatus(error: unknown): number | undefined {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  return typeof value.status === 'number' ? value.status : undefined;
}

export function classifyRunFailureRecord(error: unknown): RunFailureRecord {
  const typed = runFailureRecord(error);
  if (typed) return typed;
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const gate = value.gate && typeof value.gate === 'object' && !Array.isArray(value.gate)
    ? value.gate as Record<string, unknown>
    : undefined;
  if (value.name === 'CompletionGateError') {
    const uncertain = gate?.decision === 'uncertain';
    return {
      code: uncertain ? 'completion.uncertain' : 'completion.incomplete',
      disposition: {
        phase: 'runtime',
        kind: uncertain ? 'uncertain' : 'validation',
        retryable: false,
        dispatchStarted: uncertain,
      },
    };
  }
  if (isTerminalRunInterruption(error)
    || value.name === 'ContextProtocolBudgetError'
    || value.name === 'MaxTurnsExceededError'
    || value.name === 'EphemeralSecretsExpiredError'
    || value.name === 'EphemeralSensitiveRunFailedError') {
    return { code: `runtime.${String(value.name ?? 'terminal').toLowerCase()}`, disposition: {
      phase: 'runtime', kind: 'terminal', retryable: false, dispatchStarted: false,
    } };
  }
  if (value.name === 'ActionIntentUncertainError') {
    return { code: 'action.uncertain', disposition: {
      phase: 'dispatch', kind: 'uncertain', retryable: false, dispatchStarted: true,
    } };
  }
  const status = errorStatus(error);
  if (status !== undefined) {
    if (status >= 500 || status === 408 || status === 409 || status === 425) {
      return { code: `provider.http_${status}`, disposition: {
        phase: 'provider', kind: 'transient', retryable: true, dispatchStarted: false,
      } };
    }
    if (status >= 400 && status < 500) {
      return { code: `provider.http_${status}`, disposition: {
        phase: 'provider', kind: 'validation', retryable: false, dispatchStarted: false,
      } };
    }
  }
  const code = String(value.code ?? '');
  if (['ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'ETIMEDOUT'].includes(code)
    || ['APIConnectionError', 'APITimeoutError'].includes(String(value.name ?? ''))) {
    return { code: `provider.${code ? code.toLowerCase() : String(value.name).toLowerCase()}`, disposition: {
      phase: 'provider', kind: 'transient', retryable: true, dispatchStarted: false,
    } };
  }
  if (code === 'ENOENT') return { code: 'dependency.enoent', disposition: {
    phase: 'pre_dispatch', kind: 'unsupported', retryable: false, dispatchStarted: false,
  } };
  if (code === 'EACCES' || code === 'EPERM') return { code: `policy.${code.toLowerCase()}`, disposition: {
    phase: 'pre_dispatch', kind: 'policy_denied', retryable: false, dispatchStarted: false,
  } };
  if (code === 'EAGAIN' || code === 'ENOMEM') return { code: `runtime.${code.toLowerCase()}`, disposition: {
    phase: 'runtime', kind: 'transient', retryable: true, dispatchStarted: false,
  } };
  // The SDK subclasses Error without changing .name; timeout errors also
  // inherit APIConnectionError. Preserve their type rather than parsing text.
  if (error instanceof APIConnectionError) return { code: 'provider.connection', disposition: {
    phase: 'provider', kind: 'transient', retryable: true, dispatchStarted: false,
  } };
  return { code: 'runtime.unclassified', disposition: {
    phase: 'runtime', kind: 'unclassified', retryable: false, dispatchStarted: false,
  } };
}

export function classifyRunFailure(error: unknown): RunFailureDisposition {
  const typed = runFailureDisposition(error);
  return typed ?? classifyRunFailureRecord(error).disposition;
}

export function eventFailureAttemptLimit(
  error: unknown,
  claimedAttempts: number,
  configuredMaxAttempts: number,
): number {
  return classifyRunFailure(error).retryable
    ? configuredMaxAttempts
    : Math.max(1, claimedAttempts);
}
