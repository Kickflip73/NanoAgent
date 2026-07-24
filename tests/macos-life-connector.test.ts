import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface ProtocolMessage {
  type: string;
  id?: string;
  ok?: boolean;
  externalId?: string;
  result?: Record<string, unknown>;
  error?: string;
  priority?: number;
  payload?: Record<string, unknown>;
}

async function waitFor(
  messages: ProtocolMessage[],
  predicate: (message: ProtocolMessage) => boolean,
  timeoutMs = 5_000,
): Promise<ProtocolMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = messages.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`protocol message timed out: ${JSON.stringify(messages)}`);
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

test('macOS life connector executes actions without shell interpolation and emits proactive events', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'macos-life-connector-'));
  const mock = path.join(root, 'mock-platform-helper.mjs');
  await writeFile(mock, `#!/usr/bin/env node
const marker = process.argv.indexOf('-e');
if (marker >= 0) {
  process.stdout.write(JSON.stringify({ notified: true }));
  process.exit(0);
}
const args = process.argv.slice(2);
if (args[0] === 'poll') {
  process.stdout.write(JSON.stringify({
    calendar: [{ id: 'event-1', calendar: 'Work', title: 'Standup', startAt: '2026-07-15T10:00:00.000Z', endAt: '2026-07-15T11:00:00.000Z' }],
    reminders: [{ id: 'reminder-1', list: 'Inbox', title: 'Buy milk', dueAt: '2026-07-15T09:00:00.000Z' }]
  }));
} else {
  process.stdout.write(JSON.stringify({ action: args[0], target: args[1], payload: JSON.parse(args[2] || '{}') }));
}
`);
  await chmod(mock, 0o755);
  const connector = fileURLToPath(new URL('../examples/connectors/macos-life-connector.mjs', import.meta.url));
  const child = spawn(process.execPath, [connector], {
    env: {
      ...process.env,
      MACOS_OSASCRIPT: mock,
      MACOS_LIFE_EVENTKIT_COMMAND: mock,
      MACOS_LIFE_EVENTKIT_HELPER: path.join(root, 'eventkit-helper.swift'),
      MACOS_POLL_INTERVAL_MS: '1000',
      MACOS_LOOKAHEAD_MINUTES: '30',
      MACOS_LIFE_STATE_FILE: path.join(root, 'life-state.json'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: ProtocolMessage[] = [];
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    while (stdout.includes('\n')) {
      const newline = stdout.indexOf('\n');
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) messages.push(JSON.parse(line) as ProtocolMessage);
    }
  });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  try {
    const calendarEvent = await waitFor(messages, (message) => message.payload?.type === 'calendar_upcoming');
    const reminderEvent = await waitFor(messages, (message) => (
      message.payload?.type === 'reminder_due' || message.payload?.type === 'reminder_overdue'
    ));
    assert.equal(calendarEvent.type, 'event');
    assert.equal(calendarEvent.payload?.suggestedFollowUpAt, '2026-07-15T11:05:00.000Z');
    assert.equal(reminderEvent.type, 'event');

    const hostileTitle = 'Review "Q3"; $(touch /tmp/never-run)';
    child.stdin.write(`${JSON.stringify({
      type: 'action', id: 'action-1', action: 'calendar_create', target: 'Work',
      payload: { title: hostileTitle, start: '2026-07-16T09:00:00.000Z' },
    })}\n`);
    const action = await waitFor(messages, (message) => message.id === 'action-1');
    assert.equal(action.type, 'action_result');
    assert.equal(action.ok, true);
    assert.equal(action.result?.action, 'calendar_create');
    assert.equal((action.result?.payload as Record<string, unknown>).title, hostileTitle);

    for (const [index, request] of [
      { action: 'calendar_update', target: 'event-1', payload: { calendar: 'Work', title: hostileTitle } },
      { action: 'calendar_delete', target: 'event-1', payload: { calendar: 'Work' } },
      { action: 'reminder_update', target: 'reminder-1', payload: { list: 'Inbox', completed: false } },
      { action: 'reminder_delete', target: 'reminder-1', payload: { list: 'Inbox' } },
    ].entries()) {
      const id = `lifecycle-${index}`;
      child.stdin.write(`${JSON.stringify({ type: 'action', id, ...request })}\n`);
      const response = await waitFor(messages, (message) => message.id === id);
      assert.equal(response.ok, true);
      assert.equal(response.result?.action, request.action);
      assert.deepEqual(response.result?.payload, request.payload);
    }

    child.stdin.write(`${JSON.stringify({ type: 'deliver', id: 'delivery-1', target: 'MimiAgent', payload: { text: 'Done' } })}\n`);
    const delivery = await waitFor(messages, (message) => message.id === 'delivery-1');
    assert.deepEqual(delivery, { type: 'delivery_ack', id: 'delivery-1', ok: true });

    child.stdin.write(`${JSON.stringify({ type: 'action', id: 'action-2', action: 'erase_disk', target: 'x', payload: {} })}\n`);
    const rejected = await waitFor(messages, (message) => message.id === 'action-2');
    assert.equal(rejected.ok, false);
    assert.match(rejected.error ?? '', /unsupported action/);
    assert.equal(stderr, '');
  } finally {
    await stop(child);
  }
});

test('macOS life connector persists a bounded baseline and emits changed or deleted items once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'macos-life-changes-'));
  const mock = path.join(root, 'mock-eventkit-helper.mjs');
  const counter = path.join(root, 'poll-count');
  const dueFile = path.join(root, 'due-at');
  const state = path.join(root, 'life-state.json');
  await writeFile(mock, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] !== 'poll') {
  process.stdout.write('{}');
  process.exit(0);
}
const counter = ${JSON.stringify(counter)};
const dueFile = ${JSON.stringify(dueFile)};
let count = 0;
try { count = Number(fs.readFileSync(counter, 'utf8')); } catch {}
fs.writeFileSync(counter, String(count + 1));
let dueAt;
try { dueAt = fs.readFileSync(dueFile, 'utf8'); } catch { dueAt = new Date(Date.now() + 1000).toISOString(); fs.writeFileSync(dueFile, dueAt); }
const changed = { id: 'event-1', calendar: 'Work', title: count ? 'Planning moved' : 'Planning', startAt: '2099-07-15T10:00:00.000Z', endAt: '2099-07-15T11:00:00.000Z', location: count ? 'Room B' : 'Room A' };
const crossing = { id: 'reminder-2', list: 'Inbox', title: 'Cross deadline', dueAt, completed: false, priority: 5, flagged: false, notes: '' };
process.stdout.write(JSON.stringify(count === 0 ? {
  calendar: [changed],
  reminders: [{ id: 'reminder-1', list: 'Inbox', title: 'Submit report', dueAt: '2099-07-15T09:00:00.000Z', completed: false, priority: 5, flagged: true, notes: '' }, crossing],
  knownCalendar: [], knownReminders: []
} : {
  calendar: [changed], reminders: [crossing], knownCalendar: [changed], knownReminders: [crossing]
}));
`);
  await chmod(mock, 0o755);
  const connector = fileURLToPath(new URL('../examples/connectors/macos-life-connector.mjs', import.meta.url));
  const child = spawn(process.execPath, [connector], {
    env: {
      ...process.env,
      MACOS_LIFE_EVENTKIT_COMMAND: mock,
      MACOS_LIFE_EVENTKIT_HELPER: path.join(root, 'eventkit-helper.swift'),
      MACOS_POLL_INTERVAL_MS: '100',
      MACOS_LOOKAHEAD_MINUTES: '10080',
      MACOS_LIFE_STATE_FILE: state,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: ProtocolMessage[] = [];
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    while (stdout.includes('\n')) {
      const newline = stdout.indexOf('\n');
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) messages.push(JSON.parse(line) as ProtocolMessage);
    }
  });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  try {
    await waitFor(messages, (message) => message.payload?.type === 'calendar_upcoming');
    const changed = await waitFor(messages, (message) => message.payload?.type === 'calendar_changed');
    const deleted = await waitFor(messages, (message) => message.payload?.type === 'reminder_deleted');
    const due = await waitFor(messages, (message) => (
      message.payload?.type === 'reminder_due' && message.payload?.id === 'reminder-2'
    ));
    const overdue = await waitFor(messages, (message) => (
      message.payload?.type === 'reminder_overdue' && message.payload?.id === 'reminder-2'
    ));
    assert.equal((changed.payload?.current as Record<string, unknown>).location, 'Room B');
    assert.equal((changed.payload?.previous as Record<string, unknown>).location, 'Room A');
    assert.equal((deleted.payload?.previous as Record<string, unknown>).id, 'reminder-1');
    assert.equal(due.priority, 85);
    assert.equal(overdue.priority, 95);
    assert.equal((await stat(state)).mode & 0o777, 0o600);
    const persisted = JSON.parse(await readFile(state, 'utf8')) as { calendar: unknown[]; reminders: unknown[] };
    assert.equal(persisted.calendar.length, 1);
    assert.equal(persisted.reminders.length, 1);
    assert.equal(stderr, '');
  } finally {
    await stop(child);
  }
});

type ScriptValues = Record<string, unknown>;
type ScriptObject = Record<string, unknown>;

function scripted(values: ScriptValues): ScriptObject {
  const result: ScriptObject = {};
  for (const key of Object.keys(values)) {
    Object.defineProperty(result, key, {
      configurable: true,
      get: () => () => values[key],
      set: (value: unknown) => { values[key] = value; },
    });
  }
  return result;
}

function collection<T extends ScriptObject>(items: T[]): (() => T[]) & {
  byName: (name: string) => T;
  push: (item: T) => number;
} {
  const result = (() => items) as (() => T[]) & {
    byName: (name: string) => T;
    push: (item: T) => number;
  };
  result.byName = (name: string) => items.find((item) => {
    const readName = item.name;
    return typeof readName === 'function' && readName() === name;
  }) ?? ({ exists: () => false } as unknown as T);
  result.push = (item: T) => items.push(item);
  return result;
}

test('life JXA lifecycle actions mutate only stable ids and reject invalid changes', async () => {
  const connector = fileURLToPath(new URL('../examples/connectors/macos-life-connector.mjs', import.meta.url));
  const source = await readFile(connector, 'utf8');
  const scriptMatch = /const ACTION_SCRIPT = String\.raw`([\s\S]*?)`;\n\nconst POLL_SCRIPT/.exec(source);
  assert.ok(scriptMatch?.[1]);

  const eventValues: ScriptValues = {
    uid: 'event-1', summary: 'Standup', startDate: new Date('2026-07-15T10:00:00.000Z'),
    endDate: new Date('2026-07-15T10:30:00.000Z'), alldayEvent: false, location: 'Room A', description: 'Daily',
  };
  const event = scripted(eventValues);
  const calendar = scripted({ name: 'Work' });
  calendar.exists = () => true;
  calendar.events = collection([event]);
  const deletedCalendarItems: unknown[] = [];
  const calendarApp: ScriptObject = {
    calendars: collection([calendar]),
    delete: (item: unknown) => { deletedCalendarItems.push(item); },
  };

  const reminderValues: ScriptValues = {
    id: 'reminder-1', name: 'Buy milk', dueDate: new Date('2026-07-15T09:00:00.000Z'),
    completed: false, priority: 5, flagged: false, body: 'Two cartons',
  };
  const reminder = scripted(reminderValues);
  const list = scripted({ name: 'Inbox' });
  list.exists = () => true;
  list.reminders = collection([reminder]);
  const deletedReminderItems: unknown[] = [];
  const reminderApp: ScriptObject = {
    lists: collection([list]),
    delete: (item: unknown) => { deletedReminderItems.push(item); },
  };

  const Application = (name: string): ScriptObject => name === 'Calendar' ? calendarApp : reminderApp;
  const factory = new Function('Application', `${scriptMatch[1]}; return run;`) as (
    application: typeof Application,
  ) => (argv: string[]) => string;
  const run = factory(Application);

  const updatedEvent = JSON.parse(run([
    'calendar_update', 'event-1', JSON.stringify({
      calendar: 'Work', title: 'Planning', start: '2026-07-16T12:00:00.000Z',
      end: '2026-07-16T13:00:00.000Z', location: '', notes: 'Moved', allDay: false,
    }),
  ])) as { updated: boolean; event: Record<string, unknown> };
  assert.equal(updatedEvent.updated, true);
  assert.deepEqual(updatedEvent.event, {
    id: 'event-1', calendar: 'Work', title: 'Planning', startAt: '2026-07-16T12:00:00.000Z',
    endAt: '2026-07-16T13:00:00.000Z', allDay: false, location: '', notes: 'Moved',
  });
  assert.throws(() => run(['calendar_update', 'event-1', '{}']), /at least one mutable field/);
  assert.throws(() => run(['calendar_update', 'event-1', '{"start":"not-a-date"}']), /ISO date/);
  assert.throws(() => run(['calendar_update', 'missing', '{"title":"x"}']), /not found/);
  assert.deepEqual(JSON.parse(run(['calendar_delete', 'event-1', '{"calendar":"Work"}'])), {
    deleted: true, id: 'event-1', calendar: 'Work',
  });
  assert.deepEqual(deletedCalendarItems, [event]);

  const updatedReminder = JSON.parse(run([
    'reminder_update', 'reminder-1', JSON.stringify({
      list: 'Inbox', title: 'Buy oat milk', dueAt: null, notes: '', priority: 1, completed: true, flagged: true,
    }),
  ])) as { updated: boolean; reminder: Record<string, unknown> };
  assert.equal(updatedReminder.updated, true);
  assert.deepEqual(updatedReminder.reminder, {
    id: 'reminder-1', list: 'Inbox', title: 'Buy oat milk', dueAt: null,
    completed: true, priority: 1, flagged: true, notes: '',
  });
  assert.throws(() => run(['reminder_update', 'reminder-1', '{}']), /at least one mutable field/);
  assert.throws(() => run(['reminder_update', 'reminder-1', '{"priority":10}']), /0 to 9/);
  assert.throws(() => run(['reminder_update', 'missing', '{"completed":true}']), /not found/);
  assert.deepEqual(JSON.parse(run(['reminder_delete', 'reminder-1', '{"list":"Inbox"}'])), {
    deleted: true, id: 'reminder-1', list: 'Inbox',
  });
  assert.deepEqual(deletedReminderItems, [reminder]);
});
