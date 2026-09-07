import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const budgets = {
  'src/runtime/mimi-agent.ts': 1_800,
  'src/daemon/service.ts': 1_800,
  'src/daemon/store.ts': 1_900,
} as const;

const arc303ProductionFiles = [
  'src/runtime/mimi-agent.ts',
  'src/runtime/run-service.ts',
  'src/runtime/runtime-control-coordinator.ts',
  'src/runtime/stream-projection.ts',
  'src/runtime/pipeline/run-pipeline.ts',
  'src/runtime/pipeline/run-commit-coordinator.ts',
  'src/daemon/service.ts',
  'src/daemon/store.ts',
  'src/daemon/lifecycle.ts',
  'src/daemon/activity-store.ts',
  'src/daemon/chat-snapshot.ts',
  'src/daemon/initialization.ts',
  'src/daemon/json-file.ts',
  'src/daemon/launch-agent-config.ts',
  'src/daemon/memory-observation-store.ts',
  'src/daemon/outbox-store.ts',
  'src/daemon/run-store.ts',
  'src/daemon/schedule-store.ts',
  'src/daemon/task-continuation.ts',
  'src/daemon/persistence/schema/migrations/v17-schedule-context.ts',
  'src/daemon/sqlite-domain.ts',
  'src/core/xml.ts',
] as const;

function sourceLines(source: string): number {
  return source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length;
}

test('M1 composition roots stay within their source-line budgets', async () => {
  for (const [file, maximum] of Object.entries(budgets)) {
    const source = await readFile(path.resolve(file), 'utf8');
    const lines = sourceLines(source);
    assert.ok(lines <= maximum, `${file}: ${lines} > ${maximum}`);
  }
});

test('ARC-303 surface plus phase-two continuity stays within its explicit incremental budget', async () => {
  const counts = await Promise.all(arc303ProductionFiles.map(async (file) => ({
    file,
    lines: sourceLines(await readFile(path.resolve(file), 'utf8')),
  })));
  const total = counts.reduce((sum, entry) => sum + entry.lines, 0);
  // Keep the refactored baseline, with 250 lines for result review, durable
  // schedule context and usage reporting. Include new modules in the count.
  const maximum = 8_505 + 250;
  assert.ok(total <= maximum, `${total} > ${maximum}\n${counts
    .sort((left, right) => right.lines - left.lines)
    .map((entry) => `${entry.file}: ${entry.lines}`)
    .join('\n')}`);
});
