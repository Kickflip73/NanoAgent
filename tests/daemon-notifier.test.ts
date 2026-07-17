import assert from 'node:assert/strict';
import test from 'node:test';
import { runNotificationCommand, systemNotificationArgs } from '../src/daemon/notifier.js';

test('system notification separates option-like message text from osascript flags', () => {
  const args = systemNotificationArgs('--- status');

  assert.equal(args.at(-2), '--');
  assert.equal(args.at(-1), '--- status');
});

test('system notification command is force-terminated after its deadline', async () => {
  await assert.rejects(
    runNotificationCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 100),
    /通知命令执行超时/,
  );
});
