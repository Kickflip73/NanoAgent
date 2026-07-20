import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { AgentInputItem, Session } from '@openai/agents';
import { z } from 'zod';
import {
  completionContractSchema,
  completionReportSchema,
  type CompletionContract,
  type CompletionReport,
} from './completion.js';
import { assertSessionId } from './session-id.js';
import { AtomicJsonStore, StateFileCorruptError } from './state-file.js';

export type RunStatus = 'running' | 'completed' | 'interrupted' | 'failed';

export interface RunCheckpoint {
  runId: string;
  status: RunStatus;
  input: string;
  phase: string;
  lastEvent?: string;
  answer?: string;
  error?: string;
  nextAction?: string;
  completionContract?: CompletionContract;
  completionReport?: CompletionReport;
  completionGate?: {
    decision: 'pass' | 'continue' | 'blocked' | 'uncertain';
    reason: string;
    unmetCriteria: string[];
  };
  goalCreatedAt?: string;
  ownerId?: string;
  ownerPid?: number;
  historyStart?: number;
  startedAt: string;
  updatedAt: string;
}

export interface ContextArchive {
  coveredItems: number;
  summary: string;
  strategy: 'collapse' | 'full';
  originalTokens: number;
  compactedTokens: number;
  updatedAt: string;
}

export interface SessionPreferences {
  mode?: string;
  provider?: 'openai' | 'deepseek';
  model?: string;
  outputLevel?: string;
}

interface SessionFile {
  id: string;
  createdAt: string;
  updatedAt: string;
  items: AgentInputItem[];
  checkpoint?: RunCheckpoint;
  contextArchive?: ContextArchive;
  preferences?: SessionPreferences;
}

const sessionFileSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  items: z.array(z.record(z.string(), z.unknown())),
  checkpoint: z.object({
    runId: z.string(),
    status: z.enum(['running', 'completed', 'interrupted', 'failed']),
    input: z.string(),
    phase: z.string(),
    lastEvent: z.string().optional(),
    answer: z.string().optional(),
    error: z.string().optional(),
    nextAction: z.string().optional(),
    completionContract: completionContractSchema.optional(),
    completionReport: completionReportSchema.optional(),
    completionGate: z.object({
      decision: z.enum(['pass', 'continue', 'blocked', 'uncertain']),
      reason: z.string(),
      unmetCriteria: z.array(z.string()),
    }).strict().optional(),
    goalCreatedAt: z.string().optional(),
    ownerId: z.string().optional(),
    ownerPid: z.number().int().positive().optional(),
    historyStart: z.number().int().nonnegative().optional(),
    startedAt: z.string(),
    updatedAt: z.string(),
  }).optional(),
  contextArchive: z.object({
    coveredItems: z.number().int().nonnegative(),
    summary: z.string(),
    strategy: z.enum(['collapse', 'full']),
    originalTokens: z.number().nonnegative(),
    compactedTokens: z.number().nonnegative(),
    updatedAt: z.string(),
  }).optional(),
  preferences: z.object({
    mode: z.string().optional(),
    provider: z.enum(['openai', 'deepseek']).optional(),
    model: z.string().optional(),
    outputLevel: z.string().optional(),
  }).optional(),
});

function decodeSessionFile(value: unknown): SessionFile {
  return sessionFileSchema.parse(value) as unknown as SessionFile;
}

export interface SessionSummary {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  turns: number;
  recoverable: boolean;
  progress?: string;
}

function messageText(item: AgentInputItem): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  if (!('role' in item) || item.role !== 'user' || !('content' in item)) return undefined;
  if (typeof item.content === 'string') return item.content;
  if (!Array.isArray(item.content)) return undefined;
  return item.content
    .map((part) => typeof part === 'object' && part && 'text' in part ? String(part.text) : '')
    .join(' ');
}

function compactText(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').replace(/^\/+\S+\s*/, '').trim();
  if (!clean) return '新对话';
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

function cleanedTopicText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^\/+\S+\s*/, '')
    .replace(/^(?:请|帮我|麻烦|我想要?|我希望|需要|必须|能否|你能不能|请问)\s*/u, '')
    .split(/[，。！？；\n]/u)[0]
    ?.trim() ?? '';
}

function summarizeTopic(messages: string[]): string {
  const corpus = messages.join(' ').replace(/\s+/g, ' ').trim();
  if (/(?:session|会话)/iu.test(corpus) && /(?:标题|名称|命名|切换|新建)/u.test(corpus)) {
    return 'MimiAgent 会话与标题管理';
  }
  if (/(?:终端|CLI)/iu.test(corpus) && /(?:排队|队列)/u.test(corpus)) {
    return 'MimiAgent 终端交互与任务队列';
  }
  if (/(?:IPC|daemon|后台)/iu.test(corpus) && /(?:启动|进入|连接|超时|报错|无法)/u.test(corpus)) {
    return 'MimiAgent 启动与后台通信';
  }
  if (/(?:Event|事件)/iu.test(corpus) && /(?:Task|任务)/iu.test(corpus)) {
    return 'MimiAgent Event 与 Task 架构';
  }
  if (/(?:终端|CLI)/iu.test(corpus)) return 'MimiAgent 终端交互';
  if (/(?:memory|记忆)/iu.test(corpus)) return 'MimiAgent 记忆管理';

  const opening = cleanedTopicText(messages[0] ?? '')
    .replace(/^(?:修复|解决|排查|分析|解释|说明|实现|新增|添加|支持|设计|改造|重构|优化|完善|调整|修改|编写|写|创建|生成|整理|总结|翻译)\s*/u, '')
    .replace(/(?:的)?(?:功能|能力|体验|问题)\s*$/u, '')
    .replace(/\s*的\s*/gu, ' ')
    .trim();
  const intent = /(?:报错|错误|失败|故障|异常|无法|不能|超时|崩溃|修复|排查)/u.test(corpus)
    ? '故障排查'
    : /(?:设计|实现|新增|添加|支持|改造|重构|优化|完善|调整|修改)/u.test(corpus)
      ? '设计与改进'
      : /(?:解释|说明|为什么|原理|区别)/u.test(corpus)
        ? '原理说明'
        : '主题讨论';
  const subject = compactText(opening, 22);
  if (subject === '新对话') return subject;
  return compactText(`${subject} · ${intent}`, 32);
}

function isLowInformationOpening(text: string): boolean {
  const clean = text.replace(/[\s，。！？!?,.、~～]+/gu, '').toLowerCase();
  return /^(?:你好|您好|嗨|哈喽|在吗|有人吗|开始|继续|hello|hi|hey|test|测试)$/.test(clean);
}

function summarizeSession(session: SessionFile): SessionSummary {
  const messages = session.items.map(messageText).filter((text): text is string => Boolean(text?.trim()));
  const meaningful = messages.filter((text) => !text.trim().startsWith('/'));
  const titled = meaningful.filter((text) => !isLowInformationOpening(text));
  const source = titled.length ? titled : meaningful.length ? meaningful : messages;
  return {
    id: session.id,
    title: summarizeTopic(source.length ? source : [session.checkpoint?.input ?? '']),
    preview: compactText(source.at(-1) ?? session.checkpoint?.input ?? '', 52),
    updatedAt: session.updatedAt,
    turns: messages.length,
    recoverable: session.checkpoint?.status === 'running'
      || session.checkpoint?.status === 'interrupted'
      || session.checkpoint?.status === 'failed',
    progress: session.checkpoint?.lastEvent ?? session.checkpoint?.phase,
  };
}

const activeRunOwners = new Set<string>();

export function registerSessionRunOwner(ownerId: string): () => void {
  activeRunOwners.add(ownerId);
  return () => activeRunOwners.delete(ownerId);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function checkpointOwnerIsLive(checkpoint: RunCheckpoint): boolean {
  if (checkpoint.ownerId && activeRunOwners.has(checkpoint.ownerId)) return true;
  return checkpoint.ownerPid !== undefined
    && checkpoint.ownerPid !== process.pid
    && processIsAlive(checkpoint.ownerPid);
}

export class FileSession implements Session {
  private readonly file: string;
  private readonly state: AtomicJsonStore<SessionFile>;

  constructor(
    private readonly directory: string,
    private readonly id: string,
  ) {
    this.file = path.join(directory, `${assertSessionId(id)}.json`);
    this.state = new AtomicJsonStore<SessionFile>(this.file, {
      defaultValue: () => {
        const now = new Date().toISOString();
        return { id: this.id, createdAt: now, updatedAt: now, items: [] };
      },
      decode: decodeSessionFile,
      pretty: false,
    });
  }

  async getSessionId(): Promise<string> {
    return this.id;
  }

  async ensure(): Promise<void> {
    await this.mutate(() => undefined);
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const items = (await this.load()).items;
    return limit === undefined ? [...items] : items.slice(-limit);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    const validated = z.array(z.record(z.string(), z.unknown())).parse(items) as unknown as AgentInputItem[];
    await this.mutate((session) => {
      session.items.push(...validated);
      session.updatedAt = new Date().toISOString();
    });
  }

  async getCheckpoint(): Promise<RunCheckpoint | undefined> {
    const checkpoint = (await this.load()).checkpoint;
    return checkpoint ? { ...checkpoint } : undefined;
  }

  async beginRun(
    input: string,
    runId?: string,
    ownerId?: string,
    rollbackIncompleteItems = false,
  ): Promise<RunCheckpoint> {
    return this.mutate((session) => {
      if (session.checkpoint?.status === 'running' && checkpointOwnerIsLive(session.checkpoint)) {
        throw new Error(`Session ${this.id} 已被另一个活跃 Run 占用`);
      }
      const now = new Date().toISOString();
      const checkpoint: RunCheckpoint = {
        runId: runId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        status: 'running',
        input: input.trim().slice(0, 8_000),
        phase: '准备上下文',
        nextAction: '继续当前任务',
        ownerId,
        ownerPid: process.pid,
        ...(rollbackIncompleteItems ? { historyStart: session.items.length } : {}),
        startedAt: now,
        updatedAt: now,
      };
      session.checkpoint = checkpoint;
      session.updatedAt = now;
      return { ...checkpoint };
    });
  }

  async updateRunProgress(
    phase: string,
    lastEvent?: string,
    expectedRunId?: string,
  ): Promise<RunCheckpoint | undefined> {
    return this.mutateWhen((session) => {
      if (!session.checkpoint
        || session.checkpoint.status !== 'running'
        || (expectedRunId && session.checkpoint.runId !== expectedRunId)) {
        return { result: session.checkpoint ? { ...session.checkpoint } : undefined, changed: false };
      }
      session.checkpoint = {
        ...session.checkpoint,
        phase: phase.trim().slice(0, 200),
        lastEvent: lastEvent?.trim().slice(0, 2_000) || session.checkpoint.lastEvent,
        nextAction: '从最后记录的执行阶段继续',
        updatedAt: new Date().toISOString(),
      };
      session.updatedAt = session.checkpoint.updatedAt;
      return { result: { ...session.checkpoint }, changed: true };
    });
  }

  async updateRunCompletion(
    update: Pick<RunCheckpoint, 'completionContract' | 'completionReport' | 'completionGate'>,
    expectedRunId?: string,
  ): Promise<RunCheckpoint | undefined> {
    return this.mutateWhen((session) => {
      if (!session.checkpoint
        || session.checkpoint.status !== 'running'
        || (expectedRunId && session.checkpoint.runId !== expectedRunId)) {
        return { result: session.checkpoint ? { ...session.checkpoint } : undefined, changed: false };
      }
      session.checkpoint = {
        ...session.checkpoint,
        ...update,
        phase: update.completionGate ? '验收检查' : session.checkpoint.phase,
        updatedAt: new Date().toISOString(),
      };
      session.updatedAt = session.checkpoint.updatedAt;
      return { result: { ...session.checkpoint }, changed: true };
    });
  }

  async updateRunGoalOwnership(
    goalCreatedAt: string | undefined,
    expectedRunId?: string,
  ): Promise<RunCheckpoint | undefined> {
    return this.mutateWhen((session) => {
      if (!session.checkpoint
        || session.checkpoint.status !== 'running'
        || (expectedRunId && session.checkpoint.runId !== expectedRunId)) {
        return { result: session.checkpoint ? { ...session.checkpoint } : undefined, changed: false };
      }
      session.checkpoint = {
        ...session.checkpoint,
        goalCreatedAt,
        updatedAt: new Date().toISOString(),
      };
      session.updatedAt = session.checkpoint.updatedAt;
      return { result: { ...session.checkpoint }, changed: true };
    });
  }

  async completeRun(answer: string, expectedRunId?: string): Promise<RunCheckpoint | undefined> {
    return this.finishRun(
      'completed',
      { answer: answer.trim().slice(0, 8_000), phase: '已完成', nextAction: undefined },
      expectedRunId,
    );
  }

  async reconcileCompletedRun(answer: string, expectedRunId: string): Promise<RunCheckpoint | undefined> {
    return this.mutateWhen((session) => {
      if (!session.checkpoint || session.checkpoint.runId !== expectedRunId) {
        return { result: session.checkpoint ? { ...session.checkpoint } : undefined, changed: false };
      }
      if (session.checkpoint.status === 'completed') {
        return { result: { ...session.checkpoint }, changed: false };
      }
      const now = new Date().toISOString();
      session.checkpoint = {
        ...session.checkpoint,
        status: 'completed',
        answer: answer.trim().slice(0, 8_000),
        error: undefined,
        phase: '已完成',
        nextAction: undefined,
        ownerId: undefined,
        ownerPid: undefined,
        updatedAt: now,
      };
      session.updatedAt = now;
      return { result: { ...session.checkpoint }, changed: true };
    });
  }

  async failRun(error: string, interrupted = false, expectedRunId?: string): Promise<RunCheckpoint | undefined> {
    return this.finishRun(interrupted ? 'interrupted' : 'failed', {
      error: error.trim().slice(0, 2_000),
      phase: interrupted ? '已中断' : '执行失败',
      nextAction: '检查最后进展并继续未完成任务',
    }, expectedRunId);
  }

  async clearRunCheckpoint(expectedRunId: string): Promise<boolean> {
    return this.mutateWhen((session) => {
      if (!session.checkpoint || session.checkpoint.runId !== expectedRunId) {
        return { result: false, changed: false };
      }
      session.checkpoint = undefined;
      session.updatedAt = new Date().toISOString();
      return { result: true, changed: true };
    });
  }

  async rollbackRunItems(expectedRunId: string): Promise<boolean> {
    return this.mutateWhen((session) => {
      const checkpoint = session.checkpoint;
      if (!checkpoint || checkpoint.runId !== expectedRunId || checkpoint.historyStart === undefined) {
        return { result: false, changed: false };
      }
      const start = Math.min(checkpoint.historyStart, session.items.length);
      if (session.items.length === start) return { result: false, changed: false };
      session.items.splice(start);
      if (session.contextArchive && session.contextArchive.coveredItems > start) {
        session.contextArchive = undefined;
      }
      session.updatedAt = new Date().toISOString();
      return { result: true, changed: true };
    });
  }

  async recoverInterruptedRun(expectedRunId?: string): Promise<RunCheckpoint | undefined> {
    return this.mutateWhen((session) => {
      if (!session.checkpoint
        || session.checkpoint.status !== 'running'
        || (expectedRunId && session.checkpoint.runId !== expectedRunId)
        || checkpointOwnerIsLive(session.checkpoint)) {
        return { result: session.checkpoint ? { ...session.checkpoint } : undefined, changed: false };
      }
      const now = new Date().toISOString();
      if (session.checkpoint.historyStart !== undefined) {
        const start = Math.min(session.checkpoint.historyStart, session.items.length);
        session.items.splice(start);
        if (session.contextArchive && session.contextArchive.coveredItems > start) {
          session.contextArchive = undefined;
        }
      }
      session.checkpoint = {
        ...session.checkpoint,
        status: 'interrupted',
        error: '进程在本轮完成前退出',
        nextAction: '从最后记录的执行阶段继续',
        ownerId: undefined,
        ownerPid: undefined,
        updatedAt: now,
      };
      session.updatedAt = now;
      return { result: { ...session.checkpoint }, changed: true };
    });
  }

  async getContextArchive(): Promise<ContextArchive | undefined> {
    const archive = (await this.load()).contextArchive;
    return archive ? { ...archive } : undefined;
  }

  async setContextArchive(archive: ContextArchive): Promise<void> {
    await this.mutate((session) => {
      session.contextArchive = { ...archive };
      session.updatedAt = new Date().toISOString();
    });
  }

  async getPreferences(): Promise<SessionPreferences> {
    return { ...(await this.load()).preferences };
  }

  async setPreferences(preferences: Partial<SessionPreferences>): Promise<void> {
    await this.mutate((session) => {
      session.preferences = { ...session.preferences, ...preferences };
      session.updatedAt = new Date().toISOString();
    });
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    return this.mutate((session) => {
      const item = session.items.pop();
      session.updatedAt = new Date().toISOString();
      return item;
    });
  }

  async clearSession(relatedCleanup?: () => Promise<void>): Promise<void> {
    await this.mutate(async (session) => {
      if (session.checkpoint?.status === 'running' && checkpointOwnerIsLive(session.checkpoint)) {
        throw new Error(`Session ${this.id} 仍有任务运行中，不能清空`);
      }
      await relatedCleanup?.();
      session.items = [];
      session.checkpoint = undefined;
      session.contextArchive = undefined;
      session.updatedAt = new Date().toISOString();
    });
  }

  async summary(): Promise<SessionSummary> {
    return summarizeSession(await this.load());
  }

  async cleanupGeneratedSummaries(): Promise<number> {
    return this.mutateWhen((session) => {
      const items = session.items.filter((item) => {
        if (!('role' in item) || item.role !== 'user' || !('content' in item)) return true;
        return typeof item.content !== 'string' || !item.content.startsWith('[更早的会话历史已压缩为摘要');
      });
      const removed = session.items.length - items.length;
      if (removed > 0) {
        session.items = items;
        session.contextArchive = undefined;
        session.updatedAt = new Date().toISOString();
      }
      return { result: removed, changed: removed > 0 };
    });
  }

  async repairToolPairs(): Promise<number> {
    return this.mutateWhen((session) => {
      const callIndexes = new Map<string, number>();
      const resultIndexes = new Map<string, number>();
      session.items.forEach((item, index) => {
        if (!('type' in item) || !('callId' in item)) return;
        const callId = String(item.callId);
        if (item.type === 'function_call' && !callIndexes.has(callId)) callIndexes.set(callId, index);
        if (item.type === 'function_call_result') {
          const callIndex = callIndexes.get(callId);
          if (callIndex !== undefined && index > callIndex && !resultIndexes.has(callId)) resultIndexes.set(callId, index);
        }
      });
      const items = session.items.filter((item, index) => {
        if (!('type' in item) || !('callId' in item)) return true;
        const callId = String(item.callId);
        if (item.type === 'function_call') return callIndexes.get(callId) === index && resultIndexes.has(callId);
        if (item.type === 'function_call_result') return resultIndexes.get(callId) === index;
        return true;
      });
      const removed = session.items.length - items.length;
      if (removed) {
        session.items = items;
        session.contextArchive = undefined;
        session.updatedAt = new Date().toISOString();
      }
      return { result: removed, changed: removed > 0 };
    });
  }

  static async list(directory: string): Promise<string[]> {
    try {
      return (await readdir(directory))
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -5))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  static async listSummaries(directory: string): Promise<SessionSummary[]> {
    const ids = await FileSession.list(directory);
    const summaries = (await Promise.all(ids.map(async (id) => {
      try {
        return await new FileSession(directory, id).summary();
      } catch (error) {
        if (error instanceof StateFileCorruptError) return undefined;
        throw error;
      }
    }))).filter((summary): summary is SessionSummary => summary !== undefined);
    return summaries.sort((left, right) => {
      const active = right.updatedAt.localeCompare(left.updatedAt);
      return active || left.id.localeCompare(right.id);
    });
  }

  private async load(): Promise<SessionFile> {
    return this.state.read();
  }

  private mutate<T>(mutation: (session: SessionFile) => T): Promise<T> {
    return this.state.update(mutation);
  }

  private mutateWhen<T>(mutation: (session: SessionFile) => { result: T; changed: boolean }): Promise<T> {
    return this.state.updateWhen(mutation);
  }

  private async finishRun(
    status: Exclude<RunStatus, 'running'>,
    update: Pick<RunCheckpoint, 'phase'> & Partial<Pick<RunCheckpoint, 'answer' | 'error' | 'nextAction'>>,
    expectedRunId?: string,
  ): Promise<RunCheckpoint | undefined> {
    return this.mutateWhen((session) => {
      if (!session.checkpoint) return { result: undefined, changed: false };
      if ((expectedRunId && session.checkpoint.runId !== expectedRunId)
        || session.checkpoint.status !== 'running') {
        return { result: { ...session.checkpoint }, changed: false };
      }
      const now = new Date().toISOString();
      session.checkpoint = {
        ...session.checkpoint,
        ...update,
        status,
        ownerId: undefined,
        ownerPid: undefined,
        updatedAt: now,
      };
      session.updatedAt = now;
      return { result: { ...session.checkpoint }, changed: true };
    });
  }
}
