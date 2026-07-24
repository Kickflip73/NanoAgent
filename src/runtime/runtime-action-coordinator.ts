import type { ExecutionLedger } from '../core/execution-ledger.js';
import {
  runtimeActionSchema,
  runtimeEffectSchema,
  type RuntimeAction,
  type RuntimeEffect,
} from './control.js';

const RUNTIME_ACTION_TOOLS = new Set([
  'switch_model', 'switch_mode', 'set_output_level', 'switch_session',
  'new_session', 'clear_session', 'reload_mcp', 'request_exit',
]);

const RUNTIME_ACTION_ORDER: Record<RuntimeAction['type'], number> = {
  clear_session: 0,
  switch_model: 1,
  switch_mode: 2,
  set_output_level: 3,
  reload_mcp: 4,
  switch_session: 5,
  new_session: 5,
  exit: 6,
};

export interface CompletedRunActionSource {
  pendingActions: readonly RuntimeAction[];
  sessionId: string;
  executionKey?: string;
  retainExecutionLedger: boolean;
}

type RuntimeActionApplier = (
  action: RuntimeAction,
  originSessionId: string,
  retainedExecutionKey?: string,
) => Promise<RuntimeEffect>;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function actionFromSuccessfulTool(toolName: string, output: unknown): RuntimeAction | undefined {
  if (!RUNTIME_ACTION_TOOLS.has(toolName)) return undefined;
  const value = objectValue(output);
  const expected = toolName === 'switch_model' || toolName === 'switch_mode'
    ? 'next_turn'
    : 'after_current_turn';
  if (!value || value.effective !== expected) throw new Error(`Runtime 控制工具 ${toolName} 的账本输出无效`);
  if (toolName === 'switch_model') return runtimeActionSchema.parse({ type: 'switch_model', model: value.model });
  if (toolName === 'switch_mode') return runtimeActionSchema.parse({ type: 'switch_mode', mode: value.mode });
  if (toolName === 'set_output_level') {
    return runtimeActionSchema.parse({ type: 'set_output_level', level: value.level });
  }
  if (toolName === 'switch_session') {
    return runtimeActionSchema.parse({ type: 'switch_session', sessionId: value.sessionId });
  }
  if (toolName === 'new_session') {
    return runtimeActionSchema.parse({ type: 'new_session', sessionId: value.sessionId });
  }
  if (toolName === 'clear_session') return { type: 'clear_session' };
  if (toolName === 'reload_mcp') return { type: 'reload_mcp' };
  return { type: 'exit' };
}

export function normalizedRuntimeActions(actions: readonly RuntimeAction[]): RuntimeAction[] {
  const unique = new Map<string, RuntimeAction>();
  for (const candidate of actions) {
    const action = runtimeActionSchema.parse(candidate);
    unique.set(JSON.stringify(action), action);
  }
  const selected = [...unique.values()];
  for (const type of ['switch_model', 'switch_mode', 'set_output_level'] as const) {
    if (selected.filter((action) => action.type === type).length > 1) {
      throw new Error(`同一 Run 包含冲突的 ${type} RuntimeAction`);
    }
  }
  if (selected.filter((action) => action.type === 'switch_session' || action.type === 'new_session').length > 1) {
    throw new Error('同一 Run 包含冲突的 Session RuntimeAction');
  }
  return selected.sort((left, right) => (
    RUNTIME_ACTION_ORDER[left.type] - RUNTIME_ACTION_ORDER[right.type]
      || JSON.stringify(left).localeCompare(JSON.stringify(right))
  ));
}

export class RuntimeActionCoordinator {
  constructor(
    private readonly ledger: ExecutionLedger,
    private readonly applyRuntimeAction: RuntimeActionApplier,
  ) {}

  async actionsForCompletedRun(source: CompletedRunActionSource): Promise<RuntimeAction[]> {
    if (!source.retainExecutionLedger || !source.executionKey) {
      return source.pendingActions.map((action) => runtimeActionSchema.parse(action));
    }
    const persisted = await this.ledger.listSucceededCalls(source.sessionId, source.executionKey);
    const recovered = persisted
      .map((call) => actionFromSuccessfulTool(call.toolName, call.output))
      .filter((action): action is RuntimeAction => action !== undefined);
    return normalizedRuntimeActions([...source.pendingActions, ...recovered]);
  }

  async apply(
    actions: readonly RuntimeAction[],
    originSessionId: string,
    executionKey?: string,
  ): Promise<RuntimeEffect[]> {
    const effects: RuntimeEffect[] = [];
    const selected = executionKey
      ? normalizedRuntimeActions(actions)
      : actions.map((action) => runtimeActionSchema.parse(action));
    for (const [index, action] of selected.entries()) {
      const apply = () => this.applyRuntimeAction(action, originSessionId, executionKey);
      const effect = executionKey
        ? await this.ledger.executeOnce<unknown>({
            sessionId: originSessionId,
            runId: `${executionKey}:runtime-actions`,
            toolName: '__mimi_runtime_action__',
            callId: `${index}:${action.type}`,
            argumentsJson: JSON.stringify(action),
          }, apply)
        : await apply();
      effects.push(runtimeEffectSchema.parse(effect));
    }
    return effects;
  }
}
