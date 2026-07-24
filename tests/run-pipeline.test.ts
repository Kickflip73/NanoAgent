import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import type { Tool } from '@openai/agents';
import { ContextManager } from '../src/core/context.js';
import { CapabilityResolver } from '../src/runtime/pipeline/capability-resolver.js';
import { ContextAssembler } from '../src/runtime/pipeline/context-assembler.js';
import { AgentRequestFactory } from '../src/runtime/pipeline/request-factory.js';
import { captureRunScope } from '../src/runtime/pipeline/run-scope.js';
import { RunStateLoader } from '../src/runtime/pipeline/state-loader.js';
import { ToolSetBuilder } from '../src/runtime/pipeline/tool-set-builder.js';

function scope() {
  return captureRunScope({
    sessionId: 'session-1',
    workspaceRoot: '/workspace',
    provider: 'openai',
    model: 'gpt-test',
    mode: 'general',
    permissionMode: 'trusted',
    securityProfile: 'workstation',
    input: 'inspect',
    options: {
      executionKey: 'event-1',
      cause: {
        eventId: 'event-1',
        profileId: 'owner',
        source: 'local-cli',
        trust: 'owner',
      },
    },
  });
}

test('captures an immutable run scope before delayed pipeline work', () => {
  const captured = scope();
  assert.equal(captured.profileId, 'owner');
  assert.equal(captured.executionKey, 'event-1');
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.cause));
  assert.throws(() => {
    (captured as { sessionId: string }).sessionId = 'other';
  }, TypeError);
});

test('context assembler accounts for every request section without prompt copies', () => {
  const manager = new ContextManager(40, 8_000, 0.55, 1_000);
  const budget = manager.requestBudget([{ name: 'read_file', parameters: { type: 'object' } }]);
  const instructions = manager.buildInstructionsResult({
    baseInstructions: 'base',
    historySummary: '',
    skillCatalog: '',
    memories: [],
    plan: [],
  }, 1_000);
  const currentInput = [{ role: 'user', content: 'inspect' } as AgentInputItem];
  const effective = manager.effectiveHistoryResult([], currentInput, undefined, 1_000);
  const manifest = new ContextAssembler().manifest({
    scope: scope(),
    budget,
    instructions,
    effective,
    archiveInput: [],
    currentInput,
    toolCount: 1,
  });

  assert.equal(manifest.availableInputBudget, budget.inputBudget);
  assert.equal(
    manifest.sections.reduce((total, section) => total + section.estimatedTokens, 0),
    manifest.estimatedInputTokens,
  );
  assert.deepEqual(
    manifest.sections.slice(-2).map((section) => section.id),
    ['tool-schemas', 'protocol-reserve'],
  );
  assert.equal(JSON.stringify(manifest).includes('inspect'), false);
});

test('capability resolver preserves provenance, mode, and completion boundaries', () => {
  const resolver = new CapabilityResolver();
  const owner = resolver.resolve({
    scope: scope(),
    developmentTask: true,
    expectedArtifactCompletion: false,
    defaultComputerAccess: 'background',
  });
  assert.equal(owner.canReadLocal, true);
  assert.equal(owner.canInitializeProjectGuidance, true);
  assert.equal(owner.computerAccess, 'none');
  assert.equal(owner.completionToolsAllowed, true);

  const restricted = resolver.resolve({
    scope: scope(),
    policy: {
      allowedCapabilities: ['delivery-control'],
      allowedTools: ['finish_mimi_silently'],
      allowSessionContext: false,
    },
    developmentTask: true,
    expectedArtifactCompletion: false,
  });
  assert.deepEqual(restricted, {
    canReadLocal: false,
    canReadMemory: false,
    canReadState: false,
    canReadSessionContext: false,
    canInitializeProjectGuidance: false,
    completionToolsAllowed: false,
    computerAccess: 'none',
  });
});

test('tool set builder keeps mode and run-policy filtering in one stage', () => {
  const tool = (name: string) => ({ name }) as Tool;
  const builder = new ToolSetBuilder();
  const prepared = builder.final(
    'plan',
    [tool('read_file'), tool('write_file')],
    [tool('run_team')],
    [tool('delegate_research')],
    'trusted',
    'workstation',
    {
      allowedCapabilities: ['read'],
      allowSideEffects: false,
    },
  );
  assert.deepEqual(prepared.map((item) => item.name), ['read_file', 'delegate_research']);
});

test('state loader skips every unauthorized source', async () => {
  const denied = () => Promise.reject(new Error('unauthorized loader was called'));
  const loader = new RunStateLoader({
    hotProfile: denied,
    searchMemories: denied,
    loadPlan: denied,
    loadGoal: denied,
    loadTeamSummary: denied,
    loadHistory: denied,
    loadSoul: denied,
    loadProjectGuidance: denied,
    loadArchive: denied,
  });
  const state = await loader.load({
    canReadLocal: false,
    canReadMemory: false,
    canReadState: false,
    canReadSessionContext: false,
    canInitializeProjectGuidance: false,
    completionToolsAllowed: false,
    computerAccess: 'none',
  }, true);
  assert.deepEqual(state.memories, []);
  assert.deepEqual(state.history, []);
  assert.ok(Object.isFrozen(state));
});

test('request factory freezes the model-facing tool order and output cap', () => {
  const request = new AgentRequestFactory().create({
    model: 'gpt-test',
    instructions: 'system',
    tools: [{ name: 'read_file' } as Tool, { name: 'delegate_research' } as Tool],
    mcpServers: [],
    outputReserve: 8_000,
    focusedOutputLimit: 4_096,
  });
  assert.equal(request.maxTokens, 4_096);
  assert.deepEqual(request.toolNames, ['read_file', 'delegate_research']);
  assert.ok(Object.isFrozen(request.toolNames));
});
