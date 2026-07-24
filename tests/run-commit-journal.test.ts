import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  RunCommitJournal,
  runAnswerDigest,
} from '../src/core/run-commit-journal.js';

test('run commit journal advances durably without storing answer text', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-run-commit-'));
  const file = path.join(root, 'journal.json');
  const answer = 'private final answer';
  const first = new RunCommitJournal(file);
  const prepared = await first.prepare({
    sessionId: 'owner',
    runId: 'run-1',
    executionKey: 'task:one',
    answerDigest: runAnswerDigest(answer),
    completionDecision: 'pass',
    runtimeActions: [{ type: 'switch_mode', mode: 'plan' }],
  });
  assert.equal(prepared.phase, 'prepared');
  await first.advance('owner', 'run-1', 'receipt_committed');
  await first.advance('owner', 'run-1', 'session_committed');

  const reopened = new RunCommitJournal(file);
  assert.equal((await reopened.get('owner', 'run-1'))?.phase, 'session_committed');
  assert.equal(JSON.stringify(await reopened.recoverable()).includes(answer), false);
  assert.equal((await reopened.findByExecutionKey('owner', 'task:one'))?.runId, 'run-1');

  await reopened.acknowledgeTask('owner', 'task:one');
  assert.equal((await reopened.get('owner', 'run-1'))?.phase, 'task_committed');
  await reopened.finalizeExecution('owner', 'task:one');
  assert.equal((await reopened.get('owner', 'run-1'))?.phase, 'finalized');
  assert.deepEqual(await reopened.recoverable(), []);
});

test('every commit phase survives a journal reopen', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-run-commit-phases-'));
  const file = path.join(root, 'journal.json');
  const phases = [
    'prepared',
    'receipt_committed',
    'session_committed',
    'goal_committed',
    'task_committed',
    'effects_applied',
    'finalized',
  ] as const;
  const journal = new RunCommitJournal(file);
  for (const [index, phase] of phases.entries()) {
    const runId = `run-${index}`;
    const executionKey = `task:${index}`;
    await journal.prepare({
      sessionId: 'owner',
      runId,
      executionKey,
      answerDigest: runAnswerDigest(runId),
      runtimeActions: [],
    });
    if (phase === 'task_committed') {
      await journal.acknowledgeTask('owner', executionKey);
    } else if (phase === 'finalized') {
      await journal.finalizeExecution('owner', executionKey);
    } else if (phase !== 'prepared') {
      await journal.advance('owner', runId, phase);
    }
    assert.equal((await new RunCommitJournal(file).get('owner', runId))?.phase, phase);
  }
});

test('run commit journal rejects a conflicting answer or action plan', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-run-commit-conflict-'));
  const journal = new RunCommitJournal(path.join(root, 'journal.json'));
  await journal.prepare({
    sessionId: 'owner',
    runId: 'run-1',
    answerDigest: runAnswerDigest('one'),
    runtimeActions: [],
  });
  await assert.rejects(journal.prepare({
    sessionId: 'owner',
    runId: 'run-1',
    answerDigest: runAnswerDigest('two'),
    runtimeActions: [],
  }), /不同的提交计划/);
});
