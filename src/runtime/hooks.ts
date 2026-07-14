import type { PlanStep } from '../core/plan.js';

export type RuntimeEvent =
  | { type: 'run_start'; sessionId: string; input: string }
  | { type: 'run_end'; sessionId: string; answer: string }
  | { type: 'run_error'; sessionId: string; error: string; interrupted?: boolean }
  | { type: 'subagent_event'; sessionId: string; agent: string; eventType: string }
  | { type: 'plan_updated'; sessionId: string; steps: PlanStep[] }
  | {
      type: 'team_worker_event';
      sessionId: string;
      taskId: string;
      role: string;
      description: string;
      result?: string;
      eventType: 'start' | 'end' | 'error';
    };

export type RuntimeHook = (event: RuntimeEvent) => void | Promise<void>;

export interface HookDiagnostic {
  eventType: RuntimeEvent['type'];
  error: string;
  occurredAt: string;
}

export class HookBus {
  private hooks = new Set<RuntimeHook>();
  private failures: HookDiagnostic[] = [];

  on(hook: RuntimeHook): () => void {
    this.hooks.add(hook);
    return () => this.hooks.delete(hook);
  }

  async emit(event: RuntimeEvent): Promise<void> {
    const results = await Promise.allSettled([...this.hooks].map(async (hook) => hook(event)));
    for (const result of results) {
      if (result.status === 'fulfilled') continue;
      this.failures.push({
        eventType: event.type,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        occurredAt: new Date().toISOString(),
      });
    }
    if (this.failures.length > 50) this.failures.splice(0, this.failures.length - 50);
  }

  diagnostics(): HookDiagnostic[] {
    return this.failures.map((failure) => ({ ...failure }));
  }
}
