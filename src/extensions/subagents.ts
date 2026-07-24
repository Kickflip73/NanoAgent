import { Agent, type Tool } from '@openai/agents';
import type { AgentMode } from '../core/agent-mode.js';
import { subAgentToolNames } from '../core/tool-role-policy.js';
import type {
  WorkUnitDescriptor,
  WorkUnitObservation,
  WorkUnitResult,
} from '../core/work-unit.js';
import type { AgentModel } from './model-port.js';

function selectTools(tools: Tool[], names: readonly string[]): Tool[] {
  const allowed = new Set(names);
  return tools.filter((tool) => allowed.has(tool.name));
}

async function forwardEvent(
  callback: ((agent: string, eventType: string) => void | Promise<void>) | undefined,
  agent: string,
  eventType: string,
): Promise<void> {
  if (eventType === 'raw_model_stream_event') return;
  await callback?.(agent, eventType);
}

export interface SubAgentToolsOptions {
  mode: AgentMode;
  model: AgentModel;
  tools: Tool[];
  persistentInstructions?: string;
  parentRunId?: string;
  onEvent?: (agent: string, eventType: string) => void | Promise<void>;
  onWorkUnit?: (observation: WorkUnitObservation) => void | Promise<void>;
}

function delegatedObjective(argumentsJson: string | undefined): string {
  if (!argumentsJson) return 'Delegated subagent task';
  try {
    const parsed = JSON.parse(argumentsJson) as { input?: unknown };
    return typeof parsed.input === 'string' ? parsed.input : argumentsJson;
  } catch {
    return argumentsJson;
  }
}

function observedSubAgentTool(
  agent: Agent,
  role: 'researcher' | 'reviewer' | 'architect',
  toolName: string,
  toolDescription: string,
  options: SubAgentToolsOptions,
): Tool {
  const started = new Map<string, string>();
  return agent.asTool({
    toolName,
    toolDescription,
    runOptions: { maxTurns: null },
    onStream: async ({ event, toolCall }) => {
      const id = toolCall?.callId ?? `${options.parentRunId ?? 'run'}:${toolName}`;
      if (!started.has(id)) started.set(id, new Date().toISOString());
      await forwardEvent(options.onEvent, role, event.type);
    },
    customOutputExtractor: async (output) => {
      const invocation = output.agentToolInvocation;
      const id = invocation.toolCallId ?? `${options.parentRunId ?? 'run'}:${toolName}`;
      const objective = delegatedObjective(invocation.toolArguments);
      const descriptor: WorkUnitDescriptor = {
        id,
        kind: 'subagent',
        parentRunId: options.parentRunId ?? 'unbound-run',
        objective: objective.slice(0, 8_000),
        role,
        dependencies: [],
        capabilities: role === 'researcher' ? ['read', 'network-read', 'memory-read'] : ['read', 'memory-read'],
        workspaceAccess: 'read',
        paths: [],
      };
      const summary = String(output.finalOutput ?? 'SubAgent 未返回摘要');
      const completedAt = new Date().toISOString();
      const result: WorkUnitResult = {
        id,
        status: 'completed',
        summary,
        artifacts: [],
        evidence: [{ type: 'agent-tool-call', ref: `${toolName}:${id}` }],
        startedAt: started.get(id) ?? new Date().toISOString(),
        completedAt,
      };
      try {
        await options.onWorkUnit?.({
          descriptor,
          status: 'completed',
          observedAt: completedAt,
          result,
        });
      } catch {
        // WorkUnit observers are telemetry and cannot change the nested result.
      } finally {
        started.delete(id);
      }
      return JSON.stringify(result);
    },
  });
}

export function createSubAgentTools(options: SubAgentToolsOptions): Tool[] {
  const researcher = new Agent({
    name: 'Nano Researcher',
    model: options.model,
    instructions: [
      options.persistentInstructions,
      '你是独立研究子 Agent，只处理主 Agent 委派的明确子任务。',
      '检索或检查一手资料，区分事实与推断，返回紧凑结论和来源。',
      '不要修改文件，不要继续委派其他 Agent；若持久指令与只读职责冲突，以本职责为准。',
    ].filter(Boolean).join('\n\n'),
    tools: selectTools(options.tools, subAgentToolNames('researcher')),
  });
  const reviewer = new Agent({
    name: 'Nano Reviewer',
    model: options.model,
    instructions: [
      options.persistentInstructions,
      '你是独立审查子 Agent，检查指定代码、文档或方案。',
      '优先发现正确性、兼容性、安全性和测试缺口，按严重程度返回可操作意见。',
      '保持只读，不修改文件，不继续委派其他 Agent；若持久指令与只读职责冲突，以本职责为准。',
    ].filter(Boolean).join('\n\n'),
    tools: selectTools(options.tools, subAgentToolNames('reviewer')),
  });
  const architect = new Agent({
    name: 'Nano Architect',
    model: options.model,
    instructions: [
      options.persistentInstructions,
      '你是独立架构子 Agent，只负责分析边界、数据流、方案取舍、风险与验证策略。',
      '必须保持只读，不修改文件、不运行命令、不继续委派；输出可实施但不实施的紧凑设计。',
    ].filter(Boolean).join('\n\n'),
    tools: selectTools(options.tools, subAgentToolNames('architect')),
  });

  const tools = [
    observedSubAgentTool(
      researcher,
      'researcher',
      'delegate_research',
      '把独立、资料密集的研究子任务交给只读 researcher；简单查询不要委派。',
      options,
    ),
    observedSubAgentTool(
      reviewer,
      'reviewer',
      'delegate_review',
      '把边界清晰的代码、文档或方案审查交给只读 reviewer。',
      options,
    ),
  ];
  if (options.mode !== 'general') {
    tools.splice(1, 0, observedSubAgentTool(
      architect,
      'architect',
      'delegate_architecture',
      '把边界清晰的架构分析或实施方案设计交给只读 architect。',
      options,
    ));
  }
  return tools;
}
