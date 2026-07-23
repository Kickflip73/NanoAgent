#!/usr/bin/env node

/**
 * MimiAgent ↔ macOS Shortcuts connector.
 * Uses the system shortcuts CLI without a shell or additional dependencies.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ACTIONS = new Set(['list_shortcuts', 'list_folders', 'run_shortcut']);
const shortcuts = process.env.MACOS_SHORTCUTS_BIN || '/usr/bin/shortcuts';

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
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
  const expanded = expandHome(boundedString(value, label, 4000, true));
  if (!path.isAbsolute(expanded)) throw new Error(`${label} must be an absolute path`);
  return path.normalize(expanded);
}

function inputPaths(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error('payload.inputPaths must contain at most 20 paths');
  return value.map((item, index) => absolutePath(item, `payload.inputPaths[${index}]`));
}

function strictBase64(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('payload.input must be valid padded base64');
  }
  return Buffer.from(value, 'base64');
}

function validate(action, target, rawPayload) {
  if (!ACTIONS.has(action)) throw new Error(`unsupported action: ${String(action)}`);
  boundedString(target, 'target', 1000, true);
  const payload = payloadObject(rawPayload);
  if (action === 'list_shortcuts') {
    return { limit: integer(payload.limit, 'payload.limit', 1, 1000, 500) };
  }
  if (action === 'list_folders') {
    if (!['all', '*'].includes(target)) throw new Error('list_folders target must be all');
    return { limit: integer(payload.limit, 'payload.limit', 1, 1000, 500) };
  }
  const result = {
    inputPaths: inputPaths(payload.inputPaths),
    inputEncoding: payload.inputEncoding ?? 'text',
    outputEncoding: payload.outputEncoding ?? 'text',
    timeoutMs: integer(payload.timeoutMs, 'payload.timeoutMs', 1000, 900_000, 120_000),
    maxOutputBytes: integer(payload.maxOutputBytes, 'payload.maxOutputBytes', 1, 500_000, 100_000),
  };
  if (!['text', 'base64'].includes(result.inputEncoding)) throw new Error('payload.inputEncoding must be text or base64');
  if (!['text', 'base64'].includes(result.outputEncoding)) throw new Error('payload.outputEncoding must be text or base64');
  if (payload.input !== undefined) {
    const input = boundedString(payload.input, 'payload.input', 40_000);
    const data = result.inputEncoding === 'base64' ? strictBase64(input) : Buffer.from(input, 'utf8');
    if (data.byteLength > 40_000) throw new Error('payload.input exceeds 40000 bytes');
    result.input = data;
    const name = payload.inputName ?? (result.inputEncoding === 'text' ? 'input.txt' : 'input.bin');
    result.inputName = boundedString(name, 'payload.inputName', 255, true);
    if (path.basename(result.inputName) !== result.inputName || ['.', '..'].includes(result.inputName)) {
      throw new Error('payload.inputName must be a filename without path separators');
    }
  }
  if (payload.outputPath !== undefined) result.outputPath = absolutePath(payload.outputPath, 'payload.outputPath');
  if (payload.outputType !== undefined) {
    const outputType = boundedString(payload.outputType, 'payload.outputType', 200, true);
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(outputType)) throw new Error('payload.outputType must be a UTI');
    result.outputType = outputType;
  }
  return result;
}

async function runCommand(args, timeoutMs, maxOutputBytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(shortcuts, args, {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxOutputBytes) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`shortcuts timed out after ${timeoutMs}ms`));
      if (overflow) return reject(new Error(`shortcuts output exceeds ${maxOutputBytes} bytes`));
      if (code !== 0) return reject(new Error((stderr || `shortcuts exited code=${code} signal=${signal || 'none'}`).trim()));
      resolve({ stdout: Buffer.concat(chunks), stderr: stderr.trim() });
    });
  });
}

function lines(stdout, limit) {
  const all = stdout.toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return { items: all.slice(0, limit), truncated: all.length > limit };
}

async function execute(message) {
  if (!message || typeof message !== 'object') throw new Error('message must be an object');
  if (typeof message.id !== 'string' || !message.id) throw new Error('message.id is required');
  if (message.type !== 'action') throw new Error(`unsupported message type: ${String(message.type)}`);
  if (typeof message.target !== 'string') throw new Error('action.target is required');
  const payload = validate(message.action, message.target, message.payload);
  if (message.action === 'list_shortcuts') {
    const args = ['list', '--show-identifiers'];
    if (!['all', '*'].includes(message.target)) args.push('--folder-name', message.target);
    const result = await runCommand(args, 30_000, 500_000);
    return { type: 'action_result', id: message.id, ok: true, result: { ...lines(result.stdout, payload.limit), stderr: result.stderr || undefined } };
  }
  if (message.action === 'list_folders') {
    const result = await runCommand(['list', '--folders', '--show-identifiers'], 30_000, 500_000);
    return { type: 'action_result', id: message.id, ok: true, result: { ...lines(result.stdout, payload.limit), stderr: result.stderr || undefined } };
  }

  let temporary;
  try {
    const paths = [...payload.inputPaths];
    if (payload.input) {
      temporary = await mkdtemp(path.join(os.tmpdir(), 'mimi-agent-shortcuts-'));
      const inputPath = path.join(temporary, payload.inputName);
      await writeFile(inputPath, payload.input, { mode: 0o600 });
      paths.unshift(inputPath);
    }
    const args = ['run', message.target];
    for (const inputPath of paths) args.push('--input-path', inputPath);
    if (payload.outputPath) args.push('--output-path', payload.outputPath);
    if (payload.outputType) args.push('--output-type', payload.outputType);
    const command = await runCommand(args, payload.timeoutMs, payload.maxOutputBytes);
    const result = {
      shortcut: message.target,
      outputPath: payload.outputPath,
      outputBytes: command.stdout.byteLength,
      stderr: command.stderr || undefined,
    };
    if (!payload.outputPath) {
      result.outputEncoding = payload.outputEncoding;
      result.output = payload.outputEncoding === 'base64'
        ? command.stdout.toString('base64')
        : command.stdout.toString('utf8');
    }
    return { type: 'action_result', id: message.id, ok: true, result };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > 2_000_000) {
    process.stderr.write('[macos-shortcuts] input exceeded 2MB; resetting buffer\n');
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
