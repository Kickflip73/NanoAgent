export type RuntimeEvent =
  | { type: 'run_start'; sessionId: string; input: string }
  | { type: 'run_end'; sessionId: string; answer: string }
  | { type: 'run_error'; sessionId: string; error: string }
  | { type: 'subagent_event'; sessionId: string; agent: string; eventType: string };

export type RuntimeHook = (event: RuntimeEvent) => void | Promise<void>;

export class HookBus {
  private hooks = new Set<RuntimeHook>();

  on(hook: RuntimeHook): () => void {
    this.hooks.add(hook);
    return () => this.hooks.delete(hook);
  }

  async emit(event: RuntimeEvent): Promise<void> {
    await Promise.all([...this.hooks].map(async (hook) => hook(event)));
  }
}
