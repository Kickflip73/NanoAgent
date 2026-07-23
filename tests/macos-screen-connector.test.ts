import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface Message {
  id?: string;
  ok?: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

async function waitFor(messages: Message[], id: string, timeoutMs = 8_000): Promise<Message> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find((message) => message.id === id);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`message timed out: ${JSON.stringify(messages)}`);
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

test('macOS screen connector captures and OCRs bounded images with argv-only commands', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'macos-screen-connector-'));
  const captureLog = path.join(root, 'capture-log.json');
  const ocrLog = path.join(root, 'ocr-log.json');
  const mockCapture = path.join(root, 'mock-screencapture.mjs');
  const mockSwift = path.join(root, 'mock-swift.mjs');
  await writeFile(mockCapture, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const output = args.at(-1);
writeFileSync(${JSON.stringify(captureLog)}, JSON.stringify(args));
if (args.includes('-l999')) setTimeout(() => {}, 10000);
else if (args.includes('-l998')) { process.stderr.write('capture failed intentionally'); process.exit(7); }
else if (args.includes('-l997')) writeFileSync(output, Buffer.alloc(1000, 1));
else if (args.includes('-l996')) writeFileSync(output, 'ocrhang');
else if (args.includes('-l995')) writeFileSync(output, 'badjson');
else writeFileSync(output, 'synthetic-image:' + JSON.stringify(args));
`);
  await writeFile(mockSwift, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const [helper, imagePath, maxChars, maxLines, level, languages] = process.argv.slice(2);
const image = readFileSync(imagePath, 'utf8');
writeFileSync(${JSON.stringify(ocrLog)}, JSON.stringify({ helper, imagePath, maxChars, maxLines, level, languages }));
if (image === 'ocrhang') setTimeout(() => {}, 10000);
else if (image === 'badjson') process.stdout.write('not json');
else process.stdout.write(JSON.stringify({
  text: 'synthetic recognized text'.slice(0, Number(maxChars)),
  charCount: 25,
  truncated: Number(maxChars) < 25,
  lines: [{ text: 'synthetic recognized text', confidence: 0.99, boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }].slice(0, Number(maxLines)),
  lineCount: 1,
  linesTruncated: false,
  recognitionLevel: level,
  recognitionLanguages: languages ? languages.split(',') : [],
  untrusted: true
}));
`);
  await Promise.all([chmod(mockCapture, 0o755), chmod(mockSwift, 0o755)]);

  const existingImage = path.join(root, 'existing.png');
  await writeFile(existingImage, 'existing synthetic image');
  const connector = fileURLToPath(new URL('../examples/connectors/macos-screen-connector.mjs', import.meta.url));
  const helper = fileURLToPath(new URL('../examples/connectors/macos-screen-ocr.swift', import.meta.url));
  const child = spawn(process.execPath, [connector], {
    env: {
      ...process.env,
      MACOS_SCREENCAPTURE_BIN: mockCapture,
      MACOS_SWIFT_BIN: mockSwift,
      MACOS_SCREEN_OCR_HELPER: helper,
      MACOS_SCREEN_COMMAND_TIMEOUT_MS: '10000',
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
    return waitFor(messages, id);
  };

  try {
    const hostileOutput = path.join(root, 'captures', 'screen $(touch never).png');
    const captured = await call('capture', 'capture_screen', 'window:42', {
      outputPath: hostileOutput, includeCursor: true, excludeShadow: true,
    });
    assert.equal(captured.ok, true, captured.error);
    assert.equal(captured.result?.path, hostileOutput);
    assert.ok(Number(captured.result?.imageBytes) > 0);
    assert.deepEqual(JSON.parse(await readFile(captureLog, 'utf8')), [
      '-x', '-t', 'png', '-l42', '-C', '-o', hostileOutput,
    ]);

    const ocr = await call('ocr', 'ocr_image', existingImage, {
      maxChars: 9, maxLines: 7, recognitionLevel: 'fast', languages: ['zh-Hans', 'en-US', 'zh-Hans'],
    });
    assert.equal(ocr.ok, true, ocr.error);
    assert.equal(ocr.result?.text, 'synthetic');
    assert.equal(ocr.result?.truncated, true);
    assert.equal(ocr.result?.untrusted, true);
    assert.equal(ocr.result?.imagePath, existingImage);
    assert.deepEqual(JSON.parse(await readFile(ocrLog, 'utf8')), {
      helper, imagePath: existingImage, maxChars: '9', maxLines: '7', level: 'fast', languages: 'zh-Hans,en-US',
    });

    const read = await call('read', 'read_screen', 'rect:-10,20,300,400', {
      maxChars: 100, maxLines: 5,
    });
    assert.equal(read.ok, true, read.error);
    assert.equal(read.result?.target, 'rect:-10,20,300,400');
    assert.equal(read.result?.text, 'synthetic recognized text');
    assert.equal(read.result?.untrusted, true);
    const temporaryImage = (JSON.parse(await readFile(ocrLog, 'utf8')) as { imagePath: string }).imagePath;
    await assert.rejects(access(temporaryImage), /ENOENT/);
    assert.deepEqual(JSON.parse(await readFile(captureLog, 'utf8')), [
      '-x', '-t', 'png', '-R-10,20,300,400', temporaryImage,
    ]);

    const badTarget = await call('bad-target', 'read_screen', 'all', {});
    assert.equal(badTarget.ok, false);
    assert.match(badTarget.error ?? '', /target must be main/);
    const relative = await call('relative', 'ocr_image', 'relative.png', {});
    assert.equal(relative.ok, false);
    assert.match(relative.error ?? '', /absolute path/);
    const badExtension = await call('extension', 'capture_screen', 'main', { outputPath: path.join(root, 'screen.jpg') });
    assert.equal(badExtension.ok, false);
    assert.match(badExtension.error ?? '', /end with .png/);
    const badLanguage = await call('language', 'ocr_image', existingImage, { languages: ['not a tag'] });
    assert.equal(badLanguage.ok, false);
    assert.match(badLanguage.error ?? '', /invalid language tag/);
    const tooLarge = await call('large', 'read_screen', 'window:997', { maxImageBytes: 100 });
    assert.equal(tooLarge.ok, false);
    assert.match(tooLarge.error ?? '', /image exceeds 100 bytes/);
    const failed = await call('failure', 'read_screen', 'window:998', {});
    assert.equal(failed.ok, false);
    assert.match(failed.error ?? '', /capture failed intentionally/);
    const invalidJson = await call('invalid-json', 'read_screen', 'window:995', {});
    assert.equal(invalidJson.ok, false);
    assert.match(invalidJson.error ?? '', /invalid JSON/);
    const timeout = await call('timeout', 'read_screen', 'window:996', { timeoutMs: 1000 });
    assert.equal(timeout.ok, false);
    assert.match(timeout.error ?? '', /timed out after 1000ms/);
    const timedOutImage = (JSON.parse(await readFile(ocrLog, 'utf8')) as { imagePath: string }).imagePath;
    await assert.rejects(access(timedOutImage), /ENOENT/);
    const unknown = await call('unknown', 'record_screen', 'main', {});
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? '', /unsupported action/);
  } finally {
    await stop(child);
  }
});
