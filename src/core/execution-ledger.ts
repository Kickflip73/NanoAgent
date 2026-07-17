import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AtomicJsonStore } from './state-file.js';

export interface ExecutionCall {
  sessionId: string;
  runId: string;
  toolName: string;
  callId: string;
  modelCallId?: string;
  argumentsJson: string;
}

export interface SucceededExecutionCall extends ExecutionCall {
  output: unknown;
}

export interface ExecutionCallRecord extends ExecutionCall {
  modelCallIds?: string[];
  status: ExecutionStatus;
  output?: unknown;
  error?: string;
}

export type ExecutionStatus = 'started' | 'succeeded' | 'failed' | 'uncertain';

interface ExecutionEntry extends ExecutionCall {
  modelCallIds?: string[];
  key: string;
  argumentsHash: string;
  status: ExecutionStatus;
  outputJson?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

interface LedgerFile {
  version: 1;
  entries: Record<string, ExecutionEntry>;
}

const entrySchema = z.object({
  key: z.string(),
  sessionId: z.string(),
  runId: z.string(),
  toolName: z.string(),
  callId: z.string(),
  modelCallId: z.string().optional(),
  modelCallIds: z.array(z.string()).optional(),
  argumentsJson: z.string(),
  argumentsHash: z.string(),
  status: z.enum(['started', 'succeeded', 'failed', 'uncertain']),
  outputJson: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string(),
  updatedAt: z.string(),
});
const ledgerSchema = z.object({ version: z.literal(1), entries: z.record(z.string(), entrySchema) });

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function executionKey(call: ExecutionCall): string {
  return digest([call.sessionId, call.runId, call.toolName, call.callId].join('\0'));
}

function receiptCall(sessionId: string, runId: string): ExecutionCall {
  return {
    sessionId,
    runId,
    toolName: '__mimi_execution_receipt__',
    callId: 'completed',
    argumentsJson: '{}',
  };
}

function serializeOutput(value: unknown, maxBytes: number): string {
  const output = JSON.stringify([value]);
  if (output === undefined) throw new Error('工具输出无法序列化，不能提交执行账本');
  if (Buffer.byteLength(output, 'utf8') > maxBytes) throw new Error(`工具输出超过执行账本 ${maxBytes} 字节限制`);
  return output;
}

function deserializeOutput<T>(value: string): T {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('执行账本输出格式无效');
  return parsed[0] as T;
}

export class ExecutionLedger {
  private readonly state: AtomicJsonStore<LedgerFile>;
  private readonly inFlight = new Map<string, { argumentsHash: string; execution: Promise<unknown> }>();
  private readonly maxEntries: number;
  private readonly maxOutputBytes: number;
  private readonly retentionMs: number;

  constructor(file: string, options: ExecutionLedgerOptions = {}) {
    this.maxEntries = positiveLimit(options.maxEntries, 2_000, 'maxEntries');
    this.maxOutputBytes = positiveLimit(options.maxOutputBytes, 64_000, 'maxOutputBytes');
    this.retentionMs = positiveLimit(options.retentionMs, 30 * 24 * 60 * 60_000, 'retentionMs');
    this.state = new AtomicJsonStore(file, {
      defaultValue: () => ({ version: 1, entries: Object.create(null) as Record<string, ExecutionEntry> }),
      decode: (value) => {
        const parsed = ledgerSchema.parse(value);
        return { version: 1, entries: Object.assign(Object.create(null), parsed.entries) as Record<string, ExecutionEntry> };
      },
      pretty: false,
      // Losing this ledger could replay a side effect whose outcome is unknown.
      // Quarantine the file, but fail closed until the user inspects it.
      recoverCorrupt: false,
    });
  }

  executeOnce<T>(call: ExecutionCall, operation: () => Promise<T>): Promise<T> {
    const key = executionKey(call);
    const argumentsHash = digest(call.argumentsJson);
    const running = this.inFlight.get(key);
    if (running) {
      if (running.argumentsHash !== argumentsHash) {
        return Promise.reject(new Error(`工具调用 ${call.callId} 参数冲突，拒绝执行`));
      }
      return running.execution as Promise<T>;
    }
    const execution = this.executePersisted(key, call, operation);
    this.inFlight.set(key, { argumentsHash, execution });
    void execution.finally(() => {
      if (this.inFlight.get(key)?.execution === execution) this.inFlight.delete(key);
    }).catch(() => undefined);
    return execution;
  }

  commitReceipt<T>(sessionId: string, runId: string, receipt: T): Promise<T> {
    return this.executeOnce(receiptCall(sessionId, runId), async () => receipt);
  }

  async getReceipt<T>(sessionId: string, runId: string): Promise<T | undefined> {
    const call = receiptCall(sessionId, runId);
    const entry = (await this.state.read()).entries[executionKey(call)];
    if (!entry) return undefined;
    if (entry.argumentsHash !== digest(call.argumentsJson)) {
      throw new Error(`Execution ${runId} 的完成回执参数冲突`);
    }
    if (entry.status !== 'succeeded' || entry.outputJson === undefined) {
      throw new Error(`Execution ${runId} 的完成回执处于 ${entry.status} 状态，拒绝自动重跑`);
    }
    return deserializeOutput<T>(entry.outputJson);
  }

  async clearReceipt(sessionId: string, runId: string): Promise<void> {
    const key = executionKey(receiptCall(sessionId, runId));
    await this.state.updateWhen((ledger) => {
      if (!ledger.entries[key]) return { result: undefined, changed: false };
      delete ledger.entries[key];
      return { result: undefined, changed: true };
    });
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.state.updateWhen((ledger) => {
      let changed = false;
      for (const [key, entry] of Object.entries(ledger.entries)) {
        if (entry.sessionId === sessionId) {
          delete ledger.entries[key];
          changed = true;
        }
      }
      return { result: undefined, changed };
    });
  }

  async listSucceededCalls(sessionId: string, runId: string): Promise<SucceededExecutionCall[]> {
    const entries = Object.values((await this.state.read()).entries)
      .filter((entry) => entry.sessionId === sessionId && entry.runId === runId && entry.status === 'succeeded')
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.key.localeCompare(right.key));
    return entries.map((entry) => {
      if (entry.outputJson === undefined) throw new Error(`工具调用 ${entry.callId} 缺少成功输出`);
      return {
        sessionId: entry.sessionId,
        runId: entry.runId,
        toolName: entry.toolName,
        callId: entry.callId,
        ...(entry.modelCallId ? { modelCallId: entry.modelCallId } : {}),
        argumentsJson: entry.argumentsJson,
        output: deserializeOutput<unknown>(entry.outputJson),
      };
    });
  }

  async listCalls(sessionId: string, runId: string): Promise<ExecutionCallRecord[]> {
    const entries = Object.values((await this.state.read()).entries)
      .filter((entry) => entry.sessionId === sessionId
        && (entry.runId === runId || entry.runId.startsWith(`${runId}:`))
        && entry.toolName !== '__mimi_execution_receipt__')
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.key.localeCompare(right.key));
    return entries.map((entry) => ({
      sessionId: entry.sessionId,
      runId: entry.runId,
      toolName: entry.toolName,
      callId: entry.callId,
      ...(entry.modelCallId ? { modelCallId: entry.modelCallId } : {}),
      ...(entry.modelCallIds?.length ? { modelCallIds: entry.modelCallIds } : {}),
      argumentsJson: entry.argumentsJson,
      status: entry.status,
      ...(entry.outputJson === undefined ? {} : { output: deserializeOutput<unknown>(entry.outputJson) }),
      ...(entry.error === undefined ? {} : { error: entry.error }),
    }));
  }

  async clearSessionExcept(sessionId: string, retainedRunId: string): Promise<void> {
    await this.state.updateWhen((ledger) => {
      let changed = false;
      for (const [key, entry] of Object.entries(ledger.entries)) {
        const retained = entry.runId === retainedRunId || entry.runId.startsWith(`${retainedRunId}:`);
        if (entry.sessionId === sessionId && !retained) {
          delete ledger.entries[key];
          changed = true;
        }
      }
      return { result: undefined, changed };
    });
  }

  async clearRun(sessionId: string, runId: string): Promise<void> {
    await this.state.updateWhen((ledger) => {
      let changed = false;
      for (const [key, entry] of Object.entries(ledger.entries)) {
        if (entry.sessionId === sessionId && (entry.runId === runId || entry.runId.startsWith(`${runId}:`))) {
          delete ledger.entries[key];
          changed = true;
        }
      }
      return { result: undefined, changed };
    });
  }

  private async executePersisted<T>(
    key: string,
    call: ExecutionCall,
    operation: () => Promise<T>,
  ): Promise<T> {
    const argumentsHash = digest(call.argumentsJson);
    const decision = await this.state.updateWhen<{ outputJson: string | undefined }>((ledger) => {
      const existing = ledger.entries[key];
      if (existing) {
        if (existing.argumentsHash !== argumentsHash) throw new Error(`工具调用 ${call.callId} 参数冲突，拒绝执行`);
        if (existing.status === 'succeeded' && existing.outputJson !== undefined) {
          const aliases = new Set(existing.modelCallIds ?? (existing.modelCallId ? [existing.modelCallId] : []));
          const before = aliases.size;
          if (call.modelCallId) aliases.add(call.modelCallId);
          existing.modelCallIds = [...aliases];
          return { result: { outputJson: existing.outputJson }, changed: aliases.size !== before };
        }
        throw new Error(`工具调用 ${call.callId} 之前处于 ${existing.status} 状态，为避免重复副作用不会自动重试`);
      }
      this.prune(ledger, Date.now());
      if (Object.keys(ledger.entries).length >= this.maxEntries) {
        throw new Error(`执行账本已达到 ${this.maxEntries} 条上限；请完成或清理旧 Session 后再执行副作用`);
      }
      const now = new Date().toISOString();
      ledger.entries[key] = {
        ...call,
        ...(call.modelCallId ? { modelCallIds: [call.modelCallId] } : {}),
        key,
        argumentsHash,
        status: 'started',
        startedAt: now,
        updatedAt: now,
      };
      return { result: { outputJson: undefined }, changed: true };
    });
    if (decision.outputJson !== undefined) return deserializeOutput<T>(decision.outputJson);

    try {
      const output = await operation();
      const outputJson = serializeOutput(output, this.maxOutputBytes);
      await this.state.update((ledger) => {
        const entry = ledger.entries[key];
        if (!entry || entry.status !== 'started' || entry.argumentsHash !== argumentsHash) {
          throw new Error(`工具调用 ${call.callId} 的执行账本状态已失效`);
        }
        entry.status = 'succeeded';
        entry.outputJson = outputJson;
        entry.updatedAt = new Date().toISOString();
      });
      return output;
    } catch (error) {
      await this.state.update((ledger) => {
        const entry = ledger.entries[key];
        if (entry?.status === 'started' && entry.argumentsHash === argumentsHash) {
          const uncertain = error instanceof Error
            && (error.name.includes('Uncertain') || /结果不确定|outcome uncertain/i.test(error.message));
          entry.status = uncertain ? 'uncertain' : 'failed';
          entry.error = error instanceof Error ? error.message.slice(0, 4_000) : String(error).slice(0, 4_000);
          entry.updatedAt = new Date().toISOString();
        }
      });
      throw error;
    }
  }

  private prune(ledger: LedgerFile, now: number): void {
    const cutoff = now - this.retentionMs;
    for (const [key, entry] of Object.entries(ledger.entries)) {
      if (entry.status !== 'started' && Date.parse(entry.updatedAt) < cutoff) delete ledger.entries[key];
    }
  }
}

export interface ExecutionLedgerOptions {
  maxEntries?: number;
  maxOutputBytes?: number;
  retentionMs?: number;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) throw new Error(`${name} 必须是正安全整数`);
  return selected;
}
