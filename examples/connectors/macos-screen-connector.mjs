#!/usr/bin/env node

/**
 * MimiAgent ↔ macOS screen connector.
 * Uses screencapture and the system Vision framework without a shell or npm dependencies.
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ACTIONS = new Set(['capture_screen', 'ocr_image', 'read_screen']);
const screencapture = process.env.MACOS_SCREENCAPTURE_BIN || '/usr/sbin/screencapture';
const swift = process.env.MACOS_SWIFT_BIN || '/usr/bin/swift';
const ocrHelper = process.env.MACOS_SCREEN_OCR_HELPER
  || fileURLToPath(new URL('./macos-screen-ocr.swift', import.meta.url));
const commandTimeoutMs = numberEnv('MACOS_SCREEN_COMMAND_TIMEOUT_MS', 60_000, 100, 300_000);

function numberEnv(name, fallback, minimum, maximum) {
  if (process.env[name] === undefined || process.env[name] === '') return fallback;
  const value = Number(process.env[name]);
  if (Number.isInteger(value) && value >= minimum && value <= maximum) return value;
  process.stderr.write(`[macos-screen] invalid ${name}; using ${fallback}\n`);
  return fallback;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function payloadObject(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('payload must be an object');
  return value;
}

function boundedString(value, label, maximum, required = false) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > maximum) {
    throw new Error(`${label} must be ${required ? 'a non-empty ' : 'a '}string with at most ${maximum} characters`);
  }
  return value;
}

function integer(value, label, minimum, maximum, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function absolutePath(value, label) {
  const expanded = expandHome(boundedString(value, label, 4_000, true));
  if (!path.isAbsolute(expanded)) throw new Error(`${label} must be an absolute path`);
  return path.normalize(expanded);
}

function captureTarget(value) {
  if (value === 'main') return { target: value, args: ['-m'] };
  let match = /^display:([1-9]\d{0,3})$/.exec(value);
  if (match) return { target: value, args: [`-D${match[1]}`] };
  match = /^window:([1-9]\d{0,15})$/.exec(value);
  if (match) return { target: value, args: [`-l${match[1]}`] };
  match = /^rect:(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(value);
  if (match) {
    const values = match.slice(1).map(Number);
    const [x, y, width, height] = values;
    if (Math.abs(x) <= 100_000 && Math.abs(y) <= 100_000 && width >= 1 && width <= 100_000 && height >= 1 && height <= 100_000) {
      return { target: value, args: [`-R${x},${y},${width},${height}`] };
    }
  }
  throw new Error('target must be main, display:N, window:ID, or rect:X,Y,W,H');
}

function languages(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) throw new Error('payload.languages must contain at most 10 language tags');
  return [...new Set(value.map((item, index) => {
    const language = boundedString(item, `payload.languages[${index}]`, 35, true);
    if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language)) throw new Error(`invalid language tag: ${language}`);
    return language;
  }))];
}

function ocrOptions(payload) {
  const recognitionLevel = payload.recognitionLevel ?? 'accurate';
  if (!['fast', 'accurate'].includes(recognitionLevel)) throw new Error('payload.recognitionLevel must be fast or accurate');
  return {
    maxChars: integer(payload.maxChars, 'payload.maxChars', 1, 200_000, 40_000),
    maxLines: integer(payload.maxLines, 'payload.maxLines', 1, 2_000, 500),
    maxImageBytes: integer(payload.maxImageBytes, 'payload.maxImageBytes', 1, 100_000_000, 50_000_000),
    timeoutMs: integer(payload.timeoutMs, 'payload.timeoutMs', 100, 300_000, commandTimeoutMs),
    recognitionLevel,
    languages: languages(payload.languages),
  };
}

function captureOptions(payload) {
  return {
    includeCursor: payload.includeCursor === true,
    excludeShadow: payload.excludeShadow !== false,
    timeoutMs: integer(payload.timeoutMs, 'payload.timeoutMs', 100, 300_000, commandTimeoutMs),
  };
}

function validate(action, target, rawPayload) {
  if (!ACTIONS.has(action)) throw new Error(`unsupported action: ${String(action)}`);
  const payload = payloadObject(rawPayload);
  if (action === 'ocr_image') {
    return { imagePath: absolutePath(target, 'target'), ...ocrOptions(payload) };
  }
  const capture = captureTarget(target);
  if (action === 'capture_screen') {
    const outputPath = absolutePath(payload.outputPath, 'payload.outputPath');
    if (path.extname(outputPath).toLowerCase() !== '.png') throw new Error('payload.outputPath must end with .png');
    return { capture, outputPath, ...captureOptions(payload), maxImageBytes: integer(payload.maxImageBytes, 'payload.maxImageBytes', 1, 100_000_000, 50_000_000) };
  }
  return { capture, ...captureOptions(payload), ...ocrOptions(payload) };
}

function runCommand(command, args, timeoutMs, maxOutputBytes, captureOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR },
      stdio: ['ignore', captureOutput ? 'pipe' : 'ignore', 'pipe'],
    });
    const chunks = [];
    let outputBytes = 0;
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    if (captureOutput) {
      child.stdout.on('data', (chunk) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > maxOutputBytes) { overflow = true; child.kill('SIGKILL'); return; }
        chunks.push(chunk);
      });
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`command timed out after ${timeoutMs}ms`));
      if (overflow) return reject(new Error(`command output exceeds ${maxOutputBytes} bytes`));
      if (code !== 0) return reject(new Error((stderr || `command exited code=${code} signal=${signal || 'none'}`).trim()));
      resolve(Buffer.concat(chunks));
    });
  });
}

async function checkedImage(imagePath, maxImageBytes) {
  const info = await stat(imagePath);
  if (!info.isFile()) throw new Error('image path must be a regular file');
  if (info.size < 1) throw new Error('captured image is empty');
  if (info.size > maxImageBytes) throw new Error(`image exceeds ${maxImageBytes} bytes`);
  return info.size;
}

async function captureImage(options, outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const args = ['-x', '-t', 'png', ...options.capture.args];
  if (options.includeCursor) args.push('-C');
  if (options.excludeShadow && options.capture.target.startsWith('window:')) args.push('-o');
  args.push(outputPath);
  await runCommand(screencapture, args, options.timeoutMs, 0, false);
  try {
    return await checkedImage(outputPath, options.maxImageBytes);
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }
}

async function recognize(imagePath, options) {
  const imageBytes = await checkedImage(imagePath, options.maxImageBytes);
  const output = await runCommand(swift, [
    ocrHelper,
    imagePath,
    String(options.maxChars),
    String(options.maxLines),
    options.recognitionLevel,
    options.languages.join(','),
  ], options.timeoutMs, 1_000_000, true);
  let result;
  try { result = JSON.parse(output.toString('utf8')); }
  catch { throw new Error(`Vision helper returned invalid JSON: ${output.toString('utf8', 0, 500)}`); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Vision helper result must be an object');
  return { ...result, imageBytes, untrusted: true };
}

async function execute(message) {
  if (!message || typeof message !== 'object') throw new Error('message must be an object');
  if (typeof message.id !== 'string' || !message.id) throw new Error('message.id is required');
  if (message.type !== 'action') throw new Error(`unsupported message type: ${String(message.type)}`);
  if (typeof message.target !== 'string') throw new Error('action.target is required');
  const options = validate(message.action, message.target, message.payload);
  if (message.action === 'capture_screen') {
    const imageBytes = await captureImage(options, options.outputPath);
    return { type: 'action_result', id: message.id, ok: true, result: { captured: true, target: options.capture.target, path: options.outputPath, imageBytes } };
  }
  if (message.action === 'ocr_image') {
    const result = await recognize(options.imagePath, options);
    return { type: 'action_result', id: message.id, ok: true, result: { ...result, imagePath: options.imagePath } };
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mimi-agent-screen-'));
  const imagePath = path.join(temporary, 'capture.png');
  try {
    const capturedBytes = await captureImage(options, imagePath);
    const result = await recognize(imagePath, options);
    return { type: 'action_result', id: message.id, ok: true, result: { ...result, target: options.capture.target, capturedBytes } };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > 1_000_000) {
    process.stderr.write('[macos-screen] input exceeded 1MB; resetting buffer\n');
    input = '';
    return;
  }
  while (input.includes('\n')) {
    const newline = input.indexOf('\n');
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    void (async () => {
      let message;
      try {
        message = JSON.parse(line);
        write(await execute(message));
      } catch (error) {
        write({ type: 'action_result', id: message?.id ?? 'invalid', ok: false, error: errorText(error) });
      }
    })();
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(0));
