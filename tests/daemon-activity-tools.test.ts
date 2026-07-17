import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RunContext, type Tool } from '@openai/agents';
import { createMimiActivityTools } from '../src/daemon/activity-tools.js';
import { MimiStore } from '../src/daemon/store.js';
import { isSideEffectTool, toolsForRunPolicy } from '../src/runtime/tool-policy.js';

async function invoke(tools: Tool[], input: unknown): Promise<unknown> {
  const selected = tools.find((candidate) => candidate.name === 'inspect_mimi_activity');
  assert.ok(selected && 'invoke' in selected);
  return selected.invoke(new RunContext({}), JSON.stringify(input));
}

test('Mimi activity tool is bounded read-only self-inspection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-activity-tool-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const tools = createMimiActivityTools(store);
    const snapshot = await invoke(tools, { limit: 10 }) as { needsAttention: boolean; workPending: number };
    assert.equal(snapshot.needsAttention, false);
    assert.equal(snapshot.workPending, 0);
    assert.match(String(await invoke(tools, { limit: 21 })), /Invalid input|error/i);
    assert.equal(isSideEffectTool('inspect_mimi_activity'), false);
    assert.deepEqual(toolsForRunPolicy(tools, {
      allowedCapabilities: ['state-read'], allowSideEffects: false,
    }).map((candidate) => candidate.name), ['inspect_mimi_activity']);
  } finally {
    store.close();
  }
});
