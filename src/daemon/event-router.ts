import type { MimiStore } from './store.js';
import type { EventRouteReceipt, ImmutableEvent, TaskRouteInput } from './types.js';

export type EventRoutePolicy = (
  event: ImmutableEvent,
) => Omit<TaskRouteInput, 'routerVersion'> | undefined;

export class EventRouter {
  constructor(
    private readonly store: MimiStore,
    private readonly routerVersion: string,
    private readonly policy: EventRoutePolicy = () => undefined,
    private readonly lifecyclePolicy?: EventRoutePolicy,
  ) {}

  routeEvent(
    eventId: string,
    override?: Omit<TaskRouteInput, 'routerVersion'>,
  ): EventRouteReceipt {
    const existing = this.store.getEventRouteReceipt(eventId);
    if (existing) return existing;
    const event = this.store.getImmutableEvent(eventId);
    if (!event) throw new Error(`Event 不存在：${eventId}`);
    const configured = override ?? (event.type.startsWith('task.')
      ? this.lifecyclePolicy?.(event)
      : this.policy(event));
    const route = configured ?? {
      decision: 'observe_only' as const,
      reasonCode: event.type.startsWith('task.') ? 'task_lifecycle' : 'no_matching_route',
    };
    return this.store.routeEvent(event.id, { ...route, routerVersion: this.routerVersion });
  }
}
