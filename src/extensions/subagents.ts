import { Agent, type Tool } from '@openai/agents';
import type { AgentMode } from '../core/agent-mode.js';
import { subAgentToolNames } from '../core/tool-role-policy.js';
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
  onEvent?: (agent: string, eventType: string) => void | Promise<void>;
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
    researcher.asTool({
      toolName: 'delegate_research',
      toolDescription: '把独立、资料密集的研究子任务交给只读 researcher；简单查询不要委派。',
      runOptions: { maxTurns: null },
      onStream: async ({ event }) => forwardEvent(options.onEvent, 'researcher', event.type),
    }),
    reviewer.asTool({
      toolName: 'delegate_review',
      toolDescription: '把边界清晰的代码、文档或方案审查交给只读 reviewer。',
      runOptions: { maxTurns: null },
      onStream: async ({ event }) => forwardEvent(options.onEvent, 'reviewer', event.type),
    }),
  ];
  if (options.mode !== 'general') {
    tools.splice(1, 0, architect.asTool({
      toolName: 'delegate_architecture',
      toolDescription: '把边界清晰的架构分析或实施方案设计交给只读 architect。',
      runOptions: { maxTurns: null },
      onStream: async ({ event }) => forwardEvent(options.onEvent, 'architect', event.type),
    }));
  }
  return tools;
}
