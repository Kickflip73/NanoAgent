import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerminalRunInterruptedError } from '../src/runtime/run-outcome.js';
import { eventFailureAttemptLimit } from '../src/daemon/dispatcher-retry-policy.js';

test('dispatcher retry policy stops terminal and deterministic run failures immediately', () => {
  assert.equal(eventFailureAttemptLimit(new TerminalRunInterruptedError('cancelled'), 2, 5), 2);
  assert.equal(eventFailureAttemptLimit({ name: 'ContextProtocolBudgetError' }, 1, 5), 1);
  assert.equal(eventFailureAttemptLimit({ name: 'MaxTurnsExceededError' }, 3, 5), 3);
  assert.equal(eventFailureAttemptLimit(new Error('Max turns (12) exceeded'), 1, 5), 1);
  assert.equal(eventFailureAttemptLimit(new Error('Max turns exceeded later'), 1, 5), 5);
});

test('dispatcher retry policy does not replay rejected requests, quota failures, or rate limits', () => {
  assert.equal(eventFailureAttemptLimit(Object.assign(new Error('rejected'), { status: 400 }), 1, 5), 1);
  assert.equal(eventFailureAttemptLimit(new Error('401 unauthorized'), 2, 5), 2);
  assert.equal(eventFailureAttemptLimit(new Error('429 rate limited'), 1, 5), 1);
  assert.equal(eventFailureAttemptLimit(new Error('499 client closed'), 1, 5), 1);
});

test('dispatcher retry policy preserves retries for transient and server failures', () => {
  assert.equal(eventFailureAttemptLimit(new Error('408 timeout'), 1, 5), 5);
  assert.equal(eventFailureAttemptLimit(new Error('409 conflict'), 1, 5), 5);
  assert.equal(eventFailureAttemptLimit(new Error('425 too early'), 1, 5), 5);
  assert.equal(eventFailureAttemptLimit(new Error('500 unavailable'), 1, 5), 5);
  assert.equal(eventFailureAttemptLimit(new Error('network reset'), 1, 5), 5);
});

test('dispatcher retry policy handles pre-claim failures without producing a zero-attempt limit', () => {
  assert.equal(eventFailureAttemptLimit(new Error('400 rejected'), 0, 5), 1);
  assert.equal(eventFailureAttemptLimit(new TerminalRunInterruptedError('cancelled'), 0, 5), 1);
});
