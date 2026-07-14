import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  Agent,
  Runner,
  type AgentInputItem,
  type Tool,
} from '@openai/agents';
import type { AgentPermissionMode, AppConfig } from '../config.js';
import { ContextManager, estimateTokens, type ContextStats } from '../core/context.js';
import { GuidanceLoader } from '../core/guidance.js';
import { ExecutionLedger } from '../core/execution-ledger.js';
import { MemoryStore } from '../core/memory.js';
import { PlanStore } from '../core/plan.js';
import { TeamTaskStore } from '../core/team.js';
import { FileSession, registerSessionRunOwner, type RunCheckpoint } from '../core/session.js';
import { TraceStore } from '../core/trace.js';
import { MCPManager } from '../extensions/mcp.js';
import { RagStore } from '../extensions/rag.js';
import { SkillLoader } from '../extensions/skills.js';
import { createSubAgentTools } from '../extensions/subagents.js';
import { createTeamTools } from '../extensions/team.js';
import { createTools } from '../tools.js';
import { HookBus, type RuntimeHook } from './hooks.js';
import {
  createRuntimeControlTools,
  RUNTIME_OUTPUT_LEVELS,
  type RuntimeAction,
  type RuntimeEffect,
  type RuntimeOutputLevel,
} from './control.js';
import { AGENT_MODES, BASE_INSTRUCTIONS, type AgentMode } from './instructions.js';
import { createModel, type AgentModel } from './model.js';
import type { ModelProfile } from './model.js';
import { buildResumePrompt, recoverySummary, sessionStateSummary } from './session-state.js';
import { toolNamesForMode, toolsForMode, toolsForPermission } from './tool-policy.js';
import { withExecutionLedger } from './tool-ledger.js';
import { createRuntimeComponents, type RuntimeComponents } from './components.js';
import { createTeamWorkerTools } from './team-worker-tools.js';
import {
  explicitlyRequestsSessionAccess,
  explicitlyRequestsSessionClear,
} from '../core/user-intent.js';

export { AGENT_MODES } from './instructions.js';
export type { AgentMode } from './instructions.js';

interface ActiveRun {
  runId: string;
  ownerId: string;
  releaseOwner: () => void;
  sessionId: string;
  session: FileSession;
  input: string;
  pendingActions: RuntimeAction[];
}

export interface ContextUsageSnapshot {
  lastRequestInputTokens?: number;
  lastRequestOutputTokens?: number;
  runInputTokens?: number;
  runOutputTokens?: number;
  runTotalTokens?: number;
}

export class NanoAgent {
  private readonly runner: Runner;
  private model: AgentModel;
  private context: ContextManager;
  private readonly guidance: GuidanceLoader;
  private readonly memory: MemoryStore;
  private readonly skills: SkillLoader;
  private readonly rag: RagStore;
  private readonly plans: PlanStore;
  private readonly team: TeamTaskStore;
  private readonly traces: TraceStore;
  private readonly ledger: ExecutionLedger;
  private readonly mcp: MCPManager;
  private readonly hooks = new HookBus();
  private readonly tools: Tool[];
  private session: FileSession;
  private sessionId: string;
  private mode: AgentMode = AGENT_MODES.some((item) => item.id === process.env.AGENT_MODE)
    ? process.env.AGENT_MODE as AgentMode
    : 'general';
  private outputLevel: RuntimeOutputLevel = RUNTIME_OUTPUT_LEVELS.includes(process.env.OUTPUT_LEVEL as RuntimeOutputLevel)
    ? process.env.OUTPUT_LEVEL as RuntimeOutputLevel
    : 'tools';
  private readonly defaultMode: AgentMode;
  private readonly defaultOutputLevel: RuntimeOutputLevel;
  private readonly defaultModelName: string;
  private readonly permissionMode: AgentPermissionMode;
  private activeRun?: ActiveRun;
  private lastContextTokens = 0;
  private lastContextStats?: ContextStats;
  private modelProfile: ModelProfile;
  private lastUsage?: ContextUsageSnapshot;
  private readonly runtimeRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

  private constructor(
    private readonly config: AppConfig,
    components: RuntimeComponents,
  ) {
    this.model = components.modelRuntime.model;
    this.context = components.context;
    this.guidance = components.guidance;
    this.memory = components.memory;
    this.skills = components.skills;
    this.rag = components.rag;
    this.plans = components.plans;
    this.team = components.team;
    this.traces = components.traces;
    this.ledger = components.ledger;
    this.mcp = components.mcp;
    this.sessionId = components.sessionId;
    this.modelName = components.modelRuntime.name;
    this.modelProfile = components.modelRuntime.profile;
    this.permissionMode = config.permissionMode ?? 'workspace';
    this.defaultMode = this.mode;
    this.defaultOutputLevel = this.outputLevel;
    this.defaultModelName = this.modelName;
    this.session = this.createSession(this.sessionId);
    this.plans.onChange((sessionId, steps) => this.hooks.emit({ type: 'plan_updated', sessionId, steps }));
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
          : event.type === 'run_error' ? (event.interrupted ? 'turn_interrupted' : 'error') : event.type;
      await this.traces.record(event.sessionId, traceType, event);
    });
    const localAccess = this.permissionMode === 'trusted'
      ? { allowProtectedPathShellAccess: true }
      : {
          readablePaths: ['.'],
          writablePaths: this.permissionMode === 'read-only' ? [] : ['.'],
          allowWrite: this.permissionMode !== 'read-only',
          allowShell: false,
        };
    this.tools = toolsForPermission(this.permissionMode, [
      ...createTools(config.workspaceRoot, config.provider === 'openai', [
        config.dataRoot,
        path.join(os.homedir(), '.nano-agent'),
      ], localAccess),
      ...this.skills.createTools(),
      ...this.rag.createTools(),
      ...this.mcp.createTools(),
      ...createRuntimeControlTools({
        status: () => this.runtimeInfo(),
        models: () => this.availableModels(),
        modes: () => this.availableModes(),
        switchModel: (model) => this.switchModel(model),
        switchMode: (mode) => this.switchMode(mode),
        listSessions: async () => (await this.listSessionSummaries()).map(({ id, updatedAt, turns, recoverable }) => ({
          id, updatedAt, turns, recoverable,
        })),
        history: async (limit) => (await (this.activeRun?.session ?? this.session).getItems()).slice(-limit),
        canAccessSessions: () => explicitlyRequestsSessionAccess(this.activeRun?.input ?? ''),
        canClearSession: () => explicitlyRequestsSessionClear(this.activeRun?.input ?? ''),
        schedule: (action) => {
          if (!this.activeRun) throw new Error('当前没有可绑定的运行，无法调度操作');
          this.activeRun.pendingActions.push(action);
        },
      }),
    ]);
  }

  private modelName: string;

  static async create(config: AppConfig): Promise<NanoAgent> {
    const components = await createRuntimeComponents(config);
    const agent = new NanoAgent(config, components);
    await agent.restoreSessionState(components.sessionId);
    return agent;
  }

  async stream(input: string, signal?: AbortSignal) {
    if (this.activeRun) throw new Error('当前 Session 仍有任务运行中，请等待完成或先中止');
    const run: ActiveRun = {
      runId: randomUUID(),
      ownerId: randomUUID(),
      releaseOwner: () => undefined,
      sessionId: this.sessionId,
      session: this.session,
      input,
      pendingActions: [],
    };
    run.releaseOwner = registerSessionRunOwner(run.ownerId);
    this.activeRun = run;
    let began = false;
    try {
    const runPlans = new PlanStore(path.join(this.config.dataRoot, 'plans.json'), run.sessionId);
    const runTeam = new TeamTaskStore(path.join(this.config.dataRoot, 'teams.json'), run.sessionId);
    runPlans.onChange((sessionId, steps) => this.hooks.emit({ type: 'plan_updated', sessionId, steps }));
    const mode = this.mode;
    const model = this.model;
    const modelName = this.modelName;
    const modelProfile = this.modelProfile;
    const context = this.context;
    const currentMode = AGENT_MODES.find((item) => item.id === mode)!;
    const recovery = await run.session.getCheckpoint();
    await run.session.beginRun(input, run.runId, run.ownerId);
    began = true;
    await this.hooks.emit({ type: 'run_start', sessionId: run.sessionId, input });
    await run.session.cleanupGeneratedSummaries();
    await run.session.repairToolPairs();
    const [memories, plan, goal, teamSummary, history, guidance, storedArchive] = await Promise.all([
      this.memory.search(input),
      runPlans.get(),
      runPlans.getGoal(),
      runTeam.summary(),
      run.session.getItems(),
      this.guidance.load(),
      run.session.getContextArchive(),
    ]);
    const archive = context.compactArchive(history, storedArchive, 'collapse');
    if (archive && archive !== storedArchive) await run.session.setContextArchive(archive);
    const subAgentTools = createSubAgentTools({
      mode,
      model,
      tools: this.tools,
      persistentInstructions: guidance.instructions,
      onEvent: async (agent, eventType) => this.hooks.emit({
        type: 'subagent_event',
        sessionId: run.sessionId,
        agent,
        eventType,
      }),
    });
    const teamTools = createTeamTools({
      store: runTeam,
      model,
      tools: this.tools,
      workspaceRoot: this.config.workspaceRoot,
      persistentInstructions: guidance.instructions,
      maxConcurrency: this.config.teamMaxConcurrency ?? 4,
      workerToolFactory: (task) => withExecutionLedger(
        createTeamWorkerTools({
          workspaceRoot: this.config.workspaceRoot,
          dataRoot: this.config.dataRoot,
          permissionMode: this.permissionMode,
          task,
          searchKnowledgeTool: this.tools.find((tool) => tool.name === 'search_knowledge'),
        }),
        this.ledger,
        () => ({
          sessionId: run.sessionId,
          runId: `${run.runId}:team:${task.id}:${task.claimId ?? 'unknown'}`,
        }),
      ),
      signal,
      onEvent: async (task, eventType) => this.hooks.emit({
        type: 'team_worker_event',
        sessionId: run.sessionId,
        taskId: task.id,
        role: task.role,
        description: task.description,
        result: task.result,
        eventType,
      }),
    });
    const runTools = [
      ...this.tools,
      ...this.memory.createTools(() => ({ input: run.input, sessionId: run.sessionId })),
      ...runPlans.createTools(),
    ];
    const modeTools = toolsForMode(mode, runTools, teamTools);
    const allTools = withExecutionLedger(
      [...modeTools, ...subAgentTools],
      this.ledger,
      () => this.activeRun ? { sessionId: this.activeRun.sessionId, runId: this.activeRun.runId } : undefined,
    );
    const toolSchemas = allTools.map((tool) => {
      const value = tool as unknown as Record<string, unknown>;
      return { name: value.name, description: value.description, parameters: value.parameters };
    });
    const budget = context.requestBudget(toolSchemas);
    const instructionBudget = Math.floor(budget.inputBudget * 0.35);
    const instructions = context.buildInstructions({
      baseInstructions: [
        BASE_INSTRUCTIONS,
        `当前模式：${currentMode.label}。${currentMode.instruction}`,
        `当前工作区：${this.config.workspaceRoot}。NanoAgent 运行时代码目录：${this.runtimeRoot}。本地工具权限：${this.permissionMode}。用户要求检查或修改项目/Agent 自身时，使用当前权限提供的文件工具和 Shell（若可用）实际读取、编辑并验证。`,
      ].join('\n'),
      sessionState: sessionStateSummary({
        input,
        plan,
        goal,
        hasTeam: Boolean(teamSummary),
        run: { sessionId: run.sessionId, mode, modeLabel: currentMode.label, modelName },
        outputLevel: this.outputLevel,
      }),
      persistentInstructions: guidance.instructions,
      historySummary: archive?.summary ?? '',
      skillCatalog: this.skills.catalog(),
      memories,
      documents: [],
      plan,
      goal,
      teamSummary,
      recoverySummary: recoverySummary(recovery),
    }, instructionBudget);
    const historyBudget = Math.max(0, budget.inputBudget - estimateTokens(instructions));
    const effectiveHistory = context.effectiveHistory(history, [
      { role: 'user', content: input } as AgentInputItem,
    ], archive, historyBudget);
    this.lastContextTokens = budget.toolSchemaTokens + estimateTokens(instructions) + estimateTokens(effectiveHistory);
    this.lastContextStats = context.stats(history, effectiveHistory, archive, 1);
    this.lastContextStats.effectiveTokens = this.lastContextTokens;
    const agent = new Agent({
      name: 'NanoAgent',
      model,
      modelSettings: { maxTokens: modelProfile.outputReserve },
      instructions,
      tools: allTools,
      // Plan mode keeps only the explicit read-only MCP resource wrappers above.
      mcpServers: mode === 'plan' ? [] : this.mcp.servers,
      mcpConfig: { includeServerInToolNames: true },
    });
    await run.session.updateRunProgress('模型执行中', undefined, run.runId);
    return await this.runner.run(agent, input, {
      session: run.session,
      sessionInputCallback: context.inputCallback(archive, historyBudget),
      maxTurns: this.config.maxTurns,
      stream: true,
      signal,
      toolExecution: { maxFunctionToolConcurrency: mode === 'ultra' ? 1 : 2 },
    });
    } catch (error) {
      if (this.activeRun === run) this.activeRun = undefined;
      run.releaseOwner();
      if (began) {
        const interrupted = signal?.aborted === true;
        const message = error instanceof Error ? error.message : String(error);
        await run.session.failRun(message, interrupted, run.runId).catch(() => undefined);
        await this.hooks.emit({
          type: 'run_error',
          sessionId: run.sessionId,
          error: message,
          interrupted,
        });
      }
      throw error;
    }
  }

  async switchSession(sessionId: string): Promise<void> {
    if (this.activeRun) throw new Error(`Session ${this.activeRun.sessionId} 仍有任务运行中，不能切换`);
    await this.restoreSessionState(sessionId);
  }

  private async restoreSessionState(sessionId: string): Promise<void> {
    const nextSession = this.createSession(sessionId);
    await nextSession.ensure();
    const preferences = await nextSession.getPreferences();
    const nextMode = AGENT_MODES.some((item) => item.id === preferences.mode)
      ? preferences.mode as AgentMode
      : this.defaultMode;
    const nextOutputLevel = RUNTIME_OUTPUT_LEVELS.includes(preferences.outputLevel as RuntimeOutputLevel)
      ? preferences.outputLevel as RuntimeOutputLevel
      : this.defaultOutputLevel;
    const requestedModel = preferences.model && /^[a-zA-Z0-9._:/-]+$/.test(preferences.model)
      ? preferences.model
      : this.defaultModelName;
    const nextModel = createModel(this.config, requestedModel);
    const checkpoint = await nextSession.getCheckpoint();
    const recoveredCheckpoint = await nextSession.recoverInterruptedRun(checkpoint?.runId);

    this.sessionId = sessionId;
    this.session = nextSession;
    this.mode = nextMode;
    this.outputLevel = nextOutputLevel;
    this.modelName = nextModel.name;
    this.model = nextModel.model;
    this.modelProfile = nextModel.profile;
    this.context = new ContextManager(
      this.config.historyLimit,
      nextModel.profile.contextWindow,
      0.55,
      nextModel.profile.outputReserve,
    );
    this.plans.useSession(sessionId);
    this.team.useSession(sessionId);
    if (recoveredCheckpoint?.status !== 'running') await this.team.recoverExpired(sessionId);
    this.lastContextTokens = 0;
    this.lastContextStats = undefined;
    this.lastUsage = undefined;
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
    if (this.activeRun) throw new Error(`Session ${this.activeRun.sessionId} 仍有任务运行中，不能清空`);
    await this.clearSessionState(this.sessionId, this.session);
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

  async currentTeam() {
    return this.team.list();
  }

  async setGoal(objective: string) {
    return this.plans.setGoal(objective);
  }

  async resumePrompt(): Promise<string> {
    const [goal, steps, checkpoint, team, teamTasks] = await Promise.all([
      this.plans.getGoal(),
      this.plans.get(),
      this.session.getCheckpoint(),
      this.team.summary(),
      this.team.list(),
    ]);
    return buildResumePrompt({ goal, steps, checkpoint, teamSummary: team, teamTasks });
  }

  async recoveryInfo(): Promise<RunCheckpoint | undefined> {
    const checkpoint = await this.session.getCheckpoint();
    return checkpoint && checkpoint.status !== 'completed' ? checkpoint : undefined;
  }

  async compactContext() {
    const [history, previous] = await Promise.all([this.session.getItems(), this.session.getContextArchive()]);
    const archive = this.context.compactArchive(history, previous, 'full');
    if (!archive || archive.coveredItems === previous?.coveredItems) {
      return { changed: false, archive: previous, message: '历史不足两轮，无需压缩。' };
    }
    await this.session.setContextArchive(archive);
    this.lastContextTokens = 0;
    this.lastContextStats = undefined;
    return { changed: true, archive, message: `已归档 ${archive.coveredItems} 个历史条目。` };
  }

  async runtimeInfo() {
    const [sessionSummary, guidance, team] = await Promise.all([this.session.summary(), this.guidance.load(), this.team.list()]);
    return {
      provider: this.config.provider,
      model: this.modelName,
      mode: this.currentMode,
      sessionId: this.sessionId,
      sessionTitle: sessionSummary.title,
      workspaceRoot: this.config.workspaceRoot,
      runtimeRoot: this.runtimeRoot,
      outputLevel: this.outputLevel,
      maxTurns: this.config.maxTurns,
      permissionMode: this.permissionMode,
      skillCount: this.skills.list().length,
      memoryCount: (await this.memory.listConfirmed()).length,
      mcpServers: this.mcpServerNames,
      mcpStatuses: this.mcp.statuses(),
      guidanceFiles: guidance.files.map((file) => ({ scope: file.scope, path: file.path, truncated: file.truncated })),
      team: {
        total: team.length,
        pending: team.filter((item) => item.status === 'pending').length,
        running: team.filter((item) => item.status === 'running').length,
        completed: team.filter((item) => item.status === 'completed').length,
        failed: team.filter((item) => item.status === 'failed').length,
      },
    };
  }

  async guidanceInfo() {
    return this.guidance.load();
  }

  availableModels(): string[] {
    const configured = this.config.provider === 'deepseek'
      ? process.env.DEEPSEEK_MODELS
      : process.env.OPENAI_MODELS;
    const defaults = this.config.provider === 'deepseek'
      ? ['deepseek-v4-pro', 'deepseek-v4-flash']
      : ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5-mini'];
    return [...new Set([
      this.modelName,
      ...(configured?.split(',').map((item) => item.trim()).filter(Boolean) ?? []),
      ...defaults,
    ])];
  }

  async switchModel(modelName: string): Promise<void> {
    if (!/^[a-zA-Z0-9._:/-]+$/.test(modelName)) throw new Error('模型名称格式无效');
    const runtime = createModel(this.config, modelName);
    this.modelName = runtime.name;
    this.model = runtime.model;
    this.modelProfile = runtime.profile;
    this.context = new ContextManager(
      this.config.historyLimit,
      runtime.profile.contextWindow,
      0.55,
      runtime.profile.outputReserve,
    );
    this.lastContextTokens = 0;
    this.lastContextStats = undefined;
    this.lastUsage = undefined;
    await this.session.setPreferences({ model: this.modelName });
  }

  availableModes() {
    return AGENT_MODES.map(({ id, label, description }) => ({ id, label, description }));
  }

  async switchMode(mode: string): Promise<void> {
    if (!AGENT_MODES.some((item) => item.id === mode)) throw new Error(`未知模式：${mode}`);
    this.mode = mode as AgentMode;
    await this.session.setPreferences({ mode: this.mode });
  }

  async setOutputLevel(level: RuntimeOutputLevel): Promise<void> {
    if (!RUNTIME_OUTPUT_LEVELS.includes(level)) throw new Error(`未知输出等级：${level}`);
    this.outputLevel = level;
    await this.session.setPreferences({ outputLevel: this.outputLevel });
  }

  async contextInfo() {
    const [history, memories, plan, goal, team, archive, checkpoint] = await Promise.all([
      this.session.getItems(),
      this.memory.listConfirmed(),
      this.plans.get(),
      this.plans.getGoal(),
      this.team.list(),
      this.session.getContextArchive(),
      this.session.getCheckpoint(),
    ]);
    const effective = this.context.effectiveHistory(history, [], archive);
    const stats = this.lastContextStats ?? this.context.stats(history, effective, archive);
    return {
      historyItems: history.length,
      historyLimit: this.config.historyLimit,
      estimatedTokens: this.lastContextTokens || stats.effectiveTokens + stats.archiveTokens,
      estimateScope: this.lastContextTokens ? 'last_request' as const : 'history_only' as const,
      rawTokens: stats.rawTokens,
      effectiveTokens: stats.effectiveTokens,
      archiveTokens: stats.archiveTokens,
      archivedItems: stats.coveredItems,
      contextStrategies: stats.strategies,
      compactedAt: archive?.updatedAt,
      contextWindow: this.modelProfile.contextWindow,
      outputReserve: this.modelProfile.outputReserve,
      inputBudget: this.modelProfile.contextWindow - this.modelProfile.outputReserve,
      lastRequestInputTokens: this.lastUsage?.lastRequestInputTokens,
      lastRequestOutputTokens: this.lastUsage?.lastRequestOutputTokens,
      runInputTokens: this.lastUsage?.runInputTokens,
      runOutputTokens: this.lastUsage?.runOutputTokens,
      runTotalTokens: this.lastUsage?.runTotalTokens,
      memories: memories.length,
      planSteps: plan.length,
      goal: goal?.status,
      teamTasks: team.length,
      runStatus: checkpoint?.status,
    };
  }

  get toolNames(): string[] {
    const scoped = [...this.tools, ...this.memory.createTools(), ...this.plans.createTools()];
    return toolNamesForMode(this.mode, scoped);
  }

  private get currentMode() {
    return AGENT_MODES.find((item) => item.id === this.mode)!;
  }

  async indexKnowledge(target?: string, signal?: AbortSignal) {
    return this.rag.index(target, signal);
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
    const run = this.activeRun;
    const sessionId = run?.sessionId ?? this.sessionId;
    const session = run?.session ?? this.session;
    if (type === 'status' && data && typeof data === 'object') {
      const value = data as Record<string, unknown>;
      await this.traces.record(sessionId, type, {
        kind: value.kind,
        tone: value.tone,
        title: value.title,
        detail: typeof value.detail === 'string' ? value.detail.slice(0, 1_000) : value.detail,
        next: value.next,
      });
      await session.updateRunProgress(
        typeof value.next === 'string' ? value.next : '执行中',
        [value.title, value.detail].filter((item) => typeof item === 'string' && item).join(' · '),
        run?.runId,
      );
      return;
    }
    await this.traces.record(sessionId, type, data);
  }

  onRuntimeEvent(hook: RuntimeHook): () => void {
    return this.hooks.on(hook);
  }

  async completeRun(answer: string, usage?: ContextUsageSnapshot): Promise<RuntimeEffect[]> {
    const run = this.activeRun;
    if (!run) throw new Error('没有正在运行的任务可完成');
    this.activeRun = undefined;
    let completed;
    try {
      completed = await run.session.completeRun(answer, run.runId);
    } catch (error) {
      if (!this.activeRun) this.activeRun = run;
      throw error;
    }
    if (completed?.runId !== run.runId || completed.status !== 'completed') {
      throw new Error(`Run ${run.runId} 已失效，拒绝用旧结果完成当前 Session`);
    }
    this.lastUsage = this.validUsage(usage);
    await this.hooks.emit({ type: 'run_end', sessionId: run.sessionId, answer });
    await this.ledger.clearRun(run.sessionId, run.runId).catch(() => undefined);
    run.releaseOwner();
    return this.applyPendingActions(run.pendingActions, run.sessionId);
  }

  async failRun(error: unknown, interrupted = false, usage?: ContextUsageSnapshot): Promise<void> {
    const run = this.activeRun;
    if (!run) return;
    this.activeRun = undefined;
    run.releaseOwner();
    this.lastUsage = this.validUsage(usage);
    await run.session.failRun(error instanceof Error ? error.message : String(error), interrupted, run.runId);
    await this.hooks.emit({
      type: 'run_error',
      sessionId: run.sessionId,
      error: error instanceof Error ? error.message : String(error),
      interrupted,
    });
  }

  async close(): Promise<void> {
    await this.mcp.close();
  }

  private createSession(id: string): FileSession {
    return new FileSession(path.join(this.config.dataRoot, 'sessions'), id);
  }

  private async applyPendingActions(actions: RuntimeAction[], originSessionId: string): Promise<RuntimeEffect[]> {
    const effects: RuntimeEffect[] = [];
    for (const action of actions) {
      if (action.type === 'set_output_level') {
        if (this.sessionId === originSessionId) await this.setOutputLevel(action.level);
        else await this.createSession(originSessionId).setPreferences({ outputLevel: action.level });
        effects.push({ type: 'output_level_changed', level: action.level });
      } else if (action.type === 'clear_session') {
        const origin = this.sessionId === originSessionId ? this.session : this.createSession(originSessionId);
        await this.clearSessionState(originSessionId, origin);
        effects.push({ type: 'session_cleared', sessionId: originSessionId });
      } else if (action.type === 'exit') {
        effects.push({ type: 'exit_requested' });
      } else if (action.type === 'reload_mcp') {
        await this.reloadMcp();
        effects.push({ type: 'mcp_reloaded' });
      } else {
        await this.switchSession(action.sessionId);
        effects.push({ type: 'session_changed', sessionId: action.sessionId });
      }
    }
    return effects;
  }

  private validUsage(usage?: ContextUsageSnapshot): ContextUsageSnapshot | undefined {
    if (!usage) return undefined;
    return Object.values(usage).some((value) => typeof value === 'number' && value > 0) ? usage : undefined;
  }

  private async clearSessionState(sessionId: string, session: FileSession): Promise<void> {
    await session.clearSession(async () => Promise.all([
      this.plans.clear(sessionId),
      this.team.clear(sessionId),
      this.ledger.clearSession(sessionId),
    ]).then(() => undefined));
  }

}
