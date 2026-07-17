#!/usr/bin/env node

/**
 * MimiAgent information radar connector.
 * Polls bounded RSS/Atom feeds and Open-Meteo forecasts without dependencies.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const configPath = process.env.MIMI_RADAR_CONFIG;
if (!configPath) {
  process.stderr.write('[radar] missing MIMI_RADAR_CONFIG\n');
  process.exit(1);
}

let config;
try {
  config = loadConfig(configPath);
} catch (error) {
  process.stderr.write(`[radar] invalid config: ${errorText(error)}\n`);
  process.exit(1);
}

const pollIntervalMs = integer(
  process.env.RADAR_POLL_INTERVAL_MS ?? config.pollIntervalMs ?? 300_000,
  'pollIntervalMs', 0, 86_400_000,
);
let polling = false;

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function text(value, label, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function number(value, label, minimum, maximum, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function integer(value, label, minimum, maximum, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function url(value, label) {
  const parsed = new URL(text(value, label));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${label} must use http or https`);
  return parsed.toString();
}

function stringList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a string array with at most 100 items`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function integerList(value, label, minimum, maximum) {
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => !Number.isInteger(item) || item < minimum || item > maximum)) {
    throw new Error(`${label} must be an integer array with values between ${minimum} and ${maximum}`);
  }
  return [...new Set(value)];
}

function loadConfig(file) {
  const raw = object(JSON.parse(readFileSync(file, 'utf8')), 'config');
  if (raw.version !== 1) throw new Error('config.version must be 1');
  if (!Array.isArray(raw.sources) || raw.sources.length < 1 || raw.sources.length > 50) {
    throw new Error('config.sources must contain 1 to 50 sources');
  }
  const ids = new Set();
  const sources = raw.sources.map((candidate, index) => {
    const source = object(candidate, `sources[${index}]`);
    const id = text(source.id, `sources[${index}].id`);
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`invalid source id: ${id}`);
    if (ids.has(id)) throw new Error(`duplicate source id: ${id}`);
    ids.add(id);
    if (source.type === 'feed') {
      return {
        type: 'feed', id, url: url(source.url, `${id}.url`),
        priority: integer(source.priority, `${id}.priority`, 0, 100, 40),
        maxItems: integer(source.maxItems, `${id}.maxItems`, 1, 100, 20),
        includeKeywords: stringList(source.includeKeywords, `${id}.includeKeywords`).map((item) => item.toLocaleLowerCase()),
        excludeKeywords: stringList(source.excludeKeywords, `${id}.excludeKeywords`).map((item) => item.toLocaleLowerCase()),
      };
    }
    if (source.type === 'open-meteo') {
      const thresholds = object(source.thresholds ?? {}, `${id}.thresholds`);
      return {
        type: 'open-meteo', id,
        latitude: number(source.latitude, `${id}.latitude`, -90, 90),
        longitude: number(source.longitude, `${id}.longitude`, -180, 180),
        timezone: text(source.timezone, `${id}.timezone`, 'auto'),
        endpoint: url(source.endpoint ?? 'https://api.open-meteo.com/v1/forecast', `${id}.endpoint`),
        horizonHours: integer(source.horizonHours, `${id}.horizonHours`, 1, 168, 24),
        priority: integer(source.priority, `${id}.priority`, 0, 100, 90),
        thresholds: {
          precipitationProbability: number(thresholds.precipitationProbability, `${id}.thresholds.precipitationProbability`, 0, 100, 80),
          windGustKmh: number(thresholds.windGustKmh, `${id}.thresholds.windGustKmh`, 0, 500, 60),
          temperatureHighC: number(thresholds.temperatureHighC, `${id}.thresholds.temperatureHighC`, -100, 100, 37),
          temperatureLowC: number(thresholds.temperatureLowC, `${id}.thresholds.temperatureLowC`, -100, 100, -10),
          weatherCodes: (thresholds.weatherCodes === undefined
            ? [65, 67, 75, 77, 82, 86, 95, 96, 99]
            : integerList(thresholds.weatherCodes, `${id}.thresholds.weatherCodes`, 0, 99)),
        },
      };
    }
    throw new Error(`${id}.type must be feed or open-meteo`);
  });
  return {
    sources,
    pollIntervalMs: integer(raw.pollIntervalMs, 'pollIntervalMs', 0, 86_400_000, 300_000),
    requestTimeoutMs: integer(raw.requestTimeoutMs, 'requestTimeoutMs', 1_000, 120_000, 15_000),
    maxResponseBytes: integer(raw.maxResponseBytes, 'maxResponseBytes', 1_024, 10_000_000, 2_000_000),
  };
}

async function boundedFetch(target, accept) {
  const response = await fetch(target, {
    headers: { accept, 'user-agent': 'MimiAgent-Radar/1.0' },
    redirect: 'follow',
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > config.maxResponseBytes) throw new Error(`response exceeds ${config.maxResponseBytes} bytes`);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > config.maxResponseBytes) {
      await reader.cancel();
      throw new Error(`response exceeds ${config.maxResponseBytes} bytes`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function decodeXml(value) {
  return value
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, '$1')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => String.fromCodePoint(
      code[0].toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10),
    ))
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'").replace(/&amp;/gi, '&');
}

function cleanMarkup(value) {
  return decodeXml(value ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const element = name.includes(':') ? escaped : `(?:[\\w.-]+:)?${escaped}`;
    const match = block.match(new RegExp(`<${element}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${element}>`, 'i'));
    if (match) return cleanMarkup(match[1]);
  }
  return '';
}

function atomLink(block) {
  const links = [...block.matchAll(/<(?:[\w.-]+:)?link\b([^>]*)\/?\s*>/gi)];
  const preferred = links.find((match) => !/\brel\s*=\s*["'](?!alternate["'])/i.test(match[1])) ?? links[0];
  const href = preferred?.[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
  return href ? decodeXml(href) : '';
}

function parseFeed(xml, source) {
  const atom = /<(?:\w+:)?feed\b/i.test(xml);
  const pattern = atom ? /<(?:\w+:)?entry\b[^>]*>([\s\S]*?)<\/(?:\w+:)?entry>/gi : /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  const blocks = [...xml.matchAll(pattern)].slice(0, source.maxItems * 3);
  const result = [];
  for (const match of blocks) {
    const block = match[1];
    const title = tag(block, ['title']);
    const link = atom ? atomLink(block) : tag(block, ['link']);
    const stable = tag(block, atom ? ['id'] : ['guid']) || link;
    const publishedAt = tag(block, ['published', 'updated', 'pubDate', 'dc:date']);
    const summary = tag(block, ['summary', 'description', 'content:encoded', 'content']).slice(0, 4_000);
    if (!title || !stable) continue;
    const haystack = `${title}\n${summary}`.toLocaleLowerCase();
    if (source.includeKeywords.length && !source.includeKeywords.some((keyword) => haystack.includes(keyword))) continue;
    if (source.excludeKeywords.some((keyword) => haystack.includes(keyword))) continue;
    result.push({ title, link, stable, publishedAt, summary });
    if (result.length >= source.maxItems) break;
  }
  return result;
}

async function fetchFeed(source, emit) {
  const xml = await boundedFetch(source.url, 'application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9');
  const entries = parseFeed(xml, source);
  if (emit) {
    for (const entry of entries) {
      const occurredAt = Number.isFinite(Date.parse(entry.publishedAt)) ? new Date(entry.publishedAt).toISOString() : new Date().toISOString();
      write({
        type: 'event', externalId: `feed:${source.id}:${hash(entry.stable)}`, kind: 'ambient',
        priority: source.priority, occurredAt,
        payload: {
          type: 'feed_item', sourceId: source.id, title: entry.title, url: entry.link,
          publishedAt: entry.publishedAt || undefined, summary: entry.summary,
        },
      });
    }
  }
  return { sourceId: source.id, type: source.type, items: entries.length };
}

function numericAt(values, index) {
  const value = Array.isArray(values) ? Number(values[index]) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

function weatherReasons(row, thresholds) {
  const reasons = [];
  if (row.precipitationProbability !== undefined && row.precipitationProbability >= thresholds.precipitationProbability) reasons.push('precipitation_probability');
  if (row.windGustKmh !== undefined && row.windGustKmh >= thresholds.windGustKmh) reasons.push('wind_gust');
  if (row.temperatureC !== undefined && row.temperatureC >= thresholds.temperatureHighC) reasons.push('high_temperature');
  if (row.temperatureC !== undefined && row.temperatureC <= thresholds.temperatureLowC) reasons.push('low_temperature');
  if (row.weatherCode !== undefined && thresholds.weatherCodes.includes(row.weatherCode)) reasons.push('weather_code');
  return reasons;
}

async function fetchWeather(source, emit) {
  const endpoint = new URL(source.endpoint);
  endpoint.searchParams.set('latitude', String(source.latitude));
  endpoint.searchParams.set('longitude', String(source.longitude));
  endpoint.searchParams.set('timezone', source.timezone);
  endpoint.searchParams.set('forecast_hours', String(source.horizonHours));
  endpoint.searchParams.set('temperature_unit', 'celsius');
  endpoint.searchParams.set('wind_speed_unit', 'kmh');
  endpoint.searchParams.set('hourly', 'temperature_2m,precipitation_probability,weather_code,wind_gusts_10m');
  const raw = await boundedFetch(endpoint, 'application/json');
  const data = object(JSON.parse(raw), `${source.id} response`);
  const hourly = object(data.hourly, `${source.id}.hourly`);
  if (!Array.isArray(hourly.time)) throw new Error(`${source.id}.hourly.time must be an array`);
  const rows = hourly.time.slice(0, source.horizonHours).map((time, index) => {
    const row = {
      time: String(time),
      temperatureC: numericAt(hourly.temperature_2m, index),
      precipitationProbability: numericAt(hourly.precipitation_probability, index),
      weatherCode: numericAt(hourly.weather_code, index),
      windGustKmh: numericAt(hourly.wind_gusts_10m, index),
    };
    return { ...row, reasons: weatherReasons(row, source.thresholds) };
  });
  const risks = rows.filter((row) => row.reasons.length > 0);
  if (emit) {
    for (const risk of risks) {
      write({
        type: 'event', externalId: `weather:${source.id}:${hash(`${risk.time}:${risk.reasons.join(',')}`)}`,
        kind: 'alert', priority: source.priority, occurredAt: new Date().toISOString(),
        payload: {
          type: 'weather_threshold', sourceId: source.id,
          latitude: source.latitude, longitude: source.longitude, timezone: source.timezone, ...risk,
        },
      });
    }
  }
  return { sourceId: source.id, type: source.type, rows, risks: risks.length };
}

async function runSource(source, emit = true) {
  return source.type === 'feed' ? fetchFeed(source, emit) : fetchWeather(source, emit);
}

function selectSources(target, type) {
  const candidates = config.sources.filter((source) => !type || source.type === type);
  if (target === 'all' || target === '*') return candidates;
  const source = candidates.find((candidate) => candidate.id === target);
  if (!source) throw new Error(`source not found: ${target}`);
  return [source];
}

async function refresh(target = 'all', emit = true) {
  return Promise.all(selectSources(target).map(async (source) => {
    try {
      return await runSource(source, emit);
    } catch (error) {
      process.stderr.write(`[radar:${source.id}] ${errorText(error)}\n`);
      return { sourceId: source.id, type: source.type, error: errorText(error) };
    }
  }));
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function action(message) {
  if (typeof message.id !== 'string' || !message.id) throw new Error('action.id is required');
  if (typeof message.target !== 'string' || !message.target) throw new Error('action.target is required');
  if (message.action === 'refresh') return { refreshed: await refresh(message.target, true) };
  if (message.action === 'weather_snapshot') {
    const snapshots = await Promise.all(
      selectSources(message.target, 'open-meteo').map((source) => fetchWeather(source, false)),
    );
    return { snapshots };
  }
  if (message.action === 'sources') {
    return { sources: selectSources(message.target).map((source) => ({ id: source.id, type: source.type })) };
  }
  throw new Error(`unsupported action: ${String(message.action)}`);
}

process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > 1_000_000) {
    process.stderr.write('[radar] input exceeded 1MB; resetting buffer\n');
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
        if (message?.type !== 'action') throw new Error(`unsupported message type: ${String(message?.type)}`);
        write({ type: 'action_result', id: message.id, ok: true, result: await action(message) });
      } catch (error) {
        write({ type: 'action_result', id: message?.id ?? 'invalid', ok: false, error: errorText(error) });
      }
    })();
  }
});

async function poll() {
  if (polling || pollIntervalMs === 0) return;
  polling = true;
  try {
    await refresh('all', true);
  } finally {
    polling = false;
  }
}

let timer;
if (pollIntervalMs > 0) {
  void poll();
  timer = setInterval(() => void poll(), pollIntervalMs);
  timer.unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (timer) clearInterval(timer);
    process.exit(0);
  });
}
