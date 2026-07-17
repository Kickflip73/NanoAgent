import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CodexCliTaskExecutor } from '../src/daemon/codex-task-executor.js';

test('Codex executor parses JSONL progress and returns the resumable thread', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-codex-executor-'));
  const fixture = path.join(root, 'codex-fixture.mjs');
  await writeFile(fixture, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'thread-123'})+'\\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'implemented and tested'}})+'\\n');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:4,output_tokens:2}})+'\\n');
`);
  await chmod(fixture, 0o755);
  const events: string[] = [];
  const result = await new CodexCliTaskExecutor(fixture).execute({
    objective: '实现功能',
    successCriteria: '测试通过',
    workspaceRoot: root,
    workspaceAccess: 'write',
    onProgress: (event) => { if (typeof event.type === 'string') events.push(event.type); },
  });
  assert.equal(result.threadId, 'thread-123');
  assert.equal(result.answer, 'implemented and tested');
  assert.deepEqual(events, ['thread.started', 'item.completed', 'turn.completed']);
});

test('Codex executor reports a missing optional CLI without hiding the fallback signal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-codex-missing-'));
  await assert.rejects(new CodexCliTaskExecutor(path.join(root, 'missing-codex')).execute({
    objective: 'work', workspaceRoot: root, workspaceAccess: 'read',
  }), (error: unknown) => (
    error instanceof Error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
    && /Codex CLI 不可用/.test(error.message)
  ));
});
