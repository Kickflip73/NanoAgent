import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readCodexTaskProgress } from '../src/daemon/codex-task-progress.js';

test('reads bounded useful progress from persisted Codex JSONL', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-codex-progress-'));
  const output = path.join(root, 'events.jsonl');
  await writeFile(output, [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'item.completed', item: {
      type: 'command_execution', command: 'npm test', aggregated_output: 'SECRET_OUTPUT',
      exit_code: 0, status: 'completed',
    } }),
    'malformed diagnostic',
    JSON.stringify({ type: 'item.completed', item: {
      type: 'file_change', status: 'completed',
      changes: [{ kind: 'add', path: '/workspace/src/game.ts' }],
    } }),
  ].join('\n') + '\n');

  const progress = await readCodexTaskProgress(output);
  assert.ok(progress);
  assert.equal(progress.recentEvents.length, 3);
  assert.match(progress.logUpdatedAt, /^\d{4}-/);
  assert.match(progress.latestActivity ?? '', /file_change.*game\.ts/);
  assert.doesNotMatch(JSON.stringify(progress), /SECRET_OUTPUT/);
});

test('returns undefined before the Codex JSONL artifact exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-codex-progress-missing-'));
  assert.equal(await readCodexTaskProgress(path.join(root, 'missing.jsonl')), undefined);
});
