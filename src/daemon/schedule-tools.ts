import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import { MimiStore } from './store.js';
import type { ImmutableEvent, ReplyRoute, ScheduleRecord, TaskRecord } from './types.js';

const MAX_ENABLED_SCHEDULES = 100;
const MIN_FOLLOW_UP_DELAY_MS = 5_000;
const MAX_FOLLOW_UP_DELAY_MS = 5 * 365 * 24 * 60 * 60_000;
const MIN_ROUTINE_MINUTES = 5;

function assertScheduleCapacity(store: MimiStore): void {
  const enabled = store.listSchedules().filter((schedule) => schedule.enabled).length;
  if (enabled >= MAX_ENABLED_SCHEDULES) {
    throw new Error(`已达到 ${MAX_ENABLED_SCHEDULES} 个启用中计划的上限，请先清理旧计划`);
  }
}

function conversationAuthority(store: MimiStore, task: TaskRecord): ImmutableEvent {
  const authority = store.getImmutableEvent(task.authorityEventId);
  if (!authority) {
    throw new Error('创建 Schedule 需要仍可验证的原始 Conversation authority Event');
  }
  return authority;
}

function baseSchedule(
  store: MimiStore,
  task: TaskRecord,
  event: ImmutableEvent,
  fallbackRoute?: ReplyRoute,
  activeSessionKey?: string,
) {
  const authority = conversationAuthority(store, task);
  const objective = task.objective && typeof task.objective === 'object'
    ? task.objective as Record<string, unknown>
    : {};
  const sessionKey = typeof objective.originSessionId === 'string'
    ? objective.originSessionId
    : activeSessionKey ?? task.sessionKey;
  return {
    profileId: authority.profileId,
    sessionKey,
    replyRoute: event.replyRoute ?? fallbackRoute ?? { channel: 'system' },
    trust: authority.trust,
    authorityEventId: authority.id,
  };
}

function sameRoute(left: ReplyRoute | undefined, right: ReplyRoute | undefined): boolean {
  return left?.channel === right?.channel && left?.target === right?.target;
}

export function isAuthenticScheduleTask(
  store: MimiStore,
  schedule: ScheduleRecord,
  task: TaskRecord,
  event: ImmutableEvent,
): boolean {
  const storedTask = store.getTask(task.id);
  const storedEvent = store.getImmutableEvent(event.id);
  if (!storedTask || !storedEvent || task.type !== 'scheduled') return false;
  const payload = task.objective && typeof task.objective === 'object'
    ? task.objective as Record<string, unknown>
    : {};
  return event.source === `schedule:${schedule.id}`
    && event.externalId === `${schedule.id}:${event.occurredAt}`
    && task.triggerEventId === event.id
    && task.authorityEventId === schedule.authorityEventId
    && task.sessionKey === `mimi-task-${task.id}`
    && task.profileId === schedule.profileId
    && event.trust === schedule.trust
    && sameRoute(event.replyRoute, schedule.replyRoute ?? { channel: 'system' })
    && payload.type === 'scheduled_task'
    && payload.scheduleId === schedule.id
    && payload.scheduleType === schedule.type
    && payload.name === schedule.name
    && payload.prompt === schedule.prompt
    && payload.objective === schedule.prompt
    && payload.strategy === 'single'
    && payload.workspaceAccess === 'write';
}

function currentSchedule(store: MimiStore, task: TaskRecord, event: ImmutableEvent): ScheduleRecord | undefined {
  const payload = task.objective && typeof task.objective === 'object'
    ? task.objective as Record<string, unknown>
    : undefined;
  if (typeof payload?.scheduleId !== 'string') return undefined;
  const schedule = store.getSchedule(payload.scheduleId);
  if (!schedule || (schedule.type !== 'interval' && schedule.type !== 'watch')) return undefined;
  return isAuthenticScheduleTask(store, schedule, task, event) ? schedule : undefined;
}

export function createMimiScheduleTools(
  store: MimiStore,
  task: TaskRecord,
  event: ImmutableEvent,
  fallbackRoute?: ReplyRoute,
  activeSessionKey?: string,
): Tool[] {
  const followUp = tool({
    name: 'schedule_mimi_follow_up',
    description: '为当前 MimiAgent 事务创建一次后续唤醒。适合提醒、等待外部变化后复查、在约定时间继续任务。时间必须是带时区的 ISO 8601，创建后应在回答中明确告知。',
    parameters: z.object({
      name: z.string().min(1).max(100),
      prompt: z.string().min(1).max(4_000).describe('到点后 MimiAgent 要完成的具体任务，而不只是模糊提醒'),
      runAt: z.string().min(1).max(100).describe('带时区的 ISO 8601 时间，例如 2026-07-15T18:30:00+08:00'),
    }),
    execute: async ({ name, prompt, runAt }) => {
      assertScheduleCapacity(store);
      const target = Date.parse(runAt);
      const now = Date.now();
      if (!Number.isFinite(target)) throw new Error('runAt 不是有效的 ISO 8601 时间');
      if (target < now + MIN_FOLLOW_UP_DELAY_MS) throw new Error('后续唤醒至少应在 5 秒之后');
      if (target > now + MAX_FOLLOW_UP_DELAY_MS) throw new Error('后续唤醒不能超过 5 年');
      return store.addSchedule({
        ...baseSchedule(store, task, event, fallbackRoute, activeSessionKey),
        name, prompt, type: 'at', value: new Date(target).toISOString(),
        nextRunAt: new Date(target).toISOString(),
      });
    },
  });

  const routine = tool({
    name: 'schedule_mimi_routine',
    description: '为当前 MimiAgent 事务创建周期巡检。适合定期检查项目、消息、天气、账单或其他变化。最短周期 5 分钟，创建后应在回答中明确告知。',
    parameters: z.object({
      name: z.string().min(1).max(100),
      prompt: z.string().min(1).max(4_000).describe('每次唤醒时要检查、判断和必要时通知的完整任务'),
      everyMinutes: z.number().int().min(MIN_ROUTINE_MINUTES).max(525_600),
    }),
    execute: async ({ name, prompt, everyMinutes }) => {
      assertScheduleCapacity(store);
      const interval = everyMinutes * 60_000;
      return store.addSchedule({
        ...baseSchedule(store, task, event, fallbackRoute, activeSessionKey),
        name, prompt, type: 'interval', value: String(interval),
        nextRunAt: new Date(Date.now() + interval).toISOString(),
      });
    },
  });

  const watch = tool({
    name: 'schedule_mimi_watch',
    description: '持续追踪一个尚未完成的工作或生活事项，直到明确结束条件成立。MimiAgent 会周期检查、处理可推进步骤，只在有重要变化时通知；结束后自动停止当前监控。最短周期 5 分钟。',
    parameters: z.object({
      name: z.string().min(1).max(100),
      check: z.string().min(1).max(1_500).describe('每次唤醒需要检查、判断和可直接执行的具体动作'),
      stopWhen: z.string().min(1).max(1_500).describe('可客观判断的结束条件，例如“收到对方明确回复且没有未处理问题”'),
      everyMinutes: z.number().int().min(MIN_ROUTINE_MINUTES).max(525_600),
    }),
    execute: async ({ name, check, stopWhen, everyMinutes }) => {
      assertScheduleCapacity(store);
      const interval = everyMinutes * 60_000;
      const prompt = [
        `持续监控：${name}`,
        `本次检查与推进：${check}`,
        `结束条件：${stopWhen}`,
        '直接使用可用工具完成能推进的步骤。若结束条件已成立，调用 complete_current_mimi_schedule 停止后续检查并汇报结果；若尚未成立且没有值得 owner 关注的新变化，调用 finish_mimi_silently。',
      ].join('\n');
      return store.addSchedule({
        ...baseSchedule(store, task, event, fallbackRoute, activeSessionKey),
        name, prompt, type: 'watch', value: String(interval),
        nextRunAt: new Date(Date.now() + interval).toISOString(),
      });
    },
  });

  const list = tool({
    name: 'list_mimi_schedules',
    description: '列出 MimiAgent 当前的一次性后续唤醒和周期巡检，包括 ID、下次时间与是否启用。',
    parameters: z.object({}),
    execute: async () => store.listSchedules().slice(0, MAX_ENABLED_SCHEDULES),
  });

  const cancel = tool({
    name: 'cancel_mimi_schedule',
    description: '按精确 ID 取消一个 MimiAgent 后续唤醒或周期巡检。当用户要求取消或原事务确定结束时使用。',
    parameters: z.object({ id: z.string().uuid() }),
    execute: async ({ id }) => ({ id, removed: store.removeSchedule(id) }),
  });

  const activeSchedule = currentSchedule(store, task, event);
  const completeCurrent = activeSchedule ? [tool({
    name: 'complete_current_mimi_schedule',
    description: '仅当本次周期巡检的目标或结束条件已经明确达成时，完成并停止当前计划，防止继续无意义轮询。无需查找或传入计划 ID。',
    parameters: z.object({}),
    execute: async () => ({ id: activeSchedule.id, completed: store.removeSchedule(activeSchedule.id) }),
  })] : [];

  return [followUp, routine, watch, list, cancel, ...completeCurrent];
}
