import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRunCanComplete, isRunInterrupted } from '../src/runtime/run-outcome.js';

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
