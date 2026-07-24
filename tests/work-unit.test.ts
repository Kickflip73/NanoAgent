import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCompletion, type CompletionEvidence } from '../src/core/completion.js';
import { isWorkUnitResult, type WorkUnitResult } from '../src/core/work-unit.js';
import { backgroundTaskWorkUnit } from '../src/daemon/task-tools.js';
import type { TaskRecord } from '../src/daemon/types.js';
import { teamWorkerDescriptor } from '../src/extensions/team.js';

const completedUnit: WorkUnitResult = {
  id: 'build',
  status: 'completed',
  summary: 'built and tested',
  artifacts: [{ path: 'src/feature.ts', digest: 'sha256:abc' }],
  evidence: [{ type: 'test', ref: 'team:test:result' }],
  startedAt: '2026-07-24T00:00:00.000Z',
  completedAt: '2026-07-24T00:01:00.000Z',
};

test('team, background and Codex adapters share the WorkUnit contract', () => {
  const team = teamWorkerDescriptor({
    id: 'build',
    description: 'implement feature',
    role: 'builder',
    status: 'running',
    dependencies: ['design'],
    paths: ['src/feature.ts'],
    claimId: 'claim-1',
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:10.000Z',
  }, 'run-1');
  assert.equal(team.kind, 'team-worker');
  assert.equal(team.workspaceAccess, 'write');

  const task = {
    id: 'task-1',
    type: 'background',
    idempotencyKey: 'task-1',
    authorityEventId: 'event-1',
    profileId: 'owner',
    objective: { objective: 'implement with Codex', executor: 'codex' },
    executor: 'codex',
    workspaceAccess: 'write',
    priority: 70,
    status: 'completed',
    notBefore: '2026-07-24T00:00:00.000Z',
    attemptCount: 1,
    maxAttempts: 1,
    result: {
      answer: 'done',
      artifacts: { outputJsonl: '/tmp/events.jsonl', summary: '/tmp/summary.json' },
    },
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:01:00.000Z',
  } satisfies TaskRecord;
  const codex = backgroundTaskWorkUnit(task);
  assert.equal(codex.descriptor.kind, 'codex');
  assert.equal(codex.result.status, 'completed');
  assert.deepEqual(codex.result.artifacts.map((artifact) => artifact.path), [
    '/tmp/events.jsonl',
    '/tmp/summary.json',
  ]);
  assert.equal(isWorkUnitResult(codex.result), true);
});

test('completion evidence accepts WorkUnit artifacts and test receipts', () => {
  const evidence: CompletionEvidence[] = [{
    toolName: 'run_team',
    callId: 'call-team',
    argumentsJson: '{"taskIds":["build"]}',
    status: 'succeeded',
    output: { results: [completedUnit] },
  }];
  const report = {
    status: 'completed' as const,
    proofs: [
      { criterionId: 'artifact', evidence: 'builder output', toolCallIds: ['call-team'] },
      { criterionId: 'test', evidence: 'tester output', toolCallIds: ['call-team'] },
    ],
  };
  const decision = evaluateCompletion({
    objective: 'build feature',
    kind: 'artifact',
    criteria: [
      {
        id: 'artifact',
        description: 'artifact exists',
        requiredEvidence: 'artifact',
        expectedTool: 'run_team',
        expectedArgumentsContain: ['build'],
      },
      {
        id: 'test',
        description: 'tests pass',
        requiredEvidence: 'test',
        expectedTool: 'run_team',
        expectedArgumentsContain: ['build'],
      },
    ],
  }, report, evidence);
  assert.equal(decision.decision, 'pass');
});
