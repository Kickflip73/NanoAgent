import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRunCanComplete,
  isRunInterrupted,
  isTerminalRunInterruption,
  RunInterruptedError,
  TerminalRunInterruptedError,
} from '../src/runtime/run-outcome.js';

test('does not mark cancelled or approval-paused SDK streams as completed', () => {
  assert.doesNotThrow(() => assertRunCanComplete({ cancelled: false, interruptions: [] }));
  assert.throws(() => assertRunCanComplete({ cancelled: true }), /取消/);
  assert.throws(() => assertRunCanComplete({ interruptions: [{}] }), /等待审批/);
  try {
    assertRunCanComplete({ cancelled: true });
  } catch (error) {
    assert.equal(isRunInterrupted(error), true);
  }
});

test('preserves terminal cancellation through SDK interruption wrapping', () => {
  const controller = new AbortController();
  controller.abort(new TerminalRunInterruptedError('owner cancelled'));
  try {
    assertRunCanComplete({ cancelled: true }, controller.signal);
    assert.fail('expected interruption');
  } catch (error) {
    assert.equal(isRunInterrupted(error), true);
    assert.equal(isTerminalRunInterruption(error), true);
  }
  assert.equal(isTerminalRunInterruption(new RunInterruptedError('retry later')), false);
  assert.equal(isTerminalRunInterruption(new Error('ordinary failure')), false);
});
