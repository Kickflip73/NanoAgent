#!/usr/bin/env node

/**
 * MimiAgent ↔ macOS Calendar / Reminders / Notifications connector.
 *
 * It deliberately has no npm dependencies. Calendar and reminder operations use
 * EventKit through a bundled Swift helper, so polling never launches or controls
 * the Calendar or Reminders GUI applications. Notification delivery alone uses
 * osascript and Notification Center.
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const osascript = process.env.MACOS_OSASCRIPT || '/usr/bin/osascript';
const swiftc = process.env.MACOS_SWIFTC_BIN || '/usr/bin/swiftc';
const eventKitCommand = process.env.MACOS_LIFE_EVENTKIT_COMMAND;
const eventKitHelper = absolutePath(
  process.env.MACOS_LIFE_EVENTKIT_HELPER
    || fileURLToPath(new URL('./macos-life-eventkit.swift', import.meta.url)),
  'MACOS_LIFE_EVENTKIT_HELPER',
);
const pollIntervalMs = numberEnv('MACOS_POLL_INTERVAL_MS', 300_000, 0, 86_400_000);
const lookaheadMinutes = numberEnv('MACOS_LOOKAHEAD_MINUTES', 30, 1, 10_080);
const maxPollItems = numberEnv('MACOS_LIFE_MAX_ITEMS', 200, 1, 200);
const pollCalendar = process.env.MACOS_CALENDAR || '*';
const pollReminderList = process.env.MACOS_REMINDER_LIST || '*';
const stateFile = absolutePath(
  process.env.MACOS_LIFE_STATE_FILE || defaultDaemonStateFile('macos-life.json'),
  'MACOS_LIFE_STATE_FILE',
);

function defaultDaemonStateFile(name) {
  const configured = process.env.MIMI_DAEMON_DATA_DIR;
  if (configured) return path.join(expandHome(configured), name);
  return path.join(os.homedir(), '.mimi-agent', 'daemon', name);
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

const ACTIONS = new Set([
  'notify',
  'calendar_list',
  'calendar_create',
  'calendar_update',
  'calendar_delete',
  'reminder_list',
  'reminder_create',
  'reminder_complete',
  'reminder_update',
  'reminder_delete',
]);

const ACTION_SCRIPT = String.raw`
function json(value) { return JSON.stringify(value); }
function text(value, fallback) { return typeof value === 'string' && value.length ? value : fallback; }
function iso(value) { return value ? new Date(value).toISOString() : null; }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function boundedText(value, name, maximum, allowEmpty) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(name + ' must be a non-empty string');
  if (value.length > maximum) throw new Error(name + ' exceeds ' + maximum + ' characters');
  return value;
}
function dateValue(value, name, allowNull) {
  if (allowNull && value === null) return null;
  if (typeof value !== 'string' || !value) throw new Error(name + ' must be an ISO date string');
  var result = new Date(value);
  if (isNaN(result.getTime())) throw new Error(name + ' must be an ISO date string');
  return result;
}
function priority(value) {
  var result = Number(value);
  if (!Number.isInteger(result) || result < 0 || result > 9) throw new Error('payload.priority must be an integer from 0 to 9');
  return result;
}
function hasAny(value, keys) {
  return keys.some(function(key) { return own(value, key); });
}
function payload(raw) {
  var value = JSON.parse(raw || '{}');
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('payload must be an object');
  return value;
}
function named(collection, name, label) {
  if (name === '*' || name === 'default') {
    var all = collection();
    if (!all.length) throw new Error('no ' + label + ' available');
    return all[0];
  }
  var item = collection.byName(name);
  if (!item.exists()) throw new Error(label + ' not found: ' + name);
  return item;
}
function calendars(app, name) {
  return name === '*' ? app.calendars() : [named(app.calendars, name, 'calendar')];
}
function reminderLists(app, name) {
  return name === '*' ? app.lists() : [named(app.lists, name, 'reminder list')];
}
function findCalendarEvent(app, id, calendarName) {
  var selected = calendars(app, calendarName);
  for (var i = 0; i < selected.length; i += 1) {
    var events = selected[i].events();
    for (var j = 0; j < events.length; j += 1) {
      if (String(events[j].uid()) === id) return { event: events[j], calendar: selected[i] };
    }
  }
  throw new Error('calendar event not found: ' + id);
}
function findReminder(app, id, listName) {
  var selected = reminderLists(app, listName);
  for (var i = 0; i < selected.length; i += 1) {
    var reminders = selected[i].reminders();
    for (var j = 0; j < reminders.length; j += 1) {
      if (String(reminders[j].id()) === id) return { reminder: reminders[j], list: selected[i] };
    }
  }
  throw new Error('reminder not found: ' + id);
}
function calendarItem(event, calendarName) {
  return {
    id: String(event.uid()),
    calendar: calendarName,
    title: String(event.summary()),
    startAt: iso(event.startDate()),
    endAt: iso(event.endDate()),
    allDay: Boolean(event.alldayEvent()),
    location: String(event.location() || ''),
    notes: String(event.description() || '')
  };
}
function reminderItem(reminder, listName) {
  return {
    id: String(reminder.id()),
    list: listName,
    title: String(reminder.name()),
    dueAt: iso(reminder.dueDate()),
    completed: Boolean(reminder.completed()),
    priority: Number(reminder.priority() || 0),
    flagged: Boolean(reminder.flagged()),
    notes: String(reminder.body() || '')
  };
}
function run(argv) {
  var action = argv[0];
  var target = argv[1];
  var p = payload(argv[2]);
  if (action === 'notify') {
    var current = Application.currentApplication();
    current.includeStandardAdditions = true;
    var options = { withTitle: text(target, 'MimiAgent') };
    if (typeof p.subtitle === 'string' && p.subtitle) options.subtitle = p.subtitle;
    if (typeof p.sound === 'string' && p.sound) options.soundName = p.sound;
    current.displayNotification(text(p.text, text(p.message, 'MimiAgent has an update')), options);
    return json({ notified: true });
  }
  if (action === 'calendar_list') {
    var calendarApp = Application('Calendar');
    var from = new Date(text(p.from, new Date().toISOString()));
    var to = new Date(text(p.to, new Date(from.getTime() + 86400000).toISOString()));
    var limit = Math.max(1, Math.min(Number(p.limit || 50), 500));
    var result = [];
    calendars(calendarApp, target).forEach(function(calendar) {
      var name = String(calendar.name());
      calendar.events().forEach(function(event) {
        var start = event.startDate();
        if (start >= from && start <= to && result.length < limit) result.push(calendarItem(event, name));
      });
    });
    result.sort(function(a, b) { return a.startAt.localeCompare(b.startAt); });
    return json({ events: result.slice(0, limit) });
  }
  if (action === 'calendar_create') {
    var createTitle = boundedText(p.title, 'payload.title', 1000, false);
    var start = dateValue(p.start, 'payload.start', false);
    var createApp = Application('Calendar');
    var calendar = named(createApp.calendars, target, 'calendar');
    var end = own(p, 'end') ? dateValue(p.end, 'payload.end', false) : new Date(start.getTime() + 3600000);
    var properties = { summary: createTitle, startDate: start, endDate: end };
    if (own(p, 'location')) properties.location = boundedText(p.location, 'payload.location', 5000, true);
    if (own(p, 'notes')) properties.description = boundedText(p.notes, 'payload.notes', 40000, true);
    if (typeof p.allDay === 'boolean') properties.alldayEvent = p.allDay;
    var created = createApp.Event(properties);
    calendar.events.push(created);
    return json({ created: true, id: String(created.uid()), calendar: String(calendar.name()), startAt: start.toISOString(), endAt: end.toISOString() });
  }
  if (action === 'calendar_update') {
    var calendarUpdateFields = ['title', 'start', 'end', 'location', 'notes', 'allDay'];
    if (!hasAny(p, calendarUpdateFields)) throw new Error('calendar_update requires at least one mutable field');
    var updateCalendarApp = Application('Calendar');
    var foundEvent = findCalendarEvent(updateCalendarApp, target, text(p.calendar, '*'));
    if (own(p, 'title')) foundEvent.event.summary = boundedText(p.title, 'payload.title', 1000, false);
    if (own(p, 'start')) foundEvent.event.startDate = dateValue(p.start, 'payload.start', false);
    if (own(p, 'end')) foundEvent.event.endDate = dateValue(p.end, 'payload.end', false);
    if (own(p, 'location')) foundEvent.event.location = boundedText(p.location, 'payload.location', 5000, true);
    if (own(p, 'notes')) foundEvent.event.description = boundedText(p.notes, 'payload.notes', 40000, true);
    if (own(p, 'allDay')) {
      if (typeof p.allDay !== 'boolean') throw new Error('payload.allDay must be a boolean');
      foundEvent.event.alldayEvent = p.allDay;
    }
    return json({ updated: true, event: calendarItem(foundEvent.event, String(foundEvent.calendar.name())) });
  }
  if (action === 'calendar_delete') {
    var deleteCalendarApp = Application('Calendar');
    var deleteEvent = findCalendarEvent(deleteCalendarApp, target, text(p.calendar, '*'));
    var deletedCalendarName = String(deleteEvent.calendar.name());
    deleteCalendarApp.delete(deleteEvent.event);
    return json({ deleted: true, id: target, calendar: deletedCalendarName });
  }
  if (action === 'reminder_list') {
    var reminderApp = Application('Reminders');
    var includeCompleted = p.completed === true;
    var reminderLimit = Math.max(1, Math.min(Number(p.limit || 100), 500));
    var reminders = [];
    reminderLists(reminderApp, target).forEach(function(list) {
      var listName = String(list.name());
      list.reminders().forEach(function(reminder) {
        if ((includeCompleted || !reminder.completed()) && reminders.length < reminderLimit) {
          reminders.push(reminderItem(reminder, listName));
        }
      });
    });
    reminders.sort(function(a, b) { return String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999')); });
    return json({ reminders: reminders.slice(0, reminderLimit) });
  }
  if (action === 'reminder_create') {
    var reminderTitle = boundedText(p.title, 'payload.title', 1000, false);
    var reminderCreateApp = Application('Reminders');
    var list = named(reminderCreateApp.lists, target, 'reminder list');
    var reminderProperties = { name: reminderTitle };
    if (own(p, 'notes')) reminderProperties.body = boundedText(p.notes, 'payload.notes', 40000, true);
    if (own(p, 'dueAt') && p.dueAt !== null) reminderProperties.dueDate = dateValue(p.dueAt, 'payload.dueAt', false);
    if (own(p, 'priority')) reminderProperties.priority = priority(p.priority);
    if (own(p, 'flagged')) {
      if (typeof p.flagged !== 'boolean') throw new Error('payload.flagged must be a boolean');
      reminderProperties.flagged = p.flagged;
    }
    var newReminder = reminderCreateApp.Reminder(reminderProperties);
    list.reminders.push(newReminder);
    return json({ created: true, id: String(newReminder.id()), list: String(list.name()), dueAt: iso(newReminder.dueDate()) });
  }
  if (action === 'reminder_complete') {
    var completeApp = Application('Reminders');
    var completedReminder = findReminder(completeApp, target, text(p.list, '*'));
    completedReminder.reminder.completed = true;
    return json({ completed: true, id: target, list: String(completedReminder.list.name()) });
  }
  if (action === 'reminder_update') {
    var reminderUpdateFields = ['title', 'dueAt', 'notes', 'priority', 'completed', 'flagged'];
    if (!hasAny(p, reminderUpdateFields)) throw new Error('reminder_update requires at least one mutable field');
    var updateReminderApp = Application('Reminders');
    var foundReminder = findReminder(updateReminderApp, target, text(p.list, '*'));
    if (own(p, 'title')) foundReminder.reminder.name = boundedText(p.title, 'payload.title', 1000, false);
    if (own(p, 'dueAt')) foundReminder.reminder.dueDate = dateValue(p.dueAt, 'payload.dueAt', true);
    if (own(p, 'notes')) foundReminder.reminder.body = boundedText(p.notes, 'payload.notes', 40000, true);
    if (own(p, 'priority')) foundReminder.reminder.priority = priority(p.priority);
    if (own(p, 'completed')) {
      if (typeof p.completed !== 'boolean') throw new Error('payload.completed must be a boolean');
      foundReminder.reminder.completed = p.completed;
    }
    if (own(p, 'flagged')) {
      if (typeof p.flagged !== 'boolean') throw new Error('payload.flagged must be a boolean');
      foundReminder.reminder.flagged = p.flagged;
    }
    return json({ updated: true, reminder: reminderItem(foundReminder.reminder, String(foundReminder.list.name())) });
  }
  if (action === 'reminder_delete') {
    var deleteReminderApp = Application('Reminders');
    var deleteReminder = findReminder(deleteReminderApp, target, text(p.list, '*'));
    var deletedListName = String(deleteReminder.list.name());
    deleteReminderApp.delete(deleteReminder.reminder);
    return json({ deleted: true, id: target, list: deletedListName });
  }
  throw new Error('unsupported action: ' + action);
}`;

const POLL_SCRIPT = String.raw`
function iso(value) { return value ? new Date(value).toISOString() : null; }
function selected(collection, name) {
  if (name === '*') return collection();
  var item = collection.byName(name);
  return item.exists() ? [item] : [];
}
function wanted(raw) {
  var result = {};
  JSON.parse(raw || '[]').forEach(function(id) { result[String(id)] = true; });
  return result;
}
function calendarItem(event, calendarName) {
  return {
    id: String(event.uid()).slice(0, 500), calendar: calendarName.slice(0, 500),
    title: String(event.summary()).slice(0, 1000), startAt: iso(event.startDate()),
    endAt: iso(event.endDate()), location: String(event.location() || '').slice(0, 2000)
  };
}
function reminderItem(reminder, listName) {
  return {
    id: String(reminder.id()).slice(0, 500), list: listName.slice(0, 500),
    title: String(reminder.name()).slice(0, 1000), dueAt: iso(reminder.dueDate()),
    completed: Boolean(reminder.completed()), priority: Number(reminder.priority() || 0),
    flagged: Boolean(reminder.flagged()), notes: String(reminder.body() || '').slice(0, 2000)
  };
}
function run(argv) {
  var now = new Date(argv[0]);
  var until = new Date(argv[1]);
  var calendarName = argv[2];
  var reminderListName = argv[3];
  var previousCalendar = wanted(argv[4]);
  var previousReminders = wanted(argv[5]);
  var limit = Math.max(1, Math.min(Number(argv[6] || 200), 200));
  var result = { calendar: [], reminders: [], knownCalendar: [], knownReminders: [] };
  var calendarTracked = 0;
  var calendarApp = Application('Calendar');
  if (calendarApp.running()) {
    selected(calendarApp.calendars, calendarName).forEach(function(calendar) {
      var name = String(calendar.name());
      calendar.events().forEach(function(event) {
        var start = event.startDate();
        var item = calendarItem(event, name);
        if (start >= now && start <= until && calendarTracked < limit) {
          result.calendar.push(item);
          calendarTracked += 1;
        } else if (previousCalendar[item.id] && calendarTracked < limit) {
          result.knownCalendar.push(item);
          calendarTracked += 1;
        }
      });
    });
  }
  var reminderApp = Application('Reminders');
  var remindersTracked = 0;
  if (reminderApp.running()) {
    selected(reminderApp.lists, reminderListName).forEach(function(list) {
      var name = String(list.name());
      list.reminders().forEach(function(reminder) {
        var due = reminder.dueDate();
        var item = reminderItem(reminder, name);
        if (!item.completed && due && due <= until && remindersTracked < limit) {
          result.reminders.push(item);
          remindersTracked += 1;
        } else if (previousReminders[item.id] && remindersTracked < limit) {
          result.knownReminders.push(item);
          remindersTracked += 1;
        }
      });
    });
  }
  return JSON.stringify(result);
}`;

function numberEnv(name, fallback, minimum, maximum) {
  if (!process.env[name]) return fallback;
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    process.stderr.write(`[macos-life] invalid ${name}; using ${fallback}\n`);
    return fallback;
  }
  return value;
}

function absolutePath(value, name) {
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.resolve(value);
}

function bounded(value, maximum) {
  return String(value ?? '').slice(0, maximum);
}

function calendarItem(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) return undefined;
  if (typeof value.startAt !== 'string' || !Number.isFinite(Date.parse(value.startAt))) return undefined;
  return {
    id: bounded(value.id, 500),
    calendar: bounded(value.calendar, 500),
    title: bounded(value.title, 1_000),
    startAt: new Date(value.startAt).toISOString(),
    endAt: typeof value.endAt === 'string' && Number.isFinite(Date.parse(value.endAt))
      ? new Date(value.endAt).toISOString()
      : null,
    location: bounded(value.location, 2_000),
  };
}

function reminderItem(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) return undefined;
  return {
    id: bounded(value.id, 500),
    list: bounded(value.list, 500),
    title: bounded(value.title, 1_000),
    dueAt: typeof value.dueAt === 'string' && Number.isFinite(Date.parse(value.dueAt))
      ? new Date(value.dueAt).toISOString()
      : null,
    completed: value.completed === true,
    priority: Number.isInteger(value.priority) ? Math.max(0, Math.min(9, value.priority)) : 0,
    flagged: value.flagged === true,
    notes: bounded(value.notes, 2_000),
  };
}

function normalizeItems(values, normalize) {
  if (!Array.isArray(values)) return [];
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const item = normalize(value);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
    if (result.length >= maxPollItems) break;
  }
  return result;
}

function itemHash(item) {
  return createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 24);
}

function suggestedFollowUpAt(event) {
  const end = typeof event.endAt === 'string' ? Date.parse(event.endAt) : Number.NaN;
  return Number.isFinite(end) ? new Date(end + 5 * 60_000).toISOString() : undefined;
}

function byId(items) {
  return new Map(items.map((item) => [item.id, item]));
}

function emptyState() {
  return { version: 1, calendar: [], reminders: [] };
}

async function readState() {
  try {
    const value = JSON.parse(await readFile(stateFile, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
      throw new Error('state must be a version 1 object');
    }
    await chmod(stateFile, 0o600);
    return {
      version: 1,
      calendar: normalizeItems(value.calendar, calendarItem),
      reminders: normalizeItems(value.reminders, reminderItem),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    process.stderr.write(`[macos-life] cannot read state; rebuilding baseline: ${errorText(error)}\n`);
    return undefined;
  }
}

async function persistState(state) {
  const directory = path.dirname(stateFile);
  const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, stateFile);
    await chmod(stateFile, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function runJxa(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(osascript, ['-l', 'JavaScript', '-e', script, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 25_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > 1_000_000) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('osascript timed out after 25000ms'));
        return;
      }
      if (overflow) {
        reject(new Error('osascript output exceeds 1000000 bytes'));
        return;
      }
      if (code !== 0) {
        reject(new Error((stderr || `osascript exited code=${code} signal=${signal || 'none'}`).trim()));
        return;
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout.trim()) : null);
      } catch {
        reject(new Error(`osascript returned invalid JSON: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

let eventKitExecutablePromise;

async function ensureEventKitExecutable() {
  if (eventKitCommand) return absolutePath(eventKitCommand, 'MACOS_LIFE_EVENTKIT_COMMAND');
  if (!eventKitExecutablePromise) {
    eventKitExecutablePromise = (async () => {
      const source = await readFile(eventKitHelper);
      const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
      const directory = path.dirname(stateFile);
      const executable = path.join(directory, `macos-life-eventkit-${digest}`);
      try {
        await access(executable, fsConstants.X_OK);
        return executable;
      } catch {
        // Compile once per helper revision; polling reuses the small native executable.
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const temporary = `${executable}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await new Promise((resolve, reject) => {
          const child = spawn(swiftc, [eventKitHelper, '-O', '-o', temporary], {
            env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          let stderr = '';
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
          child.once('error', reject);
          child.once('exit', (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error((stderr || `swiftc exited code=${code} signal=${signal || 'none'}`).trim()));
          });
        });
        await chmod(temporary, 0o700);
        await rename(temporary, executable);
        return executable;
      } finally {
        await rm(temporary, { force: true });
      }
    })();
  }
  return eventKitExecutablePromise;
}

async function runEventKit(action, target, payload) {
  const executable = await ensureEventKitExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [action, target, JSON.stringify(payload)], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 35_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > 1_000_000) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('EventKit helper timed out after 35000ms'));
        return;
      }
      if (overflow) {
        reject(new Error('EventKit helper output exceeds 1000000 bytes'));
        return;
      }
      if (code !== 0) {
        reject(new Error((stderr || `EventKit helper exited code=${code} signal=${signal || 'none'}`).trim()));
        return;
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout.trim()) : null);
      } catch {
        reject(new Error(`EventKit helper returned invalid JSON: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

async function execute(message) {
  if (!message || typeof message !== 'object') throw new Error('message must be an object');
  if (typeof message.id !== 'string' || !message.id) throw new Error('message.id is required');
  if (message.type === 'deliver') {
    const payload = typeof message.payload === 'string' ? { text: message.payload } : message.payload;
    await runJxa(ACTION_SCRIPT, ['notify', String(message.target || 'MimiAgent'), JSON.stringify(payload || {})]);
    return { type: 'delivery_ack', id: message.id, ok: true };
  }
  if (message.type !== 'action') throw new Error(`unsupported message type: ${String(message.type)}`);
  if (!ACTIONS.has(message.action)) throw new Error(`unsupported action: ${String(message.action)}`);
  if (typeof message.target !== 'string' || !message.target.trim()) throw new Error('action.target is required');
  const payload = message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload)
    ? message.payload
    : {};
  const result = await runEventKit(message.action, message.target, payload);
  return { type: 'action_result', id: message.id, ok: true, result };
}

let polling = false;
let pollState;
const stateInitialization = readState().then((state) => { pollState = state; });

function changeEvent(entity, type, current, previous, now, priority) {
  const item = current ?? previous;
  write({
    type: 'event',
    externalId: `${entity}:${type}:${item.id}:${itemHash(current ?? previous)}`,
    kind: priority >= 75 ? 'alert' : 'ambient',
    priority,
    occurredAt: now.toISOString(),
    payload: { type, current: current ?? null, previous: previous ?? null },
  });
}

async function poll() {
  if (polling || pollIntervalMs === 0) return;
  polling = true;
  try {
    await stateInitialization;
    const now = new Date();
    const until = new Date(now.getTime() + lookaheadMinutes * 60_000);
    const previous = pollState ?? emptyState();
    const result = await runEventKit('poll', '*', {
      now: now.toISOString(),
      until: until.toISOString(),
      calendar: pollCalendar,
      list: pollReminderList,
      previousCalendarIds: previous.calendar.map((item) => item.id),
      previousReminderIds: previous.reminders.map((item) => item.id),
      limit: maxPollItems,
    });
    const calendar = normalizeItems(result?.calendar, calendarItem);
    const reminders = normalizeItems(result?.reminders, reminderItem);
    const knownCalendar = byId(normalizeItems(result?.knownCalendar, calendarItem));
    const knownReminders = byId(normalizeItems(result?.knownReminders, reminderItem));
    const previousCalendar = byId(previous.calendar);
    const previousReminders = byId(previous.reminders);
    const currentCalendar = byId(calendar);
    const currentReminders = byId(reminders);

    for (const event of calendar) {
      const old = previousCalendar.get(event.id);
      if (old && itemHash(old) !== itemHash(event)) {
        changeEvent('calendar', 'calendar_changed', event, old, now, 85);
      }
      const followUpAt = suggestedFollowUpAt(event);
      write({
        type: 'event', externalId: `calendar:upcoming:${event.id}:${itemHash(event)}`, kind: 'alert', priority: 80,
        occurredAt: now.toISOString(), payload: {
          type: 'calendar_upcoming',
          ...event,
          ...(followUpAt ? { suggestedFollowUpAt: followUpAt } : {}),
        },
      });
    }
    for (const old of previous.calendar) {
      if (currentCalendar.has(old.id)) continue;
      const known = knownCalendar.get(old.id);
      if (!known) changeEvent('calendar', 'calendar_deleted', undefined, old, now, 80);
      else if (itemHash(old) !== itemHash(known)) changeEvent('calendar', 'calendar_changed', known, old, now, 85);
    }

    for (const reminder of reminders) {
      const old = previousReminders.get(reminder.id);
      if (old && itemHash(old) !== itemHash(reminder)) {
        changeEvent('reminder', 'reminder_changed', reminder, old, now, 80);
      }
      const overdue = reminder.dueAt !== null && Date.parse(reminder.dueAt) < now.getTime();
      const type = overdue ? 'reminder_overdue' : 'reminder_due';
      write({
        type: 'event', externalId: `reminder:${type}:${reminder.id}:${itemHash(reminder)}`,
        kind: 'alert', priority: overdue ? 95 : 85, occurredAt: now.toISOString(), payload: { type, ...reminder },
      });
    }
    for (const old of previous.reminders) {
      if (currentReminders.has(old.id)) continue;
      const known = knownReminders.get(old.id);
      if (!known) changeEvent('reminder', 'reminder_deleted', undefined, old, now, 70);
      else if (known.completed && !old.completed) changeEvent('reminder', 'reminder_completed', known, old, now, 55);
      else if (itemHash(old) !== itemHash(known)) changeEvent('reminder', 'reminder_changed', known, old, now, 80);
    }

    const nextState = { version: 1, calendar, reminders };
    if (!pollState || JSON.stringify(pollState) !== JSON.stringify(nextState)) await persistState(nextState);
    pollState = nextState;
  } catch (error) {
    process.stderr.write(`[macos-life] poll failed: ${errorText(error)}\n`);
  } finally {
    polling = false;
  }
}

process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > 1_000_000) {
    process.stderr.write('[macos-life] input exceeded 1MB; resetting buffer\n');
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
        write({
          type: message?.type === 'action' ? 'action_result' : 'delivery_ack',
          id: message?.id || 'invalid', ok: false, error: errorText(error),
        });
      }
    })();
  }
});

let pollTimer;
if (pollIntervalMs > 0) {
  void poll();
  pollTimer = setInterval(() => void poll(), pollIntervalMs);
  pollTimer.unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (pollTimer) clearInterval(pollTimer);
    process.exit(0);
  });
}
