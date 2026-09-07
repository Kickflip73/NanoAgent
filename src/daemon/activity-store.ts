import { runFailureRecord } from '../core/run-failure.js';
import {
  aggregateDeadLetters,
  classifyDigestAges,
} from './operational-classification.js';
import {
  buildDailyResourceTrends,
  type DailyUsageSample,
} from './resource-slo.js';
import { listEventSummaries } from './event-store.js';
import { listOutboxSummaries } from './outbox-store.js';
import { listRunSummaries } from './run-store.js';
import {
  aggregateRunSourceUsage,
  classifyRunSource,
  isAutonomousRunCategory,
  type AutonomousBudgetExhaustion,
  type AutonomousBudgetReason,
  type RunUsageFact,
} from './run-source.js';
import {
  optionalText as optional,
  parseOptionalJson,
  hashedStateKey,
  SqliteDomain,
  type SqliteRow as Row,
} from './sqlite-domain.js';
import type {
  ImmutableEvent,
  MimiActivitySnapshot,
  OutboxStatus,
  TaskRecord,
  TaskStatus,
  TaskType,
} from './types.js';

const AUTONOMOUS_BUDGET_REASONS = new Set<AutonomousBudgetReason>([
  'hourly_budget',
  'daily_budget',
  'source_hourly_budget',
  'token_hourly_budget',
  'token_daily_budget',
  'source_token_hourly_budget',
  'token_usage_unavailable',
]);

function parseAutonomousBudgetExhaustion(value: unknown): AutonomousBudgetExhaustion | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.source !== 'string'
      || !AUTONOMOUS_BUDGET_REASONS.has(parsed.reasonCode as AutonomousBudgetReason)
      || typeof parsed.exhaustedAt !== 'string'
      || typeof parsed.retryAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.exhaustedAt))
      || !Number.isFinite(Date.parse(parsed.retryAt))) return undefined;
    return {
      source: parsed.source,
      reasonCode: parsed.reasonCode as AutonomousBudgetReason,
      exhaustedAt: parsed.exhaustedAt,
      retryAt: parsed.retryAt,
    };
  } catch {
    return undefined;
  }
}

function runUsageFact(row: Row): RunUsageFact {
  const tokens = (key: 'input_tokens' | 'output_tokens') => (
    typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0
      ? row[key] as number : undefined
  );
  const inputTokens = tokens('input_tokens');
  const outputTokens = tokens('output_tokens');
  return {
    taskType: String(row.type) as TaskType,
    source: String(row.source ?? ''),
    trust: String(row.trust) as ImmutableEvent['trust'],
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

export class ActivityStore extends SqliteDomain {

  usageReport(days = 7, at = new Date()) {
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('统计天数必须是 1–90 的整数');
    const since = new Date(at.getTime() - days * 86_400_000).toISOString();
    const until = at.toISOString();
    const tasks = this.database.prepare(`
      SELECT type, status, COUNT(*) AS count, SUM(MAX(0, attempt_count - 1)) AS retries
      FROM tasks WHERE created_at >= ? AND created_at <= ? GROUP BY type, status
    `).all(since, until) as Row[];
    const runs = this.database.prepare(`
      SELECT tasks.type, runs.status, runs.started_at, runs.completed_at,
        json_extract(runs.answer_json, '$.usage.runInputTokens') AS input_tokens,
        json_extract(runs.answer_json, '$.usage.runOutputTokens') AS output_tokens
      FROM runs JOIN tasks ON tasks.id = runs.task_id
      WHERE runs.started_at >= ? AND runs.started_at <= ?
    `).all(since, until) as Row[];
    const failures = this.database.prepare(`
      SELECT type, COALESCE(json_extract(result_json, '$.failure.code'), 'unclassified') AS code,
        COUNT(*) AS count FROM tasks WHERE created_at >= ? AND created_at <= ?
        AND status IN ('failed', 'dead_letter') GROUP BY type, code ORDER BY count DESC LIMIT 20
    `).all(since, until) as Row[];
    const types: TaskType[] = ['conversation', 'background', 'scheduled', 'briefing', 'memory_maintenance'];
    return {
      since, until,
      scope: '保留数据中在窗口内创建的 Task；耗时和 Token 按窗口内启动的 Run 统计。completed 是执行结束，不代表回答正确或用户满意。',
      byType: types.map((type) => {
        const rows = tasks.filter((row) => row.type === type);
        const attempts = runs.filter((row) => row.type === type);
        const durationMs = attempts.filter((row) => typeof row.completed_at === 'string')
          .map((row) => Date.parse(String(row.completed_at)) - Date.parse(String(row.started_at)))
          .filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
        const metered = attempts.filter((row) => typeof row.input_tokens === 'number'
          && typeof row.output_tokens === 'number' && row.input_tokens >= 0 && row.output_tokens >= 0);
        const percentile = (p: number) => durationMs.length
          ? durationMs[Math.max(0, Math.ceil(durationMs.length * p) - 1)]! : null;
        return {
          type, tasks: rows.reduce((sum, row) => sum + Number(row.count), 0),
          statuses: Object.fromEntries(rows.map((row) => [String(row.status), Number(row.count)])),
          retries: rows.reduce((sum, row) => sum + Number(row.retries), 0),
          runs: attempts.length,
          durationMs: { samples: durationMs.length, p50: percentile(0.5), p95: percentile(0.95) },
          tokens: { sampledRuns: metered.length, unmeteredRuns: attempts.length - metered.length,
            input: metered.length ? metered.reduce((sum, row) => sum + Number(row.input_tokens), 0) : null,
            output: metered.length ? metered.reduce((sum, row) => sum + Number(row.output_tokens), 0) : null },
        };
      }),
      failures: failures.map((row) => ({ type: String(row.type), code: String(row.code), count: Number(row.count) })),
    };
  }

  healthSnapshot(at = new Date()): Pick<MimiActivitySnapshot,
    'generatedAt' | 'pendingDigest' | 'unknownRunSources' | 'autonomousBudgetExhaustions'> {
    // Status is a liveness probe. Do not read result bodies, historical cost
    // trends, or dead-letter payloads on every CLI connection.
    const sources = this.database.prepare(`
      SELECT tasks.type, COALESCE(trigger_event.source, authority_event.source) AS source,
        COALESCE(trigger_event.trust, authority_event.trust) AS trust, COUNT(*) AS count
      FROM runs JOIN tasks ON tasks.id = runs.task_id
      LEFT JOIN events trigger_event ON trigger_event.id = tasks.trigger_event_id
      JOIN events authority_event ON authority_event.id = tasks.authority_event_id
      WHERE runs.started_at >= ? GROUP BY 1, 2, 3
    `).all(new Date(at.getTime() - 24 * 60 * 60_000).toISOString()) as Row[];
    return {
      generatedAt: at.toISOString(),
      pendingDigest: Number((this.database.prepare(
        'SELECT COUNT(*) AS count FROM digest_items WHERE digested_at IS NULL',
      ).get() as Row).count),
      unknownRunSources: sources.reduce((sum, row) => sum + (
        classifyRunSource(runUsageFact(row)) === 'unknown' ? Number(row.count) : 0
      ), 0),
      autonomousBudgetExhaustions: this.activeAutonomousBudgetExhaustions(at),
    };
  }

  private runUsageFactsSince(since: Date): RunUsageFact[] {
    return (this.database.prepare(`
      SELECT tasks.type,
        COALESCE(trigger_event.source, authority_event.source) AS source,
        COALESCE(trigger_event.trust, authority_event.trust) AS trust,
        COALESCE(json_extract(runs.answer_json, '$.usage.runInputTokens'), CASE WHEN json_extract(tasks.result_json, '$.failure.disposition.dispatchStarted') = 0 THEN 0 END) AS input_tokens,
        COALESCE(json_extract(runs.answer_json, '$.usage.runOutputTokens'), CASE WHEN json_extract(tasks.result_json, '$.failure.disposition.dispatchStarted') = 0 THEN 0 END) AS output_tokens
      FROM runs
      JOIN tasks ON tasks.id = runs.task_id
      LEFT JOIN events trigger_event ON trigger_event.id = tasks.trigger_event_id
      JOIN events authority_event ON authority_event.id = tasks.authority_event_id
      WHERE runs.started_at >= ?
    `).all(since.toISOString()) as Row[]).map(runUsageFact);
  }

  countRunsSince(since: Date, source?: string): number {
    const row = source
      ? this.database.prepare(`
          SELECT COUNT(*) AS count FROM runs
          JOIN tasks ON tasks.id = runs.task_id
          LEFT JOIN events trigger_event ON trigger_event.id = tasks.trigger_event_id
          JOIN events authority_event ON authority_event.id = tasks.authority_event_id
          WHERE runs.started_at >= ?
            AND COALESCE(trigger_event.source, authority_event.source) = ?
        `).get(since.toISOString(), source)
      : this.database.prepare('SELECT COUNT(*) AS count FROM runs WHERE started_at >= ?')
        .get(since.toISOString());
    return Number((row as Row).count);
  }

  autonomousBudgetUsageSince(since: Date, source?: string): {
    runs: number;
    reservedRuns: number;
    unmeteredRuns: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } {
    const facts = this.runUsageFactsSince(since).filter((fact) => (
      (source === undefined || fact.source === source)
      && isAutonomousRunCategory(classifyRunSource(fact))
    ));
    const taskRows = this.database.prepare(`
      SELECT tasks.type, COALESCE(trigger_event.source, authority_event.source) AS source,
        COALESCE(trigger_event.trust, authority_event.trust) AS trust
      FROM tasks
      LEFT JOIN events trigger_event ON trigger_event.id = tasks.trigger_event_id
      JOIN events authority_event ON authority_event.id = tasks.authority_event_id
      WHERE tasks.status IN ('queued', 'running')
    `).all() as Row[];
    const reservedRuns = taskRows.map(runUsageFact).filter((fact) => {
      return (source === undefined || fact.source === source)
        && isAutonomousRunCategory(classifyRunSource(fact));
    }).length;
    const inputTokens = facts.reduce((total, fact) => total + (fact.inputTokens ?? 0), 0);
    const outputTokens = facts.reduce((total, fact) => total + (fact.outputTokens ?? 0), 0);
    return {
      runs: facts.length,
      reservedRuns,
      unmeteredRuns: facts.filter((fact) => (
        fact.inputTokens === undefined || fact.outputTokens === undefined
      )).length,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }

  recordAutonomousBudgetExhaustion(
    source: string,
    reasonCode: AutonomousBudgetReason,
    retryAt: Date,
    at = new Date(),
  ): boolean {
    if (!source.trim() || source.length > 200 || !Number.isFinite(retryAt.getTime())) {
      throw new Error('自治预算来源或恢复时间无效');
    }
    return this.transaction(() => {
      const key = hashedStateKey('autonomous-budget', source);
      const existing = parseAutonomousBudgetExhaustion(this.attentionState(key));
      const timestamp = at.toISOString();
      const next: AutonomousBudgetExhaustion = {
        source,
        reasonCode,
        exhaustedAt: existing?.exhaustedAt ?? timestamp,
        retryAt: existing?.reasonCode === reasonCode && existing.retryAt < retryAt.toISOString() ? existing.retryAt : retryAt.toISOString(),
      };
      if (existing) {
        if (existing.reasonCode !== reasonCode || existing.retryAt !== next.retryAt) {
          this.database.prepare('UPDATE attention_state SET value = ?, updated_at = ? WHERE key = ?')
            .run(JSON.stringify(next), timestamp, key);
        }
        return false;
      }
      this.upsertAttentionState(key, JSON.stringify(next), timestamp);
      this.audit('attention.budget_exhausted', key, { source, reasonCode, retryAt: next.retryAt }, timestamp);
      return true;
    });
  }

  clearAutonomousBudgetExhaustion(source: string, at = new Date()): boolean {
    return this.transaction(() => {
      const key = hashedStateKey('autonomous-budget', source);
      const existing = parseAutonomousBudgetExhaustion(this.attentionState(key));
      if (!existing) return false;
      const timestamp = at.toISOString();
      this.database.prepare('DELETE FROM attention_state WHERE key = ?').run(key);
      this.audit('attention.budget_recovered', key, {
        source,
        previousReasonCode: existing.reasonCode,
      }, timestamp);
      return true;
    });
  }

  activeAutonomousBudgetExhaustions(at = new Date()): AutonomousBudgetExhaustion[] {
    const timestamp = at.toISOString();
    return (this.database.prepare(`
      SELECT value FROM attention_state WHERE key LIKE 'autonomous-budget:%' ORDER BY key
    `).all() as Row[]).map((row) => parseAutonomousBudgetExhaustion(row.value))
      .filter((item): item is AutonomousBudgetExhaustion => item !== undefined && item.retryAt > timestamp)
      .sort((left, right) => left.source.localeCompare(right.source));
  }

  counts(): {
    events: { total: number };
    tasks: Record<TaskStatus, number>;
    outbox: Record<OutboxStatus, number>;
    enabledSchedules: number;
  } {
    const taskStatuses: TaskStatus[] = [
      'queued', 'running', 'paused', 'blocked', 'completed', 'failed', 'cancelled', 'dead_letter',
    ];
    const outboxStatuses: OutboxStatus[] = ['pending', 'sending', 'sent', 'dead_letter', 'archived'];
    const events = {
      total: Number((this.database.prepare('SELECT COUNT(*) AS count FROM events').get() as Row).count),
    };
    const tasks = Object.fromEntries(taskStatuses.map((status) => [status, 0])) as Record<TaskStatus, number>;
    const outbox = Object.fromEntries(outboxStatuses.map((status) => [status, 0])) as Record<OutboxStatus, number>;
    for (const row of this.database.prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status').all() as Row[]) {
      tasks[String(row.status) as TaskStatus] = Number(row.count);
    }
    for (const row of this.database.prepare('SELECT status, COUNT(*) AS count FROM outbox GROUP BY status').all() as Row[]) {
      outbox[String(row.status) as OutboxStatus] = Number(row.count);
    }
    const enabledSchedules = Number((this.database.prepare(
      'SELECT COUNT(*) AS count FROM schedules WHERE enabled = 1',
    ).get() as Row).count);
    return { events, tasks, outbox, enabledSchedules };
  }

  activitySnapshot(requestedLimit = 10, at = new Date()): MimiActivitySnapshot {
    const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(20, requestedLimit)) : 10;
    const counts = this.counts();
    const taskTypes: TaskRecord['type'][] = [
      'conversation', 'background', 'scheduled', 'briefing', 'memory_maintenance',
    ];
    const taskStatuses: TaskRecord['status'][] = [
      'queued', 'running', 'paused', 'blocked', 'completed', 'failed', 'cancelled', 'dead_letter',
    ];
    const tasksByType = Object.fromEntries(taskTypes.map((type) => [
      type,
      Object.fromEntries(taskStatuses.map((status) => [status, 0])),
    ])) as MimiActivitySnapshot['tasksByType'];
    for (const row of this.database.prepare(`
      SELECT type, status, COUNT(*) AS count FROM tasks GROUP BY type, status
    `).all() as Row[]) {
      const type = String(row.type) as TaskRecord['type'];
      const status = String(row.status) as TaskRecord['status'];
      if (tasksByType[type]) tasksByType[type][status] = Number(row.count);
    }
    const pendingDigest = Number((this.database.prepare(`
      SELECT COUNT(*) AS count FROM digest_items WHERE digested_at IS NULL
    `).get() as Row).count);
    const recentEvents = listEventSummaries(this.database, limit);
    const recentTasks = (this.database.prepare(`
      SELECT task.id, task.type, task.status, task.trigger_event_id,
        event.source, event.type AS event_type,
        task.priority, task.attempt_count, task.updated_at, task.error, task.result_json
      FROM tasks task LEFT JOIN events event ON event.id = task.trigger_event_id
      ORDER BY task.updated_at DESC, task.rowid DESC LIMIT ?
    `).all(limit) as Row[]).map((row) => {
      const failure = runFailureRecord(parseOptionalJson<{ failure?: unknown }>(row.result_json)?.failure);
      return {
        id: String(row.id),
        type: String(row.type) as TaskRecord['type'],
        status: String(row.status) as TaskRecord['status'],
        triggerEventId: optional(row.trigger_event_id),
        source: optional(row.source),
        eventType: optional(row.event_type),
        priority: Number(row.priority),
        attemptCount: Number(row.attempt_count),
        updatedAt: String(row.updated_at),
        error: optional(row.error)?.slice(0, 500),
        ...(failure ? { failure } : {}),
      };
    });
    const recentRuns = listRunSummaries(this.database, limit, 'updated');
    const recentDeliveries = listOutboxSummaries(this.database, limit, 'updated');
    const recentTransitions = (this.database.prepare(`
      SELECT sequence, event_type, entity_id, created_at
      FROM audit_events ORDER BY sequence DESC LIMIT ?
    `).all(limit) as Row[]).map((row) => ({
      sequence: Number(row.sequence),
      type: String(row.event_type),
      entityId: String(row.entity_id),
      createdAt: String(row.created_at),
    }));
    const usageSamples = (this.database.prepare(`
      SELECT substr(updated_at, 1, 10) AS day, COUNT(*) AS runs,
        COALESCE(SUM(CAST(json_extract(result_json, '$.usage.runInputTokens') AS INTEGER)), 0) AS input_tokens,
        COALESCE(SUM(CAST(json_extract(result_json, '$.usage.runOutputTokens') AS INTEGER)), 0) AS output_tokens,
        SUM(CAST(json_extract(result_json, '$.usage.costUsd') AS REAL)) AS cost_usd,
        COUNT(json_extract(result_json, '$.usage.costUsd')) AS cost_samples
      FROM tasks WHERE status = 'completed' AND result_json IS NOT NULL
      GROUP BY substr(updated_at, 1, 10) ORDER BY day DESC LIMIT 31
    `).all() as Row[]).map((row): DailyUsageSample => ({
      at: `${String(row.day)}T12:00:00.000Z`,
      runs: Number(row.runs),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      costUsd: Number(row.cost_samples) === Number(row.runs) ? Number(row.cost_usd) : null,
      cpuSeconds: null,
      memoryBytes: null,
      diskBytes: null,
    }));
    const deadLetters = aggregateDeadLetters((this.database.prepare(`
      SELECT result_json, COUNT(*) AS count FROM tasks
      WHERE status = 'dead_letter' GROUP BY result_json
    `).all() as Row[]).map((row) => ({
      failure: runFailureRecord(parseOptionalJson<{ failure?: unknown }>(row.result_json)?.failure),
      count: Number(row.count),
    })));
    const digest = classifyDigestAges((this.database.prepare(`
      SELECT occurred_at FROM digest_items WHERE digested_at IS NULL
    `).all() as Row[]).map((row) => String(row.occurred_at)), at.getTime());
    const runUsageBySource = aggregateRunSourceUsage(
      this.runUsageFactsSince(new Date(at.getTime() - 24 * 60 * 60_000)),
    );
    const unknownRunSources = runUsageBySource.find((item) => item.category === 'unknown')?.runs ?? 0;
    const autonomousBudgetExhaustions = this.activeAutonomousBudgetExhaustions(at);
    return {
      generatedAt: at.toISOString(),
      needsAttention: counts.tasks.blocked > 0 || counts.tasks.dead_letter > 0
        || counts.outbox.dead_letter > 0 || unknownRunSources > 0
        || autonomousBudgetExhaustions.length > 0,
      workPending: counts.tasks.queued + counts.tasks.running + counts.tasks.paused + counts.tasks.blocked
        + counts.outbox.pending + counts.outbox.sending + pendingDigest,
      pendingDigest,
      enabledSchedules: counts.enabledSchedules,
      events: counts.events,
      tasks: counts.tasks,
      tasksByType,
      outbox: counts.outbox,
      recentEvents,
      recentTasks,
      recentRuns,
      recentDeliveries,
      recentTransitions,
      resourceTrends: buildDailyResourceTrends(usageSamples),
      runUsageBySource,
      unknownRunSources,
      autonomousBudgetExhaustions,
      failureClassification: {
        deadLetters,
        digest,
        unclassifiedDeadLetters: deadLetters
          .filter((item) => item.category === 'unknown')
          .reduce((total, item) => total + item.count, 0),
      },
    };
  }
}
