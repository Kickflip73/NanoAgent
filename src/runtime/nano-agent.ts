import path from 'node:path';
import {
  Agent,
  Runner,
  type AgentInputItem,
  type Tool,
} from '@openai/agents';
import OpenAI from 'openai';
import type { AppConfig } from '../config.js';
import { ContextManager, estimateTokens } from '../core/context.js';
import { MemoryStore } from '../core/memory.js';
import { PlanStore } from '../core/plan.js';
import { FileSession } from '../core/session.js';
import { TraceStore } from '../core/trace.js';
import { MCPManager } from '../extensions/mcp.js';
import { RagStore } from '../extensions/rag.js';
import { SkillLoader } from '../extensions/skills.js';
import { createSubAgentTools } from '../extensions/subagents.js';
import { createTools } from '../tools.js';
import { HookBus } from './hooks.js';
import { AGENT_MODES, BASE_INSTRUCTIONS, type AgentMode } from './instructions.js';
import { createModel, type AgentModel } from './model.js';

export { AGENT_MODES } from './instructions.js';
export type { AgentMode } from './instructions.js';

export class NanoAgent {
  private readonly runner: Runner;
  private readonly context: ContextManager;
  private readonly memory: MemoryStore;
  private readonly skills: SkillLoader;
  private readonly rag: RagStore;
  private readonly plans: PlanStore;
  private readonly traces: TraceStore;
  private readonly mcp: MCPManager;
  private readonly hooks = new HookBus();
  private readonly tools: Tool[];
  private session: FileSession;
  private sessionId: string;
  private mode: AgentMode = 'standard';
  private lastContextTokens = 0;

  private constructor(
    private readonly config: AppConfig,
    private model: AgentModel,
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
    this.hooks.on(async (event) => {
      const traceType = event.type === 'run_start'
        ? 'turn_start'
        : event.type === 'run_end'
          ? 'turn_end'
          : event.type === 'run_error' ? 'error' : event.type;
      await this.traces.record(event.sessionId, traceType, event);
    });
    this.tools = [
      ...createTools(config.workspaceRoot, config.provider === 'openai'),
      ...this.memory.createTools(),
      ...this.skills.createTools(),
      ...this.rag.createTools(),
      ...this.plans.createTools(),
      ...this.mcp.createTools(),
    ];
  }

  private modelName: string;

  static async create(config: AppConfig): Promise<NanoAgent> {
    const modelRuntime = createModel(config);
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
    const agent = new NanoAgent(config, modelRuntime.model, {
      context: new ContextManager(config.historyLimit, config.contextWindow),
      memory,
      skills,
      rag,
      plans,
      traces,
      mcp,
      sessionId,
      modelName: modelRuntime.name,
    });
    return agent;
  }

  async stream(input: string, signal?: AbortSignal) {
    await this.session.cleanupGeneratedSummaries();
    await this.session.repairToolPairs();
    const [memories, documents, plan, goal, history] = await Promise.all([
      this.memory.search(input),
      this.rag.search(input, 4, false),
      this.plans.get(),
      this.plans.getGoal(),
      this.session.getItems(),
    ]);
    const instructions = this.context.buildInstructions({
      baseInstructions: `${BASE_INSTRUCTIONS}\n当前模式：${this.currentMode.label}。${this.currentMode.instruction}`,
      historySummary: this.context.summarizeHistory(history),
      skillCatalog: this.skills.catalog(),
      memories,
      documents,
      plan,
      goal,
    });
    const effectiveHistory = await this.context.sessionInput(history, [
      { role: 'user', content: input } as AgentInputItem,
    ]);
    this.lastContextTokens = estimateTokens(instructions) + estimateTokens(effectiveHistory);
    const subAgentTools = createSubAgentTools({
      model: this.model,
      tools: this.tools,
      onEvent: async (agent, eventType) => this.hooks.emit({
        type: 'subagent_event',
        sessionId: this.sessionId,
        agent,
        eventType,
      }),
    });
    const agent = new Agent({
      name: 'NanoAgent',
      model: this.model,
      instructions,
      tools: [...this.tools, ...subAgentTools],
      mcpServers: this.mcp.servers,
      mcpConfig: { includeServerInToolNames: true },
    });
    await this.hooks.emit({ type: 'run_start', sessionId: this.sessionId, input });
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

  async history(): Promise<AgentInputItem[]> {
    return this.session.getItems();
  }

  async clearSession(): Promise<void> {
    await this.session.clearSession();
  }

  listSkills() {
    return this.skills.list();
  }

  async reloadSkills() {
    await this.skills.load();
    return { skills: this.skills.list(), warnings: this.skills.diagnostics() };
  }

  async listMemories() {
    return this.memory.list();
  }

  async currentPlan() {
    return this.plans.get();
  }

  async currentGoal() {
    return this.plans.getGoal();
  }

  async setGoal(objective: string) {
    return this.plans.setGoal(objective);
  }

  async resumePrompt(): Promise<string> {
    return this.plans.resumePrompt();
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
      mcpStatuses: this.mcp.statuses(),
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
    const runtime = createModel(this.config, modelName);
    this.modelName = runtime.name;
    this.model = runtime.model;
  }

  availableModes() {
    return AGENT_MODES.map(({ id, label, description }) => ({ id, label, description }));
  }

  switchMode(mode: string): void {
    if (!AGENT_MODES.some((item) => item.id === mode)) throw new Error(`未知模式：${mode}`);
    this.mode = mode as AgentMode;
  }

  async contextInfo() {
    const [history, memories, plan, goal] = await Promise.all([
      this.session.getItems(),
      this.memory.list(),
      this.plans.get(),
      this.plans.getGoal(),
    ]);
    return {
      historyItems: history.length,
      historyLimit: this.config.historyLimit,
      estimatedTokens: this.lastContextTokens || estimateTokens(history),
      contextWindow: this.config.contextWindow,
      memories: memories.length,
      planSteps: plan.length,
      goal: goal?.status,
    };
  }

  get toolNames(): string[] {
    return [...this.tools.map((item) => item.name), 'delegate_research', 'delegate_review'].sort();
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

  mcpStatuses() {
    return this.mcp.statuses();
  }

  async reloadMcp() {
    return this.mcp.reload();
  }

  async recordEvent(type: string, data?: unknown): Promise<void> {
    if (type === 'status' && data && typeof data === 'object') {
      const value = data as Record<string, unknown>;
      await this.traces.record(this.sessionId, type, {
        kind: value.kind,
        tone: value.tone,
        title: value.title,
        detail: typeof value.detail === 'string' ? value.detail.slice(0, 1_000) : value.detail,
        next: value.next,
      });
      return;
    }
    await this.traces.record(this.sessionId, type, data);
  }

  async completeRun(answer: string): Promise<void> {
    await this.hooks.emit({ type: 'run_end', sessionId: this.sessionId, answer });
  }

  async failRun(error: unknown): Promise<void> {
    await this.hooks.emit({
      type: 'run_error',
      sessionId: this.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  async close(): Promise<void> {
    await this.mcp.close();
  }

  private createSession(id: string): FileSession {
    return new FileSession(path.join(this.config.dataRoot, 'sessions'), id);
  }
}
