import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AtomicJsonStore } from './state-file.js';

export type RunCommitPhase =
  | 'prepared'
  | 'receipt_committed'
  | 'session_committed'
  | 'goal_committed'
  | 'task_committed'
  | 'effects_applied'
  | 'finalized';

export interface RunCommitJournalEntry {
  id: string;
  sessionId: string;
  runId: string;
  executionKey?: string;
  phase: RunCommitPhase;
  answerDigest: string;
  completionDecision?: 'pass' | 'continue' | 'blocked' | 'uncertain';
  runtimeActions: Array<Record<string, unknown>>;
  updatedAt: string;
}

interface RunCommitJournalFile {
  version: 1;
  entries: Record<string, RunCommitJournalEntry>;
}

const phaseSchema = z.enum([
  'prepared',
  'receipt_committed',
  'session_committed',
  'goal_committed',
  'task_committed',
  'effects_applied',
  'finalized',
]);
const entrySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  runId: z.string(),
  executionKey: z.string().optional(),
  phase: phaseSchema,
  answerDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  completionDecision: z.enum(['pass', 'continue', 'blocked', 'uncertain']).optional(),
  runtimeActions: z.array(z.record(z.string(), z.unknown())),
  updatedAt: z.string(),
});
const journalSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), entrySchema),
});

const PHASE_ORDER: readonly RunCommitPhase[] = [
  'prepared',
  'receipt_committed',
  'session_committed',
  'goal_committed',
  'task_committed',
  'effects_applied',
  'finalized',
];

export function runAnswerDigest(answer: string): string {
  return createHash('sha256').update(answer).digest('hex');
}

export function runCommitJournalId(sessionId: string, runId: string): string {
  return createHash('sha256').update(`${sessionId}\0${runId}`).digest('hex');
}

export class RunCommitJournal {
  private readonly state: AtomicJsonStore<RunCommitJournalFile>;

  constructor(file: string) {
    this.state = new AtomicJsonStore(file, {
      defaultValue: () => ({
        version: 1,
        entries: Object.create(null) as Record<string, RunCommitJournalEntry>,
      }),
      decode: (value) => {
        const parsed = journalSchema.parse(value);
        return {
          version: 1,
          entries: Object.assign(
            Object.create(null),
            parsed.entries,
          ) as Record<string, RunCommitJournalEntry>,
        };
      },
      recoverCorrupt: false,
    });
  }

  async prepare(input: Omit<RunCommitJournalEntry, 'id' | 'phase' | 'updatedAt'>): Promise<RunCommitJournalEntry> {
    const id = runCommitJournalId(input.sessionId, input.runId);
    return this.state.update((journal) => {
      const existing = journal.entries[id];
      if (existing) {
        if (existing.answerDigest !== input.answerDigest
          || existing.executionKey !== input.executionKey
          || JSON.stringify(existing.runtimeActions) !== JSON.stringify(input.runtimeActions)) {
          throw new Error(`Run ${input.runId} 已存在不同的提交计划，拒绝覆盖`);
        }
        return { ...existing };
      }
      const entry: RunCommitJournalEntry = {
        id,
        ...input,
        phase: 'prepared',
        updatedAt: new Date().toISOString(),
      };
      journal.entries[id] = entry;
      return { ...entry };
    });
  }

  async advance(
    sessionId: string,
    runId: string,
    phase: RunCommitPhase,
  ): Promise<RunCommitJournalEntry> {
    const id = runCommitJournalId(sessionId, runId);
    return this.state.update((journal) => {
      const entry = journal.entries[id];
      if (!entry) throw new Error(`Run ${runId} 缺少提交日志`);
      const currentIndex = PHASE_ORDER.indexOf(entry.phase);
      const nextIndex = PHASE_ORDER.indexOf(phase);
      if (nextIndex < currentIndex) return { ...entry };
      entry.phase = phase;
      entry.updatedAt = new Date().toISOString();
      return { ...entry };
    });
  }

  async acknowledgeTask(
    sessionId: string,
    executionKey: string,
  ): Promise<RunCommitJournalEntry | undefined> {
    return this.state.update((journal) => {
      const entry = Object.values(journal.entries).find((candidate) =>
        candidate.sessionId === sessionId
        && candidate.executionKey === executionKey
        && candidate.phase !== 'finalized');
      if (!entry) return undefined;
      entry.phase = 'task_committed';
      entry.updatedAt = new Date().toISOString();
      return { ...entry };
    });
  }

  async finalizeExecution(
    sessionId: string,
    executionKey: string,
  ): Promise<RunCommitJournalEntry | undefined> {
    return this.state.update((journal) => {
      const entry = Object.values(journal.entries).find((candidate) =>
        candidate.sessionId === sessionId && candidate.executionKey === executionKey);
      if (!entry) return undefined;
      entry.phase = 'finalized';
      entry.updatedAt = new Date().toISOString();
      return { ...entry };
    });
  }

  async get(sessionId: string, runId: string): Promise<RunCommitJournalEntry | undefined> {
    const entry = (await this.state.read()).entries[runCommitJournalId(sessionId, runId)];
    return entry ? { ...entry, runtimeActions: entry.runtimeActions.map((action) => ({ ...action })) } : undefined;
  }

  async findByExecutionKey(
    sessionId: string,
    executionKey: string,
  ): Promise<RunCommitJournalEntry | undefined> {
    const entry = Object.values((await this.state.read()).entries).find((candidate) =>
      candidate.sessionId === sessionId && candidate.executionKey === executionKey);
    return entry ? { ...entry, runtimeActions: entry.runtimeActions.map((action) => ({ ...action })) } : undefined;
  }

  async recoverable(): Promise<RunCommitJournalEntry[]> {
    return Object.values((await this.state.read()).entries)
      .filter((entry) => entry.phase !== 'finalized')
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((entry) => ({ ...entry, runtimeActions: entry.runtimeActions.map((action) => ({ ...action })) }));
  }
}
