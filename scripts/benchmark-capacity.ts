import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { AgentInputItem } from '@openai/agents';
import type { MemoryDocument, SourceRef } from '../src/core/memory.js';
import { FileSession } from '../src/core/session.js';
import { MimiStore } from '../src/daemon/store.js';
import { SqliteMemoryCatalog } from '../src/extensions/memory/sqlite-catalog.js';

interface CapacityBenchmarkOptions {
  events: number;
  taskClaims: number;
  sessions: number;
  roundsPerSession: number;
  memories: number;
  memoryQueries: number;
  keep: boolean;
}

interface Timing {
  operations: number;
  durationMs: number;
  operationsPerSecond: number;
}

const LIMITS = {
  events: 1_000_000,
  taskClaims: 100_000,
  sessions: 10_000,
  roundsPerSession: 10_000,
  memories: 1_000_000,
  memoryQueries: 100_000,
} as const;

function integerArgument(
  name: keyof typeof LIMITS,
  fallback: number,
): number {
  const prefix = `--${name}=`;
  const inline = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
  const index = process.argv.indexOf(`--${name}`);
  const raw = inline?.slice(prefix.length) ?? (index >= 0 ? process.argv[index + 1] : undefined);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > LIMITS[name]) {
    throw new Error(`${name} 必须是 0 到 ${LIMITS[name]} 的安全整数`);
  }
  return value;
}

function options(): CapacityBenchmarkOptions {
  const events = integerArgument('events', 1_000);
  return {
    events,
    taskClaims: integerArgument('taskClaims', Math.min(events, 100)),
    sessions: integerArgument('sessions', 100),
    roundsPerSession: integerArgument('roundsPerSession', 20),
    memories: integerArgument('memories', 500),
    memoryQueries: integerArgument('memoryQueries', 50),
    keep: process.argv.includes('--keep'),
  };
}

function timing(operations: number, startedAt: number): Timing {
  const durationMs = performance.now() - startedAt;
  return {
    operations,
    durationMs: Number(durationMs.toFixed(3)),
    operationsPerSecond: durationMs > 0
      ? Number((operations * 1_000 / durationMs).toFixed(2))
      : 0,
  };
}

async function directoryBytes(root: string): Promise<number> {
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) bytes += (await stat(target)).size;
    }
  }
  return bytes;
}

function memoryDocument(index: number, at: string): MemoryDocument {
  const id = `memory-${index}`;
  const source: SourceRef = {
    type: 'session',
    id: `benchmark@${index}`,
    digest: `sha256:benchmark-${index}`,
    occurredAt: at,
    trust: 'owner',
  };
  return {
    ref: { scope: 'private', profileId: 'owner', id },
    metadata: {
      schemaVersion: 1,
      id,
      title: `Capacity memory ${index}`,
      kind: 'fact',
      scope: 'private',
      profileId: 'owner',
      status: 'active',
      confidence: 'source-grounded',
      aliases: [`benchmark-${index}`],
      tags: ['capacity', `bucket-${index % 100}`],
      sourceRefs: [source],
      validFrom: null,
      validUntil: null,
      supersedes: [],
      createdAt: at,
      updatedAt: at,
    },
    body: `# Capacity memory ${index}\n\nSynthetic benchmark content in bucket ${index % 100}.`,
    digest: `sha256:memory-${index}`,
  };
}

async function run(): Promise<void> {
  const selected = options();
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-capacity-benchmark-'));
  const store = new MimiStore(path.join(root, 'daemon', 'mimi.db'));
  const sessionsRoot = path.join(root, 'sessions');
  const memory = new SqliteMemoryCatalog(path.join(root, 'memory', 'catalog.db'), 'private', 'owner');
  try {
    const occurredAt = new Date().toISOString();
    let startedAt = performance.now();
    for (let index = 0; index < selected.events; index += 1) {
      store.ingestEvent({
        id: `benchmark-event-${index}`,
        externalId: `benchmark-external-${index}`,
        source: 'benchmark',
        kind: 'command',
        trust: 'owner',
        payload: { text: `synthetic task ${index}` },
        occurredAt,
        receivedAt: occurredAt,
        priority: index % 101,
        profileId: 'owner',
        sessionKey: `benchmark-session-${index % Math.max(1, selected.sessions)}`,
      });
    }
    const eventIngress = timing(selected.events, startedAt);

    startedAt = performance.now();
    let claimed = 0;
    while (claimed < selected.taskClaims && store.claimTask(`benchmark-worker-${claimed}`)) claimed += 1;
    const taskClaim = timing(claimed, startedAt);

    const roundItems = Array.from({ length: selected.roundsPerSession }, (_, index) => ([
      { role: 'user', content: `Synthetic user turn ${index}` },
      { role: 'assistant', content: `Synthetic assistant turn ${index}` },
    ] as AgentInputItem[])).flat();
    startedAt = performance.now();
    for (let index = 0; index < selected.sessions; index += 1) {
      await new FileSession(sessionsRoot, `benchmark-session-${index}`).addItems(roundItems);
    }
    const sessionWrite = timing(selected.sessions * selected.roundsPerSession, startedAt);
    startedAt = performance.now();
    const sessionSummaries = await FileSession.listSummaries(sessionsRoot);
    const sessionList = timing(sessionSummaries.length, startedAt);

    startedAt = performance.now();
    for (let index = 0; index < selected.memories; index += 1) {
      memory.index(memoryDocument(index, occurredAt));
    }
    const memoryIndex = timing(selected.memories, startedAt);
    startedAt = performance.now();
    let memoryHits = 0;
    for (let index = 0; index < selected.memoryQueries; index += 1) {
      memoryHits += memory.search(`bucket ${index % 100}`, { limit: 5 }).length;
    }
    const memorySearch = timing(selected.memoryQueries, startedAt);

    const counts = store.counts();
    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
      },
      options: selected,
      results: {
        eventIngress,
        taskClaim,
        sessionWrite,
        sessionList,
        memoryIndex,
        memorySearch,
      },
      observed: {
        durableEvents: counts.events.total,
        tasks: counts.tasks,
        sessionSummaries: sessionSummaries.length,
        memoryHits,
        storageBytes: await directoryBytes(root),
      },
      ...(selected.keep ? { workingDirectory: root } : {}),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    memory.close();
    store.close();
    if (!selected.keep) await rm(root, { recursive: true, force: true });
  }
}

await run();
