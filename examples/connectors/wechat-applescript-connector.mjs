#!/usr/bin/env node

/**
 * MimiAgent ↔ WeChat Mac App Connector (AppleScript)
 *
 * This is an outbound-only fallback for proactive messages to an existing
 * desktop contact. OpenClaw remains the authenticated inbound/reply transport.
 */

import { spawn } from 'node:child_process';

const APP = 'WeChat';
const MAX_OPERATION_MS = 55_000;
const HEALTH_TIMEOUT_MS = 5_000;
const OUTER_DEADLINE_MARGIN_MS = 5_000;
const OSASCRIPT_BIN = process.env.MIMI_OSASCRIPT_BIN || '/usr/bin/osascript';
const activeChildren = new Set();

function operationDeadline(value) {
  const localDeadline = Date.now() + MAX_OPERATION_MS;
  if (typeof value !== 'number' || !Number.isFinite(value)) return localDeadline;
  return Math.min(localDeadline, Math.floor(value) - OUTER_DEADLINE_MARGIN_MS);
}

function osascript(script, args = [], deadlineAt = Date.now() + MAX_OPERATION_MS) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Math.floor(deadlineAt - Date.now());
    if (timeoutMs <= 0) {
      reject(new Error('WeChat operation deadline expired before osascript started'));
      return;
    }
    const child = spawn(OSASCRIPT_BIN, ['-e', script, '--', ...args]);
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const settle = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      operation();
    };
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => settle(() => reject(error)));
    child.once('close', (code) => {
      settle(() => {
        if (timedOut) reject(new Error('WeChat osascript exceeded its transaction deadline and was terminated'));
        else if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || `osascript exit ${code}`));
      });
    });
  });
}

function terminateActiveChildren(exitCode) {
  for (const child of activeChildren) child.kill('SIGKILL');
  process.exit(exitCode);
}

process.once('SIGTERM', () => terminateActiveChildren(143));
process.once('SIGINT', () => terminateActiveChildren(130));

function targetName(target) {
  if (typeof target !== 'string') throw new Error('target must be contact:<name> or conversation:<name>');
  const separator = target.indexOf(':');
  if (separator < 1) throw new Error('target must be contact:<name> or conversation:<name>');
  const type = target.slice(0, separator);
  const name = target.slice(separator + 1).trim();
  if (!['contact', 'conversation'].includes(type)) throw new Error(`unsupported target type: ${type}`);
  if (!name || name.length > 200) throw new Error('target name must contain 1 to 200 characters');
  return name;
}

function textPayload(payload) {
  if (typeof payload === 'string') return payload.trim();
  if (payload && typeof payload.text === 'string') return payload.text.trim();
  return JSON.stringify(payload);
}

function uncertainSendError(message) {
  return Object.assign(new Error(message), { uncertain: true });
}

async function resolveConversation(name, deadlineAt) {
  const output = await osascript(`on run argv
    set recipientName to item 1 of argv
    tell application "${APP}" to activate
    tell application "System Events"
      set appReady to false
      repeat 40 times
        if exists process "${APP}" then
          set appReady to true
          exit repeat
        end if
        delay 0.25
      end repeat
      if appReady is false then error "WeChat did not finish launching"
      tell process "${APP}"
        set frontmost to true
        set windowReady to false
        repeat 40 times
          if exists window 1 then
            set windowReady to true
            exit repeat
          end if
          delay 0.25
        end repeat
        if windowReady is false then error "WeChat main window did not become available"
        keystroke "f" using command down
        set searchElement to missing value
        repeat 40 times
          try
            set candidate to value of attribute "AXFocusedUIElement"
            if role of candidate is "AXTextArea" then
              set searchElement to candidate
              exit repeat
            end if
          end try
          delay 0.25
        end repeat
        if searchElement is missing value then error "WeChat search field did not become available"
        set value of searchElement to recipientName
        delay 1.2
        key code 36
        delay 1.0
        set messageEditor to missing value
        repeat with candidate in entire contents of window 1
          try
            if role of candidate is "AXTextArea" and title of candidate is recipientName then
              set messageEditor to candidate
              exit repeat
            end if
          end try
        end repeat
        if messageEditor is missing value then error "WeChat selected conversation does not exactly match target"
        set value of attribute "AXFocused" of messageEditor to true
        delay 0.2
        set focusedElement to value of attribute "AXFocusedUIElement"
        set focusedRole to role of focusedElement
        set focusedTitle to title of focusedElement
        if focusedRole is not "AXTextArea" then error "WeChat search did not focus a message editor"
        if focusedTitle is not recipientName then error "WeChat selected conversation does not exactly match target"
        return focusedTitle
      end tell
    end tell
  end run`, [name], deadlineAt);
  if (output !== name) throw new Error('WeChat conversation verification failed');
  return { resolved: true, name };
}

async function sendMessage(target, payload, deadlineAt) {
  const name = targetName(target);
  const text = textPayload(payload).slice(0, 3_000);
  if (!text) throw new Error('message text is empty');
  await resolveConversation(name, deadlineAt);
  let output;
  try {
    output = await osascript(`on run argv
    set recipientName to item 1 of argv
    set messageText to item 2 of argv
    tell application "System Events"
      tell process "${APP}"
        set focusedElement to value of attribute "AXFocusedUIElement"
        if role of focusedElement is not "AXTextArea" then error "WeChat message editor lost focus"
        if title of focusedElement is not recipientName then error "WeChat conversation changed before send"
        if (value of focusedElement as text) is not "" then error "WeChat message editor contains an unsent draft"
        set value of focusedElement to messageText
        if (value of focusedElement as text) is not messageText then error "WeChat could not populate the message editor"
        delay 0.2
        key code 36
        set editorCleared to false
        repeat 20 times
          try
            if (value of focusedElement as text) is "" then
              set editorCleared to true
              exit repeat
            end if
          end try
          delay 0.1
        end repeat
        if editorCleared is false then error "WeChat message editor did not clear; send result is uncertain"
        return "sent"
      end tell
    end tell
  end run`, [name, text], deadlineAt);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw uncertainSendError(reason.includes('send result is uncertain')
      ? reason
      : `WeChat send result is uncertain: ${reason}`);
  }
  if (output !== 'sent') throw uncertainSendError('WeChat send result is uncertain');
  return { sent: true, recipient: name, transport: 'ui-automation', deliveryConfirmed: false };
}

async function healthCheck(deadlineAt = Date.now() + HEALTH_TIMEOUT_MS) {
  const state = await osascript(`tell application "System Events"
    set accessibilityReady to UI elements enabled
    set appRunning to (exists process "${APP}")
    return (accessibilityReady as text) & tab & (appRunning as text)
  end tell`, [], deadlineAt);
  const [accessibilityReady, appRunning] = state.toLowerCase().split(/\s+/);
  return {
    connected: appRunning === 'true',
    ready: accessibilityReady === 'true',
    outbound: 'best-effort-ui-automation',
    inbound: false,
    deliveryConfirmed: false,
  };
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

process.stdin.setEncoding('utf8');
let input = '';
let pending = healthCheck().then((status) => {
  emit({
    type: 'status', inbound: 'unavailable',
    outbound: status.ready ? 'ready' : 'unavailable', deliveryConfirmed: false,
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
        if (message.type === 'action' && !['send_message', 'resolve_conversation', 'health_check'].includes(message.action)) {
          throw new Error(`unsupported action: ${message.action}`);
        }
        const deadlineAt = operationDeadline(message.deadlineAt);
        if (message.type === 'action' && message.action === 'health_check') {
          const status = await healthCheck(deadlineAt);
          emit({
            type: 'status', inbound: 'unavailable',
            outbound: status.ready ? 'ready' : 'unavailable', deliveryConfirmed: false,
          });
          emit({ type: 'action_result', id: message.id, ok: true, result: status });
          return;
        }
        if (message.type === 'action' && message.action === 'resolve_conversation') {
          const result = await resolveConversation(targetName(message.target), deadlineAt);
          emit({ type: 'action_result', id: message.id, ok: true, result });
          return;
        }
        const result = await sendMessage(message.target, message.payload, deadlineAt);
        const resultType = message.type === 'action' ? 'action_result' : 'delivery_ack';
        emit({ type: resultType, id: message.id, ok: true, ...(message.type === 'action' ? { result } : {}) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const uncertain = Boolean(error && typeof error === 'object' && error.uncertain === true);
        emit({
          type: message?.type === 'action' ? 'action_result' : 'delivery_ack',
          id: message?.id ?? 'invalid', ok: false,
          ...(uncertain ? { uncertain: true } : {}),
          error: reason.slice(0, 500),
        });
      }
    });
  }
});

process.stderr.write('[wechat-applescript] WeChat AppleScript Connector ready\n');
