import type { EventTrust, TaskType } from './types.js';

export const RUN_SOURCE_CATEGORIES = [
  'owner_conversation',
  'connector',
  'health',
  'briefing',
  'maintenance',
  'routine',
  'task_follow_up',
  'eval',
  'unknown',
] as const;

export type RunSourceCategory = typeof RUN_SOURCE_CATEGORIES[number];

export interface RunSourceUsage {
  category: RunSourceCategory;
  autonomous: boolean;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokenSampling: 'known' | 'partial' | 'unavailable';
  sources: string[];
}

export type AutonomousBudgetReason =
  | 'hourly_budget'
  | 'daily_budget'
  | 'source_hourly_budget'
  | 'token_hourly_budget'
  | 'token_daily_budget'
  | 'source_token_hourly_budget'
  | 'token_usage_unavailable';

export interface AutonomousBudgetExhaustion {
  source: string;
  reasonCode: AutonomousBudgetReason;
  exhaustedAt: string;
  retryAt: string;
}

export interface RunUsageFact {
  taskType: TaskType;
  source: string;
  trust: EventTrust;
  inputTokens?: number;
  outputTokens?: number;
}

export function classifyRunSource(input: Pick<RunUsageFact, 'taskType' | 'source' | 'trust'>): RunSourceCategory {
  if (input.taskType === 'briefing' || input.source === 'attention:briefing') return 'briefing';
  if (input.taskType === 'memory_maintenance' || input.source === 'mimi:memory-maintenance') {
    return 'maintenance';
  }
  if (input.taskType === 'scheduled'
    || input.source === 'attention:routine'
    || input.source === 'attention:routine-authority') return 'routine';
  if (input.source === 'system:connector-health') return 'health';
  if (input.source === 'mimi:task') return 'task_follow_up';
  if (input.source.startsWith('eval:')
    || input.source.startsWith('mimi:eval')
    || input.source.startsWith('m1:eval')) return 'eval';
  if (input.trust === 'owner') return 'owner_conversation';
  if (input.trust === 'external' || input.trust === 'public' || input.trust === 'trusted') {
    return 'connector';
  }
  return 'unknown';
}

export function isAutonomousRunCategory(category: RunSourceCategory): boolean {
  return category !== 'owner_conversation' && category !== 'eval';
}

export function aggregateRunSourceUsage(facts: readonly RunUsageFact[]): RunSourceUsage[] {
  const totals = new Map<RunSourceCategory, RunSourceUsage & { sampledRuns: number }>();
  for (const category of RUN_SOURCE_CATEGORIES) {
    totals.set(category, {
      category,
      autonomous: isAutonomousRunCategory(category),
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      tokenSampling: 'unavailable',
      sources: [],
      sampledRuns: 0,
    });
  }
  for (const fact of facts) {
    const category = classifyRunSource(fact);
    const current = totals.get(category)!;
    current.runs += 1;
    if (!current.sources.includes(fact.source)) current.sources.push(fact.source);
    if (fact.inputTokens !== undefined && fact.outputTokens !== undefined) {
      current.inputTokens += fact.inputTokens;
      current.outputTokens += fact.outputTokens;
      current.sampledRuns += 1;
    }
  }
  return RUN_SOURCE_CATEGORIES.map((category) => {
    const current = totals.get(category)!;
    current.sources.sort();
    current.totalTokens = current.inputTokens + current.outputTokens;
    current.tokenSampling = current.sampledRuns === 0
      ? 'unavailable'
      : current.sampledRuns === current.runs ? 'known' : 'partial';
    const { sampledRuns: _sampledRuns, ...usage } = current;
    return usage;
  });
}
