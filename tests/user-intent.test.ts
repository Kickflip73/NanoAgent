import assert from 'node:assert/strict';
import test from 'node:test';
import {
  explicitlyRequestsMemory,
  explicitlyRequestsSessionAccess,
  explicitlyRequestsSessionClear,
} from '../src/core/user-intent.js';

test('requires affirmative long-term memory write intent', () => {
  for (const input of ['请记住我喜欢简洁输出', 'remember this for later', 'I want you to remember my preference']) {
    assert.equal(explicitlyRequestsMemory(input), true, input);
  }
  for (const input of [
    '不要记住我的密码', '我不想让你记住我的密码', '你还记住我什么？',
    'please do not remember this password', "I don't want you to remember my password",
    "please don't ever remember this",
  ]) assert.equal(explicitlyRequestsMemory(input), false, input);
});

test('rejects negated Session access and destructive clear intent', () => {
  for (const input of ['查看会话列表', 'switch session to demo', '/sessions']) {
    assert.equal(explicitlyRequestsSessionAccess(input), true, input);
  }
  for (const input of ['不要查看其他会话', '不要切换会话', "don't show sessions", 'do not switch sessions']) {
    assert.equal(explicitlyRequestsSessionAccess(input), false, input);
  }
  for (const input of ['请清空当前会话', 'please clear the current session', '/clear']) {
    assert.equal(explicitlyRequestsSessionClear(input), true, input);
  }
  for (const input of [
    '我不想让你清空当前会话', "I don't want you to clear the current session",
    "please don't ever delete this chat",
  ]) assert.equal(explicitlyRequestsSessionClear(input), false, input);
});
