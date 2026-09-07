import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APIConnectionError, APIConnectionTimeoutError } from 'openai';
import { TerminalRunInterruptedError } from '../src/runtime/run-outcome.js';
import {
  classifyRunFailure,
  eventFailureAttemptLimit,
} from '../src/daemon/dispatcher-retry-policy.js';
import { RunFailureError } from '../src/runtime/run-failure.js';

test('typed pre-dispatch state and unsupported failures execute only once across scenarios', () => {
  const staleRevision = new RunFailureError(
    'goal_revision_conflict',
    'Goal revision is stale',
    {
      phase: 'pre_dispatch',
      kind: 'state_conflict',
      retryable: false,
      dispatchStarted: false,
    },
  );
  const unsupportedCancel = new RunFailureError(
    'goal_cancel_unsupported',
    'Goal cannot be cancelled',
    {
      phase: 'pre_dispatch',
      kind: 'unsupported',
      retryable: false,
      dispatchStarted: false,
    },
  );

  assert.deepEqual(classifyRunFailure(staleRevision), staleRevision.disposition);
  assert.equal(eventFailureAttemptLimit(staleRevision, 1, 5), 1);
  assert.equal(eventFailureAttemptLimit(unsupportedCancel, 2, 5), 2);
});

test('retry policy uses structured dispatch facts instead of natural-language error keywords', () => {
  const transient = new RunFailureError(
    'provider_connection_reset',
    'temporary provider connection reset',
    {
      phase: 'pre_dispatch',
      kind: 'transient',
      retryable: true,
      dispatchStarted: false,
    },
  );

  assert.equal(eventFailureAttemptLimit(transient, 1, 5), 5);
  const unstructured = new Error('uncertain 禁止自动重放');
  assert.equal(classifyRunFailure(unstructured).kind, 'unclassified');
  assert.equal(eventFailureAttemptLimit(unstructured, 1, 5), 1);
});

test('dispatcher retry policy stops terminal and deterministic run failures immediately', () => {
  assert.equal(eventFailureAttemptLimit(new TerminalRunInterruptedError('cancelled'), 2, 5), 2);
  assert.equal(eventFailureAttemptLimit({ name: 'ContextProtocolBudgetError' }, 1, 5), 1);
  assert.equal(eventFailureAttemptLimit({ name: 'MaxTurnsExceededError' }, 3, 5), 3);
  assert.equal(eventFailureAttemptLimit({ name: 'EphemeralSecretsExpiredError' }, 2, 5), 2);
  assert.equal(eventFailureAttemptLimit({ name: 'EphemeralSensitiveRunFailedError' }, 1, 5), 1);
  assert.equal(eventFailureAttemptLimit({ name: 'ActionIntentUncertainError' }, 1, 5), 1);
  assert.equal(eventFailureAttemptLimit({ name: 'MaxTurnsExceededError' }, 1, 5), 1);
});

test('dispatcher retry policy does not replay rejected requests, quota failures, or rate limits', () => {
  assert.equal(eventFailureAttemptLimit(Object.assign(new Error('rejected'), { status: 400 }), 1, 5), 1);
  assert.equal(eventFailureAttemptLimit(Object.assign(new Error('unauthorized'), { status: 401 }), 2, 5), 2);
  assert.equal(eventFailureAttemptLimit(Object.assign(new Error('rate limited'), { status: 429 }), 1, 5), 1);
  assert.equal(eventFailureAttemptLimit(Object.assign(new Error('client closed'), { status: 499 }), 1, 5), 1);
});

test('dispatcher retry policy preserves retries for transient and server failures', () => {
  assert.equal(eventFailureAttemptLimit(Object.assign(new Error('timeout'), { status: 408 }), 1, 5), 5);
  assert.equal(eventFailureAttemptLimit(Object.assign(new Error('conflict'), { status: 409 }), 1, 5), 5);
  assert.equal(eventFailureAttemptLimit(Object.assign(new Error('too early'), { status: 425 }), 1, 5), 5);
  assert.equal(eventFailureAttemptLimit(Object.assign(new Error('unavailable'), { status: 500 }), 1, 5), 5);
  assert.equal(eventFailureAttemptLimit(Object.assign(new Error('network reset'), { code: 'ECONNRESET' }), 1, 5), 5);
});

test('real SDK connection errors retain bounded retries even when their name is Error', () => {
  for (const error of [new APIConnectionError({}), new APIConnectionTimeoutError()]) {
    assert.equal(error.name, 'Error');
    assert.equal(classifyRunFailure(error).phase, 'provider');
    assert.equal(eventFailureAttemptLimit(error, 1, 5), 5);
  }
});

test('dispatcher retry policy handles pre-claim failures without producing a zero-attempt limit', () => {
  assert.equal(eventFailureAttemptLimit(Object.assign(new Error('rejected'), { status: 400 }), 0, 5), 1);
  assert.equal(eventFailureAttemptLimit(new TerminalRunInterruptedError('cancelled'), 0, 5), 1);
});
