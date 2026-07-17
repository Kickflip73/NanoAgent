import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface Message {
  type: string;
  id?: string;
  ok?: boolean;
  kind?: string;
  externalId?: string;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}

async function waitFor(messages: Message[], predicate: (message: Message) => boolean, timeoutMs = 5_000): Promise<Message> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
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

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('information radar normalizes RSS, Atom and weather risks with stable identities and actions', async () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Test</title>
    <item><guid>rss-1</guid><title><![CDATA[AI &amp; Agents]]></title><link>https://example.test/rss-1</link><pubDate>Wed, 15 Jul 2026 08:00:00 GMT</pubDate><description><![CDATA[<p>Useful update</p>]]></description></item>
    <item><guid>rss-2</guid><title>Cooking</title><link>https://example.test/rss-2</link><description>Not selected</description></item>
  </channel></rss>`;
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry><id>tag:example.test,2026:atom-1</id><title>Release notes</title><link rel="alternate" href="https://example.test/atom-1"/><updated>2026-07-15T09:00:00Z</updated><summary>Version &lt;b&gt;one&lt;/b&gt;</summary></entry>
  </feed>`;
  const weather = {
    hourly: {
      time: ['2026-07-15T10:00', '2026-07-15T11:00', '2026-07-15T12:00'],
      temperature_2m: [38, 25, 26],
      precipitation_probability: [10, 20, 30],
      weather_code: [1, 1, 95],
      wind_gusts_10m: [20, 30, 70],
    },
  };
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/rss')) {
      response.writeHead(200, { 'content-type': 'application/rss+xml' }).end(rss);
    } else if (request.url?.startsWith('/atom')) {
      response.writeHead(200, { 'content-type': 'application/atom+xml' }).end(atom);
    } else if (request.url?.startsWith('/weather')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(weather));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-radar-'));
  const configFile = path.join(root, 'radar.json');
  await writeFile(configFile, JSON.stringify({
    version: 1,
    pollIntervalMs: 1000,
    requestTimeoutMs: 2000,
    maxResponseBytes: 100_000,
    sources: [
      { id: 'rss', type: 'feed', url: `${base}/rss`, includeKeywords: ['AI'], maxItems: 10 },
      { id: 'atom', type: 'feed', url: `${base}/atom`, maxItems: 10 },
      {
        id: 'home', type: 'open-meteo', endpoint: `${base}/weather`, latitude: 31.2, longitude: 121.5,
        timezone: 'Asia/Shanghai', horizonHours: 3,
        thresholds: { precipitationProbability: 80, windGustKmh: 60, temperatureHighC: 37, temperatureLowC: -5, weatherCodes: [95] },
      },
    ],
  }));
  const connector = fileURLToPath(new URL('../examples/connectors/radar-connector.mjs', import.meta.url));
  const child = spawn(process.execPath, [connector], {
    env: {
      ...process.env,
      MIMI_RADAR_CONFIG: configFile,
      RADAR_POLL_INTERVAL_MS: '1000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: Message[] = [];
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
      if (line) messages.push(JSON.parse(line) as Message);
    }
  });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  try {
    const rssEvent = await waitFor(messages, (message) => message.payload?.sourceId === 'rss');
    const atomEvent = await waitFor(messages, (message) => message.payload?.sourceId === 'atom');
    const highTemperature = await waitFor(messages, (message) =>
      message.payload?.sourceId === 'home' && (message.payload.reasons as string[])?.includes('high_temperature'));
    const storm = await waitFor(messages, (message) =>
      message.payload?.sourceId === 'home' && (message.payload.reasons as string[])?.includes('weather_code'));
    assert.equal(rssEvent.kind, 'ambient');
    assert.equal(rssEvent.payload?.title, 'AI & Agents');
    assert.equal(rssEvent.payload?.summary, 'Useful update');
    assert.equal(atomEvent.payload?.url, 'https://example.test/atom-1');
    assert.equal(highTemperature.kind, 'alert');
    assert.deepEqual(storm.payload?.reasons, ['wind_gust', 'weather_code']);
    const firstIds = [rssEvent.externalId, atomEvent.externalId, highTemperature.externalId, storm.externalId];
    assert.equal(new Set(firstIds).size, 4);

    const beforeRefresh = messages.length;
    child.stdin.write(`${JSON.stringify({ type: 'action', id: 'refresh-1', action: 'refresh', target: 'all', payload: {} })}\n`);
    const refreshed = await waitFor(messages, (message) => message.id === 'refresh-1');
    assert.equal(refreshed.ok, true);
    assert.equal((refreshed.result?.refreshed as unknown[]).length, 3);
    await waitFor(messages, (message) => messages.indexOf(message) >= beforeRefresh && message.externalId === rssEvent.externalId);

    child.stdin.write(`${JSON.stringify({ type: 'action', id: 'weather-1', action: 'weather_snapshot', target: 'home', payload: {} })}\n`);
    const snapshot = await waitFor(messages, (message) => message.id === 'weather-1');
    assert.equal(snapshot.ok, true);
    const snapshots = snapshot.result?.snapshots as Array<{ rows: unknown[]; risks: number }>;
    assert.equal(snapshots[0]?.rows.length, 3);
    assert.equal(snapshots[0]?.risks, 2);

    child.stdin.write(`${JSON.stringify({ type: 'action', id: 'sources-1', action: 'sources', target: 'all', payload: {} })}\n`);
    const sources = await waitFor(messages, (message) => message.id === 'sources-1');
    assert.deepEqual(sources.result?.sources, [
      { id: 'rss', type: 'feed' }, { id: 'atom', type: 'feed' }, { id: 'home', type: 'open-meteo' },
    ]);
    assert.equal(stderr, '');
  } finally {
    await stop(child);
    await close(server);
  }
});
