import path from 'node:path';
import {
  Agent,
  OpenAIChatCompletionsModel,
  Runner,
  type RunStreamEvent,
} from '@openai/agents';
import OpenAI from 'openai';
import type { AppConfig } from './config.js';
import { ContextManager } from './core/context.js';
import { MemoryStore } from './core/memory.js';
import { PlanStore } from './core/plan.js';
import { FileSession } from './core/session.js';
import { TraceStore } from './core/trace.js';
import { MCPManager } from './extensions/mcp.js';
import { RagStore } from './extensions/rag.js';
import { SkillLoader } from './extensions/skills.js';
import { createTools } from './tools.js';

const BASE_INSTRUCTIONS = [
  '你是运行在用户电脑上的轻量级个人助手。',
  '默认使用中文，回答简洁、直接。',
  '所有回答会显示在终端中：默认控制在 12 行以内，简单问题优先使用 1～3 个紧凑段落；只有用户明确要求详细展开时才增加篇幅。',
  '避免 Markdown 表格、连续标题、频繁空行和每句单独换行；短信息使用“标签：内容 · 标签：内容”的紧凑形式。',
  '列表通常不超过 5 项，每项保持单行；不要用空格手工对齐，不要在数值与单位之间换行，例如写成 34°C、5km、20%。',
  '除非能明显帮助阅读，否则不要使用 Emoji、引用块或多级列表；回答结论优先，补充说明随后。',
  '需要实时信息、文件内容、计算或系统操作时必须调用工具，不要猜测。',
  '你可以使用 Skill 学习特定任务的工作流，使用知识库和长期记忆补充上下文。',
  '复杂任务先使用 update_plan 给出简短计划，并在执行过程中更新状态；简单问题不要创建计划。',
  '用户明确要求记住某件事时调用 remember；不要保存密码、密钥等敏感信息。',
  '执行任务后说明实际完成了什么；不要声称完成了未实际执行的操作。',
].join('\n');

export const AGENT_MODES = [
  { id: 'standard', label: '标准', description: '平衡速度与完整性', instruction: '按任务需要自主选择直接回答或调用工具。' },
  { id: 'plan', label: '规划', description: '先分析和规划再执行', instruction: '除简单问题外，先明确目标并使用 update_plan 制定步骤，再开始执行。' },
  { id: 'code', label: '编码', description: '面向代码修改与验证', instruction: '优先检查现有代码，实施最小清晰改动，并运行相关检查和测试。' },
  { id: 'research', label: '调研', description: '多来源检索与归纳', instruction: '先收集可靠信息并交叉验证，再区分事实、推断与不确定项。' },
] as const;

export type AgentMode = typeof AGENT_MODES[number]['id'];

export class NanoAgent {
  private readonly runner: Runner;
  private readonly context: ContextManager;
  private readonly memory: MemoryStore;
  private readonly skills: SkillLoader;
  private readonly rag: RagStore;
  private readonly plans: PlanStore;
  private readonly traces: TraceStore;
  private readonly mcp: MCPManager;
  private readonly tools: ReturnType<typeof createTools>;
  private session: FileSession;
  private sessionId: string;
  private mode: AgentMode = 'standard';

  private constructor(
    private readonly config: AppConfig,
    private model: string | OpenAIChatCompletionsModel,
    components: {
      context: ContextManager;
      memory: MemoryStore;
      skills: SkillLoader;
      rag: RagStore;
      plans: PlanStore;
      traces: TraceStore;
      mcp: MCPManager;
      sessionId: string;
      modelName: string;
    },
  ) {
    this.context = components.context;
    this.memory = components.memory;
    this.skills = components.skills;
    this.rag = components.rag;
    this.plans = components.plans;
    this.traces = components.traces;
    this.mcp = components.mcp;
    this.sessionId = components.sessionId;
    this.modelName = components.modelName;
    this.session = this.createSession(this.sessionId);
    this.runner = new Runner({
      workflowName: 'NanoAgent CLI',
      // Local JSONL traces stay provider-independent and avoid sending tool data elsewhere.
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
    });
    this.tools = [
      ...createTools(config.workspaceRoot, config.provider === 'openai'),
      ...this.memory.createTools(),
      ...this.skills.createTools(),
      ...this.rag.createTools(),
      ...this.plans.createTools(),
    ];
  }

  private modelName: string;

  static async create(config: AppConfig): Promise<NanoAgent> {
    const model = config.provider === 'deepseek'
      ? new OpenAIChatCompletionsModel(
          new OpenAI({
            apiKey: process.env.DEEPSEEK_API_KEY,
            baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
            fetch: globalThis.fetch,
          }),
          process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
        )
      : (process.env.OPENAI_MODEL ?? 'gpt-5.4-mini');
    const modelName = config.provider === 'deepseek'
      ? (process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash')
      : (process.env.OPENAI_MODEL ?? 'gpt-5.4-mini');
    const embeddingClient = process.env.OPENAI_API_KEY
      ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: globalThis.fetch })
      : undefined;
    const sessionId = process.env.AGENT_SESSION ?? 'default';
    const memory = new MemoryStore(path.join(config.dataRoot, 'memories.json'));
    const skills = new SkillLoader(config.skillsRoot);
    const rag = new RagStore(config.workspaceRoot, path.join(config.dataRoot, 'rag-index.json'), embeddingClient);
    const traces = new TraceStore(path.join(config.dataRoot, 'traces'));
    const mcp = new MCPManager(config.mcpConfig, config.workspaceRoot);
    const plans = new PlanStore(path.join(config.dataRoot, 'plans.json'), sessionId);
    await skills.load();
    await mcp.connect();
    const agent = new NanoAgent(config, model, {
      context: new ContextManager(config.historyLimit),
      memory,
      skills,
      rag,
      plans,
      traces,
      mcp,
      sessionId,
      modelName,
    });
    return agent;
  }

  async stream(input: string, signal?: AbortSignal) {
    await this.session.cleanupGeneratedSummaries();
    await this.session.repairToolPairs();
    const [memories, documents, plan, history] = await Promise.all([
      this.memory.search(input),
      this.rag.search(input),
      this.plans.get(),
      this.session.getItems(),
    ]);
    const instructions = this.context.buildInstructions({
      baseInstructions: `${BASE_INSTRUCTIONS}\n当前模式：${this.currentMode.label}。${this.currentMode.instruction}`,
      historySummary: this.context.summarizeHistory(history),
      skillCatalog: this.skills.catalog(),
      memories,
      documents,
      plan,
    });
    const agent = new Agent({
      name: 'NanoAgent',
      model: this.model,
      instructions,
      tools: this.tools,
      mcpServers: this.mcp.servers,
      mcpConfig: { includeServerInToolNames: true },
    });
    await this.traces.record(this.sessionId, 'turn_start', { input });
    return this.runner.run(agent, input, {
      session: this.session,
      sessionInputCallback: this.context.sessionInput,
      maxTurns: this.config.maxTurns,
      stream: true,
      signal,
    });
  }

  async switchSession(sessionId: string): Promise<void> {
    this.sessionId = sessionId;
    this.session = this.createSession(sessionId);
    await this.session.ensure();
    this.plans.useSession(sessionId);
  }

  async listSessions(): Promise<string[]> {
    return FileSession.list(path.join(this.config.dataRoot, 'sessions'));
  }

  async listSessionSummaries() {
    return FileSession.listSummaries(path.join(this.config.dataRoot, 'sessions'));
  }

  async history(): Promise<unknown[]> {
    return this.session.getItems();
  }

  async clearSession(): Promise<void> {
    await this.session.clearSession();
  }

  listSkills() {
    return this.skills.list();
  }

  async listMemories() {
    return this.memory.list();
  }

  async currentPlan() {
    return this.plans.get();
  }

  async runtimeInfo() {
    const sessionSummary = await this.session.summary();
    return {
      provider: this.config.provider,
      model: this.modelName,
      mode: this.currentMode,
      sessionId: this.sessionId,
      sessionTitle: sessionSummary.title,
      workspaceRoot: this.config.workspaceRoot,
      maxTurns: this.config.maxTurns,
      skillCount: this.skills.list().length,
      memoryCount: (await this.memory.list()).length,
      mcpServers: this.mcpServerNames,
    };
  }

  availableModels(): string[] {
    const configured = this.config.provider === 'deepseek'
      ? process.env.DEEPSEEK_MODELS
      : process.env.OPENAI_MODELS;
    const defaults = this.config.provider === 'deepseek'
      ? ['deepseek-chat', 'deepseek-reasoner']
      : ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5-mini'];
    return [...new Set([
      this.modelName,
      ...(configured?.split(',').map((item) => item.trim()).filter(Boolean) ?? []),
      ...defaults,
    ])];
  }

  switchModel(modelName: string): void {
    if (!/^[a-zA-Z0-9._:/-]+$/.test(modelName)) throw new Error('模型名称格式无效');
    this.modelName = modelName;
    this.model = this.config.provider === 'deepseek'
      ? new OpenAIChatCompletionsModel(
          new OpenAI({
            apiKey: process.env.DEEPSEEK_API_KEY,
            baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
            fetch: globalThis.fetch,
          }),
          modelName,
        )
      : modelName;
  }

  availableModes() {
    return AGENT_MODES.map(({ id, label, description }) => ({ id, label, description }));
  }

  switchMode(mode: string): void {
    if (!AGENT_MODES.some((item) => item.id === mode)) throw new Error(`未知模式：${mode}`);
    this.mode = mode as AgentMode;
  }

  async contextInfo() {
    const [history, memories, plan] = await Promise.all([
      this.session.getItems(),
      this.memory.list(),
      this.plans.get(),
    ]);
    return {
      historyItems: history.length,
      historyLimit: this.config.historyLimit,
      estimatedTokens: history.length ? Math.ceil(JSON.stringify(history).length / 4) : 0,
      contextWindow: this.config.contextWindow,
      memories: memories.length,
      planSteps: plan.length,
    };
  }

  get toolNames(): string[] {
    return this.tools.map((item) => item.name).sort();
  }

  private get currentMode() {
    return AGENT_MODES.find((item) => item.id === this.mode)!;
  }

  async indexKnowledge(target?: string) {
    return this.rag.index(target);
  }

  get currentSessionId(): string {
    return this.sessionId;
  }

  get mcpServerNames(): string[] {
    return this.mcp.servers.map((server) => server.name);
  }

  async recordEvent(type: string, data?: unknown): Promise<void> {
    await this.traces.record(this.sessionId, type, data);
  }

  async close(): Promise<void> {
    await this.mcp.close();
  }

  private createSession(id: string): FileSession {
    return new FileSession(path.join(this.config.dataRoot, 'sessions'), id);
  }
}
