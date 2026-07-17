import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface Message {
  type?: string;
  id?: string;
  ok?: boolean;
  externalId?: string;
  replyTarget?: string;
  result?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  error?: string;
}

async function waitFor(messages: Message[], predicate: (message: Message) => boolean, timeoutMs = 10_000): Promise<Message> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`message timed out: ${JSON.stringify(messages)}`);
}

async function waitForLines(file: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean);
      if (lines.length >= count) return lines;
    } catch {
      // The log is created by the mock child.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`log timed out: ${file}`);
}

function loggedArgs(line: string): string[] {
  return line.split('\u001f').filter((item) => item.length > 0);
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

test('macOS voice connector filters wake phrases and runs bounded voice actions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'macos-voice-connector-'));
  const swiftLog = path.join(root, 'swift.jsonl');
  const sayLog = path.join(root, 'say.jsonl');
  const mockSwift = path.join(root, 'mock-swift.sh');
  const mockSay = path.join(root, 'mock-say.sh');
  const listenerState = path.join(root, 'voice-listener.json');
  await writeFile(mockSwift, `#!/bin/sh
log=${JSON.stringify(swiftLog)}
line=$(printf '%s\\037' "$@")
printf '%s\\n' "$line" >> "$log"
if [ "$2" = "listen" ]; then
  printf '%s\\n' '{"type":"ready","locale":"zh-CN","onDevice":false}'
  printf '%s\\n' '{"type":"transcript","text":"普通环境聊天","locale":"zh-CN"}'
  printf '%s\\n' '{"type":"transcript","text":"MimiAgent，检查今天的安排","locale":"zh-CN"}'
  printf '%s\\n' '{"type":"transcript","text":"MimiAgent，检查今天的安排","locale":"zh-CN"}'
  printf '%s\\n' '{"type":"transcript","text":"Mimi: summarize inbox","locale":"zh-CN"}'
  exec /usr/bin/tail -f /dev/null
fi
case "$3" in
  *hang.wav) exec /bin/sleep 10 ;;
  *fail.wav) printf '%s' 'recognizer failed intentionally' >&2; exit 7 ;;
  *invalid.wav) printf '%s' 'not json'; exit 0 ;;
esac
printf '%s\\n' '{"text":"audio transcript","charCount":16,"truncated":false,"locale":"en-US","onDevice":true,"untrusted":true}'
`);
  await writeFile(mockSay, `#!/bin/sh
log=${JSON.stringify(sayLog)}
line=$(printf '%s\\037' "$@")
printf '%s\\n' "$line" >> "$log"
if [ "$1" = "-v" ] && [ "$2" = "?" ]; then
  printf '%s\\n' 'Ting-Ting            zh_CN    # 你好，我叫婷婷。' 'Samantha            en_US    # Hello, my name is Samantha.'
  exit 0
fi
case "$*" in
  *Fail*) printf '%s' 'say failed intentionally' >&2; exit 8 ;;
  *Hang*) exec /bin/sleep 10 ;;
esac
`);
  await Promise.all([chmod(mockSwift, 0o755), chmod(mockSay, 0o755)]);

  const audio = path.join(root, 'meeting $(touch never).wav');
  const invalidAudio = path.join(root, 'invalid.wav');
  const failedAudio = path.join(root, 'fail.wav');
  const hangAudio = path.join(root, 'hang.wav');
  await Promise.all([
    writeFile(audio, 'synthetic audio'),
    writeFile(invalidAudio, 'synthetic audio'),
    writeFile(failedAudio, 'synthetic audio'),
    writeFile(hangAudio, 'synthetic audio'),
  ]);
  const connector = fileURLToPath(new URL('../examples/connectors/macos-voice-connector.mjs', import.meta.url));
  const helper = fileURLToPath(new URL('../examples/connectors/macos-voice-recognizer.swift', import.meta.url));
  const child = spawn(process.execPath, [connector], {
    env: {
      ...process.env,
      MACOS_SWIFT_BIN: mockSwift,
      MACOS_SAY_BIN: mockSay,
      MACOS_VOICE_RECOGNIZER_HELPER: helper,
      MACOS_VOICE_LISTEN: 'true',
      MACOS_VOICE_LOCALE: 'zh-CN',
      MACOS_VOICE_WAKE_PHRASES: 'MimiAgent,Mimi',
      MACOS_VOICE_DUPLICATE_WINDOW_MS: '30000',
      MACOS_VOICE_COMMAND_TIMEOUT_MS: '5000',
      MACOS_VOICE_REPLY_MAX_CHARS: '12',
      MACOS_VOICE_REPLY_RATE: '190',
      MACOS_VOICE_STATE_FILE: listenerState,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: Message[] = [];
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    while (stdout.includes('\n')) {
      const newline = stdout.indexOf('\n');
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) messages.push(JSON.parse(line) as Message);
    }
  });
  const call = async (id: string, action: string, target: string, payload: unknown): Promise<Message> => {
    child.stdin.write(`${JSON.stringify({ type: 'action', id, action, target, payload })}\n`);
    return waitFor(messages, (message) => message.id === id);
  };
  const deliver = async (id: string, target: string, payload: unknown): Promise<Message> => {
    child.stdin.write(`${JSON.stringify({ type: 'deliver', id, target, payload })}\n`);
    return waitFor(messages, (message) => message.id === id);
  };

  try {
    const chinese = await waitFor(messages, (message) => message.payload?.text === '检查今天的安排');
    assert.equal(chinese.type, 'event');
    assert.equal(chinese.payload?.wakePhrase, 'MimiAgent');
    assert.equal(chinese.payload?.untrusted, true);
    assert.equal(chinese.replyTarget, 'default');
    assert.match(chinese.externalId ?? '', /^voice:[0-9a-f]{32}$/);
    const english = await waitFor(messages, (message) => message.payload?.text === 'summarize inbox');
    assert.equal(english.payload?.wakePhrase, 'Mimi');
    assert.equal(messages.filter((message) => message.payload?.text === '检查今天的安排').length, 1);

    const delivered = await deliver('voice-delivery', 'Ting-Ting', { text: '这是一个需要被截断后朗读的较长回答' });
    assert.deepEqual(delivered, { type: 'delivery_ack', id: 'voice-delivery', ok: true });
    const deliveryLines = await waitForLines(sayLog, 1);
    assert.deepEqual(loggedArgs(deliveryLines.at(-1) ?? ''), [
      '-v', 'Ting-Ting', '-r', '190', '这是一个需要被截断后朗读。后续内容已省略。',
    ]);
    const swiftLinesAfterDelivery = await waitForLines(swiftLog, 2);
    assert.equal(loggedArgs(swiftLinesAfterDelivery.at(-1) ?? '')[1], 'listen');

    const invalidDelivery = await deliver('invalid-delivery', 'default', {});
    assert.equal(invalidDelivery.type, 'delivery_ack');
    assert.equal(invalidDelivery.ok, false);
    assert.match(invalidDelivery.error ?? '', /payload.text/);
    assert.equal(messages.some((message) => message.payload?.text === '普通环境聊天'), false);

    const status = await call('status', 'listener_status', 'listener', {});
    assert.equal(status.result?.desired, true);
    assert.equal(status.result?.running, true);
    assert.equal(status.result?.ready, true);

    const voices = await call('voices', 'list_voices', 'all', { limit: 1 });
    assert.deepEqual(voices.result?.voices, [{ name: 'Ting-Ting', locale: 'zh_CN', sample: '你好，我叫婷婷。' }]);
    assert.equal(voices.result?.total, 2);
    assert.equal(voices.result?.truncated, true);

    const hostileSpeech = '完成了; $(touch /tmp/voice-never-runs)';
    const spoken = await call('speak', 'speak', 'Samantha', { text: hostileSpeech, rate: 210 });
    assert.deepEqual(spoken.result, { spoken: true, voice: 'Samantha', rate: 210, charCount: hostileSpeech.length });
    const sayLines = await waitForLines(sayLog, 2);
    assert.deepEqual(loggedArgs(sayLines.at(-1) ?? ''), ['-v', 'Samantha', '-r', '210', hostileSpeech]);
    const swiftLinesAfterSpeak = await waitForLines(swiftLog, 2);
    assert.equal(loggedArgs(swiftLinesAfterSpeak.at(-1) ?? '')[1], 'listen');
    assert.equal(messages.filter((message) => message.payload?.text === '检查今天的安排').length, 1);

    const transcript = await call('transcribe', 'transcribe_audio', audio, {
      locale: 'en-US', onDevice: true, maxChars: 123, timeoutMs: 4000,
    });
    assert.equal(transcript.result?.text, 'audio transcript');
    assert.equal(transcript.result?.audioPath, audio);
    assert.equal(transcript.result?.untrusted, true);
    const swiftLines = await waitForLines(swiftLog, 3);
    const transcribeArgs = swiftLines.map(loggedArgs).find((args) => args[1] === 'transcribe' && args[2] === audio);
    assert.ok(transcribeArgs, `transcribe command was not logged: ${JSON.stringify(swiftLines)}`);
    assert.deepEqual(transcribeArgs.slice(0, 7), [helper, 'transcribe', audio, 'en-US', 'true', '4', '123']);

    const stopped = await call('stop', 'listener_stop', 'listener', {});
    assert.equal(stopped.result?.desired, false);
    assert.equal(stopped.result?.running, false);
    assert.deepEqual(JSON.parse(await readFile(listenerState, 'utf8')), { listenerDesired: false });
    const started = await call('start', 'listener_start', 'listener', {});
    assert.equal(started.result?.desired, true);
    assert.equal(started.result?.running, true);
    assert.deepEqual(JSON.parse(await readFile(listenerState, 'utf8')), { listenerDesired: true });
    assert.equal((await stat(listenerState)).mode & 0o777, 0o600);
    const restarted = await call('restart', 'listener_restart', 'listener', {});
    assert.equal(restarted.result?.desired, true);
    assert.equal(restarted.result?.running, true);

    const relative = await call('relative', 'transcribe_audio', 'relative.wav', {});
    assert.equal(relative.ok, false);
    assert.match(relative.error ?? '', /absolute path/);
    const badBoolean = await call('boolean', 'transcribe_audio', audio, { onDevice: 'yes' });
    assert.equal(badBoolean.ok, false);
    assert.match(badBoolean.error ?? '', /must be a boolean/);
    const badTarget = await call('target', 'listener_stop', 'microphone', {});
    assert.equal(badTarget.ok, false);
    assert.match(badTarget.error ?? '', /target must be listener/);
    const invalid = await call('invalid', 'transcribe_audio', invalidAudio, {});
    assert.equal(invalid.ok, false);
    assert.match(invalid.error ?? '', /invalid JSON/);
    const failed = await call('failed', 'transcribe_audio', failedAudio, {});
    assert.equal(failed.ok, false);
    assert.match(failed.error ?? '', /failed intentionally/);
    const sayFailed = await call('say-failed', 'speak', 'Fail', { text: 'x' });
    assert.equal(sayFailed.ok, false);
    assert.match(sayFailed.error ?? '', /say failed intentionally/);
    const timedOut = await call('timeout', 'speak', 'Hang', { text: 'x', timeoutMs: 100 });
    assert.equal(timedOut.ok, false);
    assert.match(timedOut.error ?? '', /timed out after 100ms/);
    const unknown = await call('unknown', 'record_forever', 'listener', {});
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? '', /unsupported action/);
  } finally {
    await stop(child);
  }
});

test('macOS voice connector restores the persisted listener choice across process restarts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'macos-voice-persistence-'));
  const listenerState = path.join(root, 'voice-listener.json');
  const swift = path.join(root, 'mock-swift.sh');
  await writeFile(swift, `#!/bin/sh
if [ "$2" = "listen" ]; then
  printf '%s\\n' '{"type":"ready","locale":"zh-CN","onDevice":false}'
  exec /usr/bin/tail -f /dev/null
fi
`);
  await chmod(swift, 0o755);
  const connector = fileURLToPath(new URL('../examples/connectors/macos-voice-connector.mjs', import.meta.url));

  const launch = (environmentListen: boolean) => {
    const child = spawn(process.execPath, [connector], {
      env: {
        ...process.env,
        MACOS_SWIFT_BIN: swift,
        MACOS_SAY_BIN: '/usr/bin/true',
        MACOS_VOICE_RECOGNIZER_HELPER: path.join(root, 'unused.swift'),
        MACOS_VOICE_LISTEN: String(environmentListen),
        MACOS_VOICE_STATE_FILE: listenerState,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const messages: Message[] = [];
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      while (stdout.includes('\n')) {
        const newline = stdout.indexOf('\n');
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line) messages.push(JSON.parse(line) as Message);
      }
    });
    const call = async (id: string, action: string): Promise<Message> => {
      child.stdin.write(`${JSON.stringify({ type: 'action', id, action, target: 'listener', payload: {} })}\n`);
      return waitFor(messages, (message) => message.id === id);
    };
    return { child, call };
  };

  await writeFile(listenerState, '{"listenerDesired":true}\n', { mode: 0o600 });
  const first = launch(false);
  try {
    const status = await first.call('first-status', 'listener_status');
    assert.equal(status.result?.desired, true);
    assert.equal(status.result?.running, true);
    const stopped = await first.call('persist-stop', 'listener_stop');
    assert.equal(stopped.result?.desired, false);
  } finally {
    await stop(first.child);
  }

  const second = launch(true);
  try {
    const status = await second.call('second-status', 'listener_status');
    assert.equal(status.result?.desired, false);
    assert.equal(status.result?.running, false);
    assert.equal(status.result?.ready, false);
  } finally {
    await stop(second.child);
  }
});
