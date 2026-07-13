import { Agent, type Tool } from '@openai/agents';
import type { AgentModel } from '../runtime/model.js';

function selectTools(tools: Tool[], names: string[]): Tool[] {
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

export function createSubAgentTools(options: {
  model: AgentModel;
  tools: Tool[];
  persistentInstructions?: string;
  onEvent?: (agent: string, eventType: string) => void | Promise<void>;
}): Tool[] {
  const researcher = new Agent({
    name: 'Nano Researcher',
    model: options.model,
    instructions: [
      options.persistentInstructions,
      '你是独立研究子 Agent，只处理主 Agent 委派的明确子任务。',
      '检索或检查一手资料，区分事实与推断，返回紧凑结论和来源。',
      '不要修改文件，不要继续委派其他 Agent；若持久指令与只读职责冲突，以本职责为准。',
    ].filter(Boolean).join('\n\n'),
    tools: selectTools(options.tools, ['current_time', 'read_file', 'list_directory', 'search_files', 'http_request', 'web_search', 'search_knowledge']),
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
    tools: selectTools(options.tools, ['read_file', 'list_directory', 'search_files', 'search_knowledge']),
  });

  return [
    researcher.asTool({
      toolName: 'delegate_research',
      toolDescription: '把独立、资料密集的研究子任务交给只读 researcher；简单查询不要委派。',
      runOptions: { maxTurns: 16 },
      onStream: async ({ event }) => forwardEvent(options.onEvent, 'researcher', event.type),
    }),
    reviewer.asTool({
      toolName: 'delegate_review',
      toolDescription: '把边界清晰的代码、文档或方案审查交给只读 reviewer。',
      runOptions: { maxTurns: 12 },
      onStream: async ({ event }) => forwardEvent(options.onEvent, 'reviewer', event.type),
    }),
  ];
}
