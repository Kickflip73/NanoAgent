import {
  Agent,
  MemorySession,
  OpenAIChatCompletionsModel,
  Runner,
} from '@openai/agents';
import OpenAI from 'openai';
import { createTools } from './tools.js';

export class NanoAgent {
  private readonly agent: Agent;
  private readonly session: MemorySession;
  private readonly runner: Runner;

  constructor(workspaceRoot: string) {
    const provider = process.env.MODEL_PROVIDER ?? 'openai';
    const model =
      provider === 'deepseek'
        ? new OpenAIChatCompletionsModel(
            new OpenAI({
              apiKey: process.env.DEEPSEEK_API_KEY,
              baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
              fetch: globalThis.fetch,
            }),
            process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
          )
        : (process.env.OPENAI_MODEL ?? 'gpt-5.4-mini');

    this.session = new MemorySession({ sessionId: 'local-cli' });
    this.runner = new Runner({
      workflowName: 'NanoAgent CLI',
      tracingDisabled: provider !== 'openai',
      traceIncludeSensitiveData: false,
    });
    this.agent = new Agent({
      name: 'NanoAgent',
      model,
      instructions: [
        '你是运行在用户电脑上的轻量级个人助手。',
        '默认使用中文，回答简洁、直接。',
        '需要实时信息、文件内容、计算或系统操作时必须调用工具，不要猜测。',
        '你处于开发者全能力模式，可以读写文件、执行 Shell、联网搜索和运行代码。',
        '执行任务后说明实际完成了什么；不要声称完成了未实际执行的操作。',
      ].join('\n'),
      tools: createTools(workspaceRoot, provider === 'openai'),
    });
  }

  async stream(input: string) {
    return this.runner.run(this.agent, input, {
      session: this.session,
      maxTurns: 200,
      stream: true,
    });
  }
}
