import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildResumePrompt,
  recoverySummary,
  sessionStateSummary,
} from '../src/runtime/session-state.js';

const now = '2026-07-14T00:00:00.000Z';

test('builds an honest best-effort resume prompt from all durable task state', () => {
  const prompt = buildResumePrompt({
    checkpoint: {
      runId: 'run-1', input: '修复状态层', status: 'interrupted', phase: '运行工具',
      lastEvent: '已完成状态文件', nextAction: '运行测试', startedAt: now, updatedAt: now,
    },
    goal: {
      objective: '完善 MimiAgent', status: 'active', checkpoint: '状态层完成',
      nextAction: '收尾', createdAt: now, updatedAt: now,
    },
    steps: [{ id: 'test', description: '运行全量测试', status: 'pending' }],
    teamSummary: '[pending] review',
    teamTasks: [{
      id: 'review', description: '复审', role: 'reviewer', status: 'pending', dependencies: [], paths: [],
      createdAt: now, updatedAt: now,
    }],
  });

  assert.match(prompt, /修复状态层/);
  assert.match(prompt, /完善 MimiAgent/);
  assert.match(prompt, /运行全量测试/);
  assert.match(prompt, /review/);
  assert.match(prompt, /best-effort/);
  assert.match(prompt, /核对.*工作区状态/);
});

test('rejects resume when every durable task is already complete', () => {
  assert.throws(() => buildResumePrompt({
    checkpoint: {
      runId: 'run-1', input: 'done', status: 'completed', phase: '完成',
      startedAt: now, updatedAt: now,
    },
    goal: {
      objective: 'done', status: 'completed', createdAt: now, updatedAt: now,
    },
    steps: [{ id: 'done', description: 'done', status: 'completed' }],
    teamSummary: '[completed] done',
    teamTasks: [{
      id: 'done', description: 'done', role: 'reviewer', status: 'completed', dependencies: [], paths: [],
      createdAt: now, updatedAt: now,
    }],
  }), /没有可恢复/);
});

test('summarizes recovery and active session state without runtime dependencies', () => {
  const checkpoint = {
    runId: 'run-2', input: '继续', status: 'failed' as const, phase: '测试', error: 'boom',
    startedAt: now, updatedAt: now,
  };
  assert.match(recoverySummary(checkpoint), /停止原因：boom/);
  assert.equal(recoverySummary({ ...checkpoint, status: 'completed' }), '');
  assert.match(sessionStateSummary({
    input: '实现功能',
    plan: [{ id: 'build', description: '编码', status: 'running' }],
    goal: undefined,
    hasTeam: false,
    run: { sessionId: 'demo', mode: 'general', modeLabel: '通用', modelName: 'model' },
    outputLevel: 'tools',
  }), /当前阶段：build 编码/);
});
