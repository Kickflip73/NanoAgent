import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import { tool } from '../src/tool-factory.js';
import { z } from 'zod';
import { RunFactCollector, mergeRunCalls } from '../src/runtime/pipeline/run-fact-collector.js';
import { SpeechOutput } from '../src/runtime/speech-output.js';
import { createRunFinalization } from '../src/core/run-finalization.js';
import { FileSession } from '../src/core/session.js';
import { recoverySummary } from '../src/runtime/session-state.js';
import { SpeechRenderUncertainError } from '../src/runtime/speech-output.js';
import { createSpeechTools } from '../src/runtime/speech-tools.js';
import { toolProgress, toolProgressSchema } from '../src/core/tool-result.js';
import { MimiAgent } from '../src/runtime/mimi-agent.js';
import type { Tool } from '@openai/agents';

test('real runtime wiring exposes interrupted file evidence to a normal conversational continuation', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-continuation-runtime-'));
  context.mock.method(os, 'homedir', () => root);
  const config = { provider: 'openai' as const, defaultModel: 'continuity-test-model',
    workspaceRoot: root, dataRoot: path.join(root, '.mimi-agent'),
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, contextWindow: 128_000, maxTurns: 20 };
  const file = path.join(root, 'report.csv');
  let agent: MimiAgent | undefined;
  const setRunner = (instance: MimiAgent, run: (runtime: { tools: Tool[]; instructions: string }) => Promise<unknown>) => {
    (instance as unknown as { runner: { run: typeof run } }).runner.run = run;
  };
  try {
    agent = await MimiAgent.create(config, 'continuation');
    setRunner(agent, async (runtime) => {
      const write = runtime.tools.find((item) => item.name === 'write_file');
      assert.ok(write && 'invoke' in write);
      await write.invoke(new RunContext({}), JSON.stringify({ path: file, content: 'month,total\n09,42' }));
      throw new Error('simulated model disconnect after file write');
    });
    await assert.rejects(agent.stream('export a report', undefined,
      { executionKey: 'first-export', retainExecutionLedger: true }), /simulated model disconnect/);
    await agent.close();
    agent = await MimiAgent.create(config, 'continuation');
    let read = false;
    setRunner(agent, async (runtime) => {
      assert.match(runtime.instructions, /report\.csv/);
      assert.match(runtime.instructions, /不是自动续跑命令/);
      const reader = runtime.tools.find((item) => item.name === 'read_file');
      assert.ok(reader && 'invoke' in reader);
      const result = await reader.invoke(new RunContext({}), JSON.stringify({ path: file }));
      assert.match(JSON.stringify(result), /month,total/);
      read = true;
      return {};
    });
    await agent.stream('接着帮我核对刚才的文件');
    await agent.completeRun('verified existing report');
    assert.equal(read, true);
    assert.equal(await readFile(file, 'utf8'), 'month,total\n09,42');
  } finally {
    await agent?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('nonzero process results stay failed after merging the at-most-once receipt', async () => {
  const facts = new RunFactCollector();
  const [wrapped] = facts.wrap([tool({ name: 'run_shell', description: 'fixture',
    parameters: z.object({}), execute: async () => ({ exitCode: 1, stderr: 'bad substitution' }),
  })]);
  assert.ok(wrapped && 'invoke' in wrapped);
  await wrapped.invoke(new RunContext({}), '{}');
  const observed = facts.calls('session', 'run');
  assert.equal(observed[0]?.status, 'failed');
  const merged = mergeRunCalls(observed, [{ ...observed[0]!, status: 'succeeded' }]);
  assert.equal(merged[0]?.status, 'failed');
  assert.equal(createRunFinalization({ runId: 'run', answer: 'done', calls: merged }).outcome, 'failed');
  const direct = createRunFinalization({ runId: 'run', answer: 'done', calls: [{ ...observed[0]!, status: 'succeeded' }] });
  assert.equal(direct.toolManifest[0]?.status, 'failed');
});

test('tool progress survives repeated interruptions but not unrelated runs or stale owners', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-progress-'));
  try {
    const session = new FileSession(root, 'owner');
    await session.beginRun('export report', 'one');
    await session.recordToolProgress({ sessionId: 'owner', runId: 'one', toolName: 'export_report',
      callId: 'export', argumentsJson: '{}', status: 'succeeded', output: { file: '/tmp/report.csv' } }, 'one');
    await session.failRun('interrupted', true, 'one');
    const reopened = new FileSession(root, 'owner');
    assert.match(recoverySummary(await reopened.getCheckpoint()), /report\.csv/);
    const related = recoverySummary(await reopened.getCheckpoint(), false);
    assert.match(related, /report\.csv/);
    assert.match(related, /不是自动续跑命令/);
    await reopened.beginRun('export report', 'two', undefined, false, true);
    await session.recordToolProgress({ sessionId: 'owner', runId: 'one', toolName: 'stale',
      callId: 'stale', argumentsJson: '{}', status: 'succeeded' }, 'one');
    assert.equal((await reopened.getCheckpoint())?.toolProgress?.length, 1);
    await reopened.failRun('interrupted again', true, 'two');
    assert.match(recoverySummary(await new FileSession(root, 'owner').getCheckpoint()), /report\.csv/);
    await reopened.beginRun('unrelated question', 'three');
    assert.equal((await reopened.getCheckpoint())?.toolProgress, undefined);
    assert.equal((await new FileSession(root, 'different-session').getCheckpoint()), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('finalization retains generic file references without promoting a failed output to an artifact', () => {
  const base = { sessionId: 'owner', runId: 'run', argumentsJson: '{}', status: 'succeeded' as const };
  const result = createRunFinalization({ runId: 'run', answer: 'files ready', calls: [
    { ...base, toolName: 'export_report', callId: 'report', output: { file: '/tmp/report.csv' } },
    { ...base, toolName: 'generate_image', callId: 'image', output: { artifacts: [{ path: '/tmp/image.png' }] } },
    { ...base, toolName: 'run_shell', callId: 'fail', output: { exitCode: 1, file: '/tmp/missing.txt' } },
  ] });
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.artifacts?.map((item) => item.path), ['/tmp/report.csv', '/tmp/image.png']);
});

test('checkpoint excerpts redact structured credentials before applying size bounds', () => {
  const secret = 'a-private-fixture-value';
  const value = { apiKey: secret, rows: Array.from({ length: 150 }, () => ({ password: secret })) };
  const progress = toolProgress({ sessionId: 'owner', runId: 'run', callId: 'call', toolName: 'probe',
    status: 'succeeded', argumentsJson: JSON.stringify(value), output: JSON.stringify(value) });
  assert.doesNotMatch(JSON.stringify(progress), new RegExp(secret));
  assert.ok(toolProgressSchema.safeParse(progress).success);
  assert.match(progress.result, /truncated/);
});

test('concurrent and restarted synthesis reuses one receipt; uncertainty never starts a duplicate', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-render-once-'));
  const config = { enabled: true, command: '/bin/echo', playbackCommand: '/bin/echo',
    synthesisTimeoutMs: 1_000, playbackTimeoutMs: 1_000 };
  let started!: () => void;
  let fail!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const release = new Promise<void>((resolve) => { fail = resolve; });
  let calls = 0;
  const runner: ConstructorParameters<typeof SpeechOutput>[2] = async () => {
    calls += 1; started(); await release; throw new Error('backend timed out');
  };
  try {
    const first = new SpeechOutput(config, root, runner).synthesize('same text');
    const rejected = assert.rejects(first, SpeechRenderUncertainError);
    await ready;
    const other = new SpeechOutput(config, root, runner);
    await assert.rejects(other.synthesize('same text'), SpeechRenderUncertainError);
    fail(); await rejected;
    await assert.rejects(new SpeechOutput(config, root, runner).synthesize('same text'), SpeechRenderUncertainError);
    assert.equal(calls, 1);
    const receipts = await other.inspect();
    assert.equal(receipts[0]?.status, 'uncertain');
    const speech = createSpeechTools(other)[0]!;
    assert.ok('invoke' in speech);
    const output = await speech.invoke(new RunContext({}), JSON.stringify({ action: 'synthesize', input: 'same text' }));
    assert.equal((output as { status: string }).status, 'uncertain');
  } finally { fail(); await rm(root, { recursive: true, force: true }); }
});

test('play accepts an existing external audio file and never invokes synthesis', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-existing-audio-'));
  const file = path.join(root, 'prior-recording.m4a');
  await writeFile(file, 'audio fixture');
  const played: string[] = [];
  try {
    const speech = new SpeechOutput({ enabled: true, command: '/bin/echo', playbackCommand: '/bin/echo',
      synthesisTimeoutMs: 1_000, playbackTimeoutMs: 1_000 }, path.join(root, 'renders'),
    async (_command, args) => { assert.equal(args.length, 1); played.push(args[0]!); return { stdout: '', stderr: '' }; });
    await speech.play(file);
    assert.deepEqual(played, [await realpath(file)]);
    await assert.rejects(speech.play(path.join(root, 'missing.wav')));
    assert.deepEqual(played, [await realpath(file)]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('persisted audio does not allow a replaced symlink to escape the render directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-audio-containment-'));
  try {
    const speech = new SpeechOutput({ enabled: true, command: '/bin/echo', playbackCommand: '/bin/echo',
      synthesisTimeoutMs: 1_000, playbackTimeoutMs: 1_000 }, path.join(root, 'renders'),
    async (_command, args) => { await writeFile(args[2]!, 'audio'); return { stdout: '', stderr: '' }; });
    const audio = await speech.synthesize('hello');
    const outside = path.join(root, 'outside.wav'); await writeFile(outside, 'private content');
    await rm(audio.file); await symlink(outside, audio.file);
    await assert.rejects(speech.play(audio.id), /符号链接/);
    assert.equal(await readFile(outside, 'utf8'), 'private content');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a generated resource can be reused by a fresh runtime without synthesis', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-result-reuse-'));
  const config = { enabled: true, command: '/bin/echo', playbackCommand: '/bin/echo',
    synthesisTimeoutMs: 1_000, playbackTimeoutMs: 1_000 };
  let rendered = 0;
  const played: string[] = [];
  const runner: ConstructorParameters<typeof SpeechOutput>[2] = async (_command, args) => {
    if (args.length === 3) { rendered += 1; await writeFile(args[2]!, 'wav-fixture'); }
    else played.push(args[0]!);
    return { stdout: 'engine=chattts', stderr: '' };
  };
  try {
    const original = await new SpeechOutput(config, root, runner).synthesize('already generated');
    const fresh = new SpeechOutput(config, root, runner);
    await fresh.play(original.id);
    assert.equal(rendered, 1);
    assert.deepEqual(played, [original.file]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a damaged render receipt cannot silently reset generation ownership', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-render-corrupt-'));
  try {
    const file = path.join(root, 'renders.json');
    await writeFile(file, '{broken');
    let called = false;
    const speech = new SpeechOutput({ enabled: true, command: '/bin/echo', playbackCommand: '/bin/echo',
      synthesisTimeoutMs: 1_000, playbackTimeoutMs: 1_000 }, root,
    async () => { called = true; return { stdout: '', stderr: '' }; });
    await assert.rejects(speech.synthesize('must not submit'));
    assert.equal(called, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
