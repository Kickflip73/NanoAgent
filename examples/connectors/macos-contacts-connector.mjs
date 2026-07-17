#!/usr/bin/env node

/**
 * MimiAgent ↔ macOS Contacts connector.
 *
 * No npm dependencies. Contacts data stays behind the Contacts.app JXA boundary.
 */

import { spawn } from 'node:child_process';

const ACTIONS = new Set(['search_contacts', 'get_contact', 'create_contact', 'update_contact']);
const osascript = process.env.MACOS_CONTACTS_OSASCRIPT || '/usr/bin/osascript';

const CONTACTS_SCRIPT = String.raw`
function string(value) { return value === null || value === undefined ? '' : String(value); }
function iso(value) { return value ? new Date(value).toISOString() : null; }
function values(items, limit) {
  return items().slice(0, limit || 20).map(function(item) {
    return { id: string(item.id()).slice(0, 500), label: string(item.label()).slice(0, 100), value: string(item.value()).slice(0, 500) };
  });
}
function contact(person, detail) {
  var result = {
    id: string(person.id()), name: string(person.name()),
    firstName: string(person.firstName()), middleName: string(person.middleName()), lastName: string(person.lastName()),
    nickname: string(person.nickname()), organization: string(person.organization()),
    department: string(person.department()), jobTitle: string(person.jobTitle()), company: Boolean(person.company()),
    emails: values(person.emails, detail ? 20 : 5), phones: values(person.phones, detail ? 20 : 5),
    groups: person.groups().map(function(group) { return { id: string(group.id()), name: string(group.name()) }; }),
    createdAt: iso(person.creationDate()), modifiedAt: iso(person.modificationDate())
  };
  if (detail) result.note = string(person.note()).slice(0, 4000);
  return result;
}
function find(app, id) {
  var people = app.people();
  for (var i = 0; i < people.length; i += 1) if (string(people[i].id()) === id) return people[i];
  throw new Error('contact not found: ' + id);
}
function searchable(person) {
  return [person.name(), person.firstName(), person.lastName(), person.nickname(), person.organization()]
    .map(string).concat(values(person.emails, 20).map(function(item) { return item.value; }))
    .concat(values(person.phones, 20).map(function(item) { return item.value; })).join('\n').toLocaleLowerCase();
}
function addValues(app, person, property, kind, items) {
  (items || []).forEach(function(item) {
    person[property].push(app[kind]({ label: item.label || 'other', value: item.value }));
  });
}
function scalarProperties(payload) {
  var result = {};
  ['firstName', 'middleName', 'lastName', 'nickname', 'organization', 'department', 'jobTitle', 'note', 'company']
    .forEach(function(key) { if (Object.prototype.hasOwnProperty.call(payload, key)) result[key] = payload[key]; });
  return result;
}
function run(argv) {
  var action = argv[0];
  var target = argv[1];
  var payload = JSON.parse(argv[2] || '{}');
  var app = Application('Contacts');
  if (action === 'search_contacts') {
    var query = target === '*' ? '' : target.toLocaleLowerCase();
    var matches = app.people().filter(function(person) { return !query || searchable(person).indexOf(query) >= 0; });
    matches.sort(function(a, b) { return string(a.name()).localeCompare(string(b.name())); });
    return JSON.stringify({ contacts: matches.slice(0, payload.limit).map(function(person) { return contact(person, false); }) });
  }
  if (action === 'get_contact') return JSON.stringify({ contact: contact(find(app, target), true) });
  if (action === 'create_contact') {
    var created = app.Person(scalarProperties(payload));
    app.people.push(created);
    addValues(app, created, 'emails', 'Email', payload.emails);
    addValues(app, created, 'phones', 'Phone', payload.phones);
    app.save();
    return JSON.stringify({ created: true, contact: contact(created, true) });
  }
  if (action === 'update_contact') {
    var person = find(app, target);
    var properties = scalarProperties(payload);
    Object.keys(properties).forEach(function(key) { person[key] = properties[key]; });
    addValues(app, person, 'emails', 'Email', payload.addEmails);
    addValues(app, person, 'phones', 'Phone', payload.addPhones);
    app.save();
    return JSON.stringify({ updated: true, contact: contact(person, true) });
  }
  throw new Error('unsupported action: ' + action);
}`;

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function runJxa(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(osascript, ['-l', 'JavaScript', '-e', CONTACTS_SCRIPT, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-1_000_000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code, signal) => finish(() => {
      if (code !== 0) {
        reject(new Error((stderr || `osascript exited code=${code} signal=${signal || 'none'}`).trim()));
        return;
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout.trim()) : null);
      } catch {
        reject(new Error(`osascript returned invalid JSON: ${stdout.slice(0, 500)}`));
      }
    }));
  });
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

function optionalString(value, label, maximum) {
  return value === undefined ? undefined : boundedString(value, label, maximum);
}

function contactValues(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error(`${label} must contain at most 20 items`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${label}[${index}] must be an object`);
    return {
      label: optionalString(item.label, `${label}[${index}].label`, 100) || 'other',
      value: boundedString(item.value, `${label}[${index}].value`, 500, true).trim(),
    };
  });
}

function scalarPayload(payload) {
  const result = {};
  for (const [key, maximum] of Object.entries({
    firstName: 500, middleName: 500, lastName: 500, nickname: 500,
    organization: 1000, department: 1000, jobTitle: 1000, note: 4000,
  })) {
    const value = optionalString(payload[key], `payload.${key}`, maximum);
    if (value !== undefined) result[key] = value;
  }
  if (payload.company !== undefined) {
    if (typeof payload.company !== 'boolean') throw new Error('payload.company must be a boolean');
    result.company = payload.company;
  }
  return result;
}

function validate(action, target, rawPayload) {
  if (!ACTIONS.has(action)) throw new Error(`unsupported action: ${String(action)}`);
  boundedString(target, 'target', 1000, true);
  const payload = payloadObject(rawPayload);
  if (action === 'search_contacts') {
    const limit = payload.limit === undefined ? 20 : Number(payload.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('payload.limit must be between 1 and 100');
    return { limit };
  }
  if (action === 'get_contact') return {};
  const scalars = scalarPayload(payload);
  if (action === 'create_contact') {
    if (target !== 'new') throw new Error('create_contact target must be new');
    const emails = contactValues(payload.emails, 'payload.emails');
    const phones = contactValues(payload.phones, 'payload.phones');
    if (!Object.keys(scalars).some((key) => key !== 'company') && emails.length === 0 && phones.length === 0) {
      throw new Error('create_contact requires at least one name, organization, email or phone field');
    }
    return { ...scalars, emails, phones };
  }
  const addEmails = contactValues(payload.addEmails, 'payload.addEmails');
  const addPhones = contactValues(payload.addPhones, 'payload.addPhones');
  if (Object.keys(scalars).length === 0 && addEmails.length === 0 && addPhones.length === 0) {
    throw new Error('update_contact requires at least one field');
  }
  return { ...scalars, addEmails, addPhones };
}

async function execute(message) {
  if (!message || typeof message !== 'object') throw new Error('message must be an object');
  if (typeof message.id !== 'string' || !message.id) throw new Error('message.id is required');
  if (message.type !== 'action') throw new Error(`unsupported message type: ${String(message.type)}`);
  if (typeof message.target !== 'string') throw new Error('action.target is required');
  const payload = validate(message.action, message.target, message.payload);
  const result = await runJxa([message.action, message.target, JSON.stringify(payload)]);
  return { type: 'action_result', id: message.id, ok: true, result };
}

process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > 1_000_000) {
    process.stderr.write('[macos-contacts] input exceeded 1MB; resetting buffer\n');
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
