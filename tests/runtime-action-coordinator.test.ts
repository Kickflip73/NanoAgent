import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExecutionLedger } from '../src/core/execution-ledger.js';
import type { RuntimeAction, RuntimeEffect } from '../src/runtime/control.js';
import { RuntimeActionCoordinator } from '../src/runtime/runtime-action-coordinator.js';

async function createCoordinator(
  apply: (action: RuntimeAction) => Promise<RuntimeEffect>,
): Promise<{ coordinator: RuntimeActionCoordinator; ledger: ExecutionLedger }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-runtime-action-coordinator-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  return {
    coordinator: new RuntimeActionCoordinator(ledger, apply),
    ledger,
  };
}

test('recovers, deduplicates and orders successful runtime control calls from the ledger', async () => {
  const { coordinator, ledger } = await createCoordinator(async () => ({ type: 'exit_requested' }));
  const baseCall = {
    sessionId: 'owner',
    runId: 'event:recover',
    argumentsJson: '{}',
  };
  await ledger.executeOnce({
    ...baseCall,
    toolName: 'switch_mode',
    callId: 'mode',
  }, async () => ({ mode: 'plan', effective: 'next_turn' }));
  await ledger.executeOnce({
    ...baseCall,
    toolName: 'clear_session',
    callId: 'clear',
  }, async () => ({ effective: 'after_current_turn' }));

  assert.deepEqual(await coordinator.actionsForCompletedRun({
    pendingActions: [{ type: 'switch_mode', mode: 'plan' }],
    sessionId: 'owner',
    executionKey: 'event:recover',
    retainExecutionLedger: true,
  }), [
    { type: 'clear_session' },
    { type: 'switch_mode', mode: 'plan' },
  ]);
});

test('rejects conflicting recovered actions before applying any runtime mutation', async () => {
  let applications = 0;
  const { coordinator, ledger } = await createCoordinator(async () => {
    applications += 1;
    return { type: 'exit_requested' };
  });
  for (const [callId, model] of [['first', 'model-a'], ['second', 'model-b']] as const) {
    await ledger.executeOnce({
      sessionId: 'owner',
      runId: 'event:conflict',
      toolName: 'switch_model',
      callId,
      argumentsJson: JSON.stringify({ model }),
    }, async () => ({ model, effective: 'next_turn' }));
  }

  await assert.rejects(coordinator.actionsForCompletedRun({
    pendingActions: [],
    sessionId: 'owner',
    executionKey: 'event:conflict',
    retainExecutionLedger: true,
  }), /冲突的 switch_model RuntimeAction/);
  assert.equal(applications, 0);
});

test('applies retained runtime actions at most once while replaying the persisted effect', async () => {
  let applications = 0;
  const { coordinator } = await createCoordinator(async (action) => {
    applications += 1;
    assert.equal(action.type, 'reload_mcp');
    return { type: 'mcp_reloaded' };
  });
  const actions = [{ type: 'reload_mcp' }] as const;

  assert.deepEqual(await coordinator.apply(actions, 'owner', 'event:apply'), [{ type: 'mcp_reloaded' }]);
  assert.deepEqual(await coordinator.apply(actions, 'owner', 'event:apply'), [{ type: 'mcp_reloaded' }]);
  assert.equal(applications, 1);
});
