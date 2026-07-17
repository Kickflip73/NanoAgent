#!/usr/bin/env node

/**
 * MimiAgent ↔ 大象 Mac App Connector (AppleScript)
 *
 * 直接用 osascript 操控大象.app，不需要 API Key。
 * stdin: deliver (回复) 或 action/send_message (主动发)
 */

import { spawn } from 'node:child_process';

const DX_APP = '大象';
const TIMEOUT_MS = 15_000;
const OSASCRIPT_BIN = process.env.MIMI_OSASCRIPT_BIN || '/usr/bin/osascript';

function osascript(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(OSASCRIPT_BIN, ['-e', script, '--', ...args], { timeout: TIMEOUT_MS });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `osascript exit ${code}`));
    });
    child.on('error', reject);
  });
}

function textPayload(payload) {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload.text === 'string') return payload.text;
  return JSON.stringify(payload);
}

async function sendMessage(target, text) {
  const separator = target.indexOf(':');
  if (separator < 1) throw new Error('target must be single:<userId> or group:<chatId>');
  const type = target.slice(0, separator);
  const id = target.slice(separator + 1);
  if (!['single', 'group'].includes(type)) throw new Error(`unsupported target type: ${type}`);
  if (!id.trim()) throw new Error('target id is required');

  await osascript(`on run argv
    set recipientId to item 1 of argv
    set messageText to item 2 of argv
    tell application "System Events"
      tell process "${DX_APP}"
        set frontmost to true
        delay 0.3
        -- Cmd+J 打开会话跳转
        keystroke "j" using command down
        delay 0.5
        -- 输入联系人名或群名
        keystroke recipientId
        delay 0.5
        keystroke return
        delay 0.8
        -- 输入消息
        keystroke messageText
        delay 0.3
        -- Enter 发送
        keystroke return
      end tell
    end tell
  end run`, [id, text]);
}

async function healthCheck() {
  const ready = await osascript(`tell application "System Events"
    return (exists process "${DX_APP}") and UI elements enabled
  end tell`);
  return {
    connected: ready === 'true',
    outbound: 'best-effort-ui-automation',
    inbound: false,
    deliveryConfirmed: false,
  };
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

process.stdin.setEncoding('utf8');
let input = '';
let pending = healthCheck().then((status) => {
  emit({
    type: 'status',
    inbound: 'unavailable',
    outbound: status.connected ? 'ready' : 'unavailable',
    deliveryConfirmed: false,
  });
}).catch(() => {
  emit({ type: 'status', inbound: 'unavailable', outbound: 'unavailable', deliveryConfirmed: false });
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  while (input.includes('\n')) {
    const newline = input.indexOf('\n');
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    pending = pending.then(async () => {
      let message;
      try {
        message = JSON.parse(line);
        if (message.type !== 'deliver' && message.type !== 'action') {
          throw new Error(`unsupported message type: ${message.type}`);
        }
        if (message.type === 'action' && !['send_message', 'health_check'].includes(message.action)) {
          throw new Error(`unsupported action: ${message.action}`);
        }
        if (message.type === 'action' && message.action === 'health_check') {
          const status = await healthCheck();
          emit({
            type: 'status', inbound: 'unavailable',
            outbound: status.connected ? 'ready' : 'unavailable', deliveryConfirmed: false,
          });
          emit({ type: 'action_result', id: message.id, ok: true, result: status });
          return;
        }
        const text = textPayload(message.payload).slice(0, 3000);
        await sendMessage(message.target, text);
        const resultType = message.type === 'action' ? 'action_result' : 'delivery_ack';
        emit({ type: resultType, id: message.id, ok: true, ...(message.type === 'action' ? {
          result: { sent: true, transport: 'ui-automation', deliveryConfirmed: false },
        } : {}) });
      } catch (error) {
        const id = message?.id ?? 'invalid';
        const reason = error instanceof Error ? error.message : String(error);
        emit({ type: message?.type === 'action' ? 'action_result' : 'delivery_ack', id, ok: false, error: reason });
      }
    });
  }
});

process.stderr.write('[daxiang-applescript] 大象 AppleScript Connector ready\n');
