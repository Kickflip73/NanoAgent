import { randomUUID } from 'node:crypto';
import type { MimiAgent } from './agent.js';
import type { SessionSummary } from './core/session.js';
import { OUTPUT_LEVELS, type OutputLevel } from './terminal.js';

export type CommandResult = 'handled' | 'exit' | 'pass';
type MaybePromise<T> = T | Promise<T>;

export interface BackgroundTaskSummary {
  taskId: string;
  status: string;
  objective?: string;
  strategy?: string;
  workspaceAccess?: 'read' | 'write';
  sessionId?: string;
  originSessionId?: string;
  parentEventId?: string;
  depth?: number;
  attempts?: number;
  createdAt?: string;
  updatedAt?: string;
  result?: unknown;
  error?: string;
  worker?: {
    pid?: number;
    workerId?: string;
    spawnedAt?: string;
    heartbeatAt?: string;
  };
  recentEvents?: Array<{
    sequence?: number;
    kind: string;
    tone?: string;
    title?: string;
    next?: string;
    steps?: Array<{
      description: string;
      status: string;
    }>;
  }>;
  plan?: Array<{
    description: string;
    status: string;
  }>;
  checkpoint?: {
    phase: string;
    lastEvent?: string;
    nextAction?: string;
    updatedAt: string;
  };
}

export type BackgroundTaskCancelResult =
  | { state: 'cancelled' }
  | { state: 'already_terminal' }
  | { state: 'not_found' };

export type BackgroundTaskPauseResult =
  | { state: 'paused' }
  | { state: 'pause_requested' }
  | { state: 'already_paused' }
  | { state: 'not_pauseable' }
  | { state: 'already_terminal' }
  | { state: 'not_found' };

export type BackgroundTaskResumeResult =
  | { state: 'resumed' }
  | { state: 'not_resumable' }
  | { state: 'not_found' };

export interface CommandTarget {
  readonly currentSessionId: string;
  readonly toolNames: MaybePromise<string[]>;
  runtimeInfo(): ReturnType<MimiAgent['runtimeInfo']>;
  availableModels(): MaybePromise<ReturnType<MimiAgent['availableModels']>>;
  switchModel(model: string): ReturnType<MimiAgent['switchModel']>;
  availableModes(): MaybePromise<ReturnType<MimiAgent['availableModes']>>;
  switchMode(mode: string): ReturnType<MimiAgent['switchMode']>;
  switchSession(sessionId: string): ReturnType<MimiAgent['switchSession']>;
  listSessionSummaries(): ReturnType<MimiAgent['listSessionSummaries']>;
  history(): ReturnType<MimiAgent['history']>;
  clearSession(): ReturnType<MimiAgent['clearSession']>;
  listSkills(): MaybePromise<ReturnType<MimiAgent['listSkills']>>;
  reloadSkills(): ReturnType<MimiAgent['reloadSkills']>;
  mcpStatuses(): MaybePromise<ReturnType<MimiAgent['mcpStatuses']>>;
  reloadMcp(): ReturnType<MimiAgent['reloadMcp']>;
  contextInfo(): ReturnType<MimiAgent['contextInfo']>;
  compactContext(): ReturnType<MimiAgent['compactContext']>;
  guidanceInfo(): ReturnType<MimiAgent['guidanceInfo']>;
  listMemories(): ReturnType<MimiAgent['listMemories']>;
  currentPlan(): ReturnType<MimiAgent['currentPlan']>;
  currentTeam(): ReturnType<MimiAgent['currentTeam']>;
  currentGoal(): ReturnType<MimiAgent['currentGoal']>;
  setGoal(objective: string): ReturnType<MimiAgent['setGoal']>;
  resumePrompt(): ReturnType<MimiAgent['resumePrompt']>;
  indexKnowledge(target?: string, signal?: AbortSignal): ReturnType<MimiAgent['indexKnowledge']>;
  listBackgroundTasks?(limit?: number): MaybePromise<BackgroundTaskSummary[]>;
  inspectBackgroundTask?(taskId: string): MaybePromise<BackgroundTaskSummary>;
  cancelBackgroundTask?(taskId: string, reason?: string): MaybePromise<BackgroundTaskCancelResult>;
  pauseBackgroundTask?(taskId: string, reason?: string): MaybePromise<BackgroundTaskPauseResult>;
  resumeBackgroundTask?(taskId: string, context?: string): MaybePromise<BackgroundTaskResumeResult>;
}

export const COMMANDS = [
  { value: '/status', description: '查看运行状态' },
  { value: '/model', description: '查看或切换模型' },
  { value: '/mode', description: '查看或切换运行模式' },
  { value: '/output', description: '调整执行过程展示等级' },
  { value: '/new', description: '新建对话' },
  { value: '/sessions', description: '选择最近对话' },
  { value: '/switch', description: '按 ID 切换对话' },
  { value: '/history', description: '查看当前历史' },
  { value: '/clear', description: '清空当前对话' },
  { value: '/skills', description: '列出 Skills' },
  { value: '/tools', description: '列出可用工具' },
  { value: '/mcp', description: '查看 MCP 连接' },
  { value: '/context', description: '查看上下文用量' },
  { value: '/compact', description: '压缩并归档较早上下文' },
  { value: '/instructions', description: '查看持久指令文件' },
  { value: '/memories', description: '列出长期记忆' },
  { value: '/plan', description: '查看任务计划' },
  { value: '/team', description: '查看 Ultra Team 任务板' },
  { value: '/tasks', description: '查看后台任务' },
  { value: '/task', description: '查看、暂停、继续或取消后台任务' },
  { value: '/goal', description: '查看或设置长期目标' },
  { value: '/resume', description: '依据持久任务状态继续' },
  { value: '/index', description: '索引本地知识库' },
  { value: '/retry', description: '重试上一条输入' },
  { value: '/help', description: '显示命令帮助' },
  { value: '/exit', description: '退出 MimiAgent CLI' },
] as const;

const HELP = `内置命令：
  /status             查看模型、会话和扩展状态
  /model [name]       查看或切换当前模型
  /mode [name]        查看或切换运行模式
  /output [level]     调整答案、思考、工具或详细事件展示
  /new [id]           新建并切换对话
  /sessions           选择并切换最近对话
  /switch <id>        按 ID 切换对话
  /history            查看当前对话历史
  /clear              清空当前对话
  /skills [reload]    列出或重新加载 Skills
  /tools              列出当前可用工具
  /mcp [reload]       查看或重新连接 MCP Server
  /context            查看上下文、记忆和计划用量
  /compact            归档较早历史，保留最近两轮
  /instructions       查看用户级与项目级 MIMI.md
  /memories           列出长期记忆
  /plan               查看当前任务计划
  /team               查看 Ultra Team 子任务、依赖和结果
  /tasks [limit]      查看最近的后台任务
  /task <id>          查看后台任务详情
  /task cancel <id>   取消后台任务，可在 ID 后填写原因
  /task pause <id>    暂停后台任务
  /task resume <id>   继续后台任务，可在 ID 后补充上下文
  /goal [objective]   查看或设置当前长期目标
  /resume             依据 Checkpoint / Goal / Plan / Team 尽力续跑
  /index [path]       索引知识库，默认 knowledge
  /retry              重新执行上一条用户输入
  /help               显示帮助
  /exit               退出

交互快捷键：Esc 停止当前任务 · Shift+Tab 切换模式 · Shift+Enter 换行 · Command+←/→ 跳到行首/行尾 · 输入 / 查看命令 · ↑↓ 选择 · Enter 执行 · Tab 补全`;

export interface CommandUI {
  write?: (text: string) => void;
  resetScreen?: () => void | Promise<void>;
  restoreSession?: () => void | Promise<void>;
  selectSession?: (sessions: SessionSummary[]) => Promise<string | undefined>;
  selectModel?: (models: string[], current: string) => Promise<string | undefined>;
  selectMode?: (modes: ReturnType<MimiAgent['availableModes']>, current: string) => Promise<string | undefined>;
  getOutputLevel?: () => OutputLevel;
  setOutputLevel?: (level: OutputLevel) => void | Promise<void>;
  selectOutputLevel?: (current: OutputLevel) => Promise<string | undefined>;
}

const TASK_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  paused: '已暂停',
  blocked: '等待输入',
  completed: '已完成',
  ignored: '已忽略',
  digested: '已归档摘要',
  dead_letter: '失败',
  archived: '已归档',
};

function taskStatus(status: string): string {
  return TASK_STATUS_LABELS[status] ?? status;
}

function taskValue(value: unknown, maxLength = 1_200): string {
  let rendered: string;
  if (typeof value === 'string') rendered = value;
  else {
    try {
      rendered = JSON.stringify(value, null, 2);
    } catch {
      rendered = String(value);
    }
  }
  const normalized = rendered.trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function taskListLine(task: BackgroundTaskSummary): string {
  const objective = task.objective?.replace(/\s+/g, ' ').trim() || '未记录目标';
  return `- [${taskStatus(task.status)}] ${task.taskId} · ${objective}`;
}

function taskProgress(task: BackgroundTaskSummary): string[] {
  const events = task.recentEvents ?? [];
  const latestPlan = [...events].reverse().find((event) => event.kind === 'plan' && event.steps?.length);
  const latestStatus = [...events].reverse().find((event) => event.kind === 'status');
  const plan = latestPlan?.steps?.length ? latestPlan.steps : task.plan;
  const lines: string[] = [];
  if (plan?.length) {
    const completed = plan.filter((step) => step.status === 'completed').length;
    const active = plan.find((step) => step.status === 'running');
    lines.push(`计划进度  ${completed}/${plan.length}${active ? ` · ${active.description}` : ''}`);
  }
  if (latestStatus) {
    const action = latestStatus.next || latestStatus.title;
    if (action) lines.push(`当前动作  ${action}`);
  } else if (task.checkpoint) {
    const action = task.checkpoint.lastEvent || task.checkpoint.nextAction || task.checkpoint.phase;
    if (action) lines.push(`当前动作  ${action}`);
  }
  return lines;
}

function taskDetails(task: BackgroundTaskSummary): string {
  return [
    `任务      ${task.taskId}`,
    `状态      ${taskStatus(task.status)}`,
    `目标      ${task.objective ?? '未记录'}`,
    task.strategy ? `策略      ${task.strategy}` : '',
    task.workspaceAccess ? `工作区    ${task.workspaceAccess === 'read' ? '只读' : '可写（独占）'}` : '',
    task.sessionId ? `任务会话  ${task.sessionId}` : '',
    task.originSessionId ? `来源会话  ${task.originSessionId}` : '',
    task.parentEventId ? `父任务    ${task.parentEventId}` : '',
    task.depth !== undefined ? `委派深度  ${task.depth}` : '',
    task.attempts !== undefined ? `尝试次数  ${task.attempts}` : '',
    task.worker ? `工作进程  ${task.worker.pid ?? task.worker.workerId ?? '启动中'}` : '',
    task.worker?.heartbeatAt ? `最近心跳  ${task.worker.heartbeatAt}` : '',
    ...taskProgress(task),
    task.createdAt ? `创建时间  ${task.createdAt}` : '',
    task.updatedAt ? `更新时间  ${task.updatedAt}` : '',
    task.result !== undefined ? `结果\n${taskValue(task.result)}` : '',
    task.error ? `错误\n${task.error}` : '',
  ].filter(Boolean).join('\n');
}

export class CommandHandler {
  private lastInputs = new Map<string, string>();

  constructor(
    private readonly agent: CommandTarget,
    private readonly runTask: (input: string, signal?: AbortSignal) => Promise<void>,
    private readonly ui: CommandUI = {},
  ) {}

  remember(input: string): void {
    this.lastInputs.set(this.agent.currentSessionId, input);
  }

  async execute(input: string, signal?: AbortSignal): Promise<CommandResult> {
    if (!input.startsWith('/')) return 'pass';
    const [command, ...rest] = input.split(/\s+/);
    const argument = rest.join(' ').trim();

    if (command === '/exit') return 'exit';
    if (command === '/help') return this.handled(HELP);
    if (command === '/status') {
      const info = await this.agent.runtimeInfo();
      const executionAccess = info.mode.id === 'plan'
        ? '当前模式只读（Shell 关闭）'
        : info.permissionMode === 'trusted'
          ? '本机完整（Shell 可用）'
          : info.permissionMode === 'workspace'
            ? '工作区受限（Shell 关闭）'
            : '只读（Shell 关闭）';
      return this.handled([
        `模型      ${info.provider} / ${info.model}`,
        `模式      ${info.mode.label}`,
        `执行      ${executionAccess}`,
        `输出      ${this.ui.getOutputLevel?.() ?? 'tools'}`,
        `会话      ${info.sessionId}`,
        `工作区    ${info.workspaceRoot}`,
        `最大轮数  ${info.maxTurns ?? '不限（由状态、取消与超时控制）'}`,
        `Skills    ${info.skillCount}`,
        `Memories  ${info.memoryCount}`,
        `MCP       ${info.mcpServers.join(', ') || '未连接'}`,
        `Team      ${info.team.total ? `${info.team.completed}/${info.team.total} 完成 · ${info.team.running} 运行` : '未启用'}`,
        `MIMI.md   ${info.guidanceFiles.length ? `${info.guidanceFiles.length} 个已加载` : '未配置'}`,
      ].join('\n'));
    }
    if (command === '/model') {
      const current = (await this.agent.runtimeInfo()).model;
      const models = await this.agent.availableModels();
      const selected = argument || await this.ui.selectModel?.(models, current);
      if (!selected) return this.ui.selectModel ? 'handled' : this.handled(`当前模型：${current}`);
      await this.agent.switchModel(selected);
      return this.handled(`已切换模型：${selected}`);
    }
    if (command === '/mode') {
      const current = (await this.agent.runtimeInfo()).mode;
      const modes = await this.agent.availableModes();
      const selected = argument || await this.ui.selectMode?.(modes, current.id);
      if (!selected) return this.ui.selectMode ? 'handled' : this.handled(`当前模式：${current.label}`);
      await this.agent.switchMode(selected);
      const mode = modes.find((item) => item.id === selected);
      return this.handled(`已切换模式：${mode?.label ?? selected}`);
    }
    if (command === '/output') {
      const current = this.ui.getOutputLevel?.() ?? 'tools';
      const selected = argument || await this.ui.selectOutputLevel?.(current);
      if (!selected) return this.ui.selectOutputLevel ? 'handled' : this.handled(`当前输出等级：${current}`);
      const level = OUTPUT_LEVELS.find((item) => item.id === selected);
      if (!level) throw new Error(`未知输出等级：${selected}`);
      await this.ui.setOutputLevel?.(level.id);
      return this.handled(`已切换输出等级：${level.label}（${level.id}）`);
    }
    if (command === '/new') {
      await this.agent.switchSession(argument || randomUUID().slice(0, 8));
      await this.ui.resetScreen?.();
      return this.handled('新对话已就绪。');
    }
    if (command === '/sessions' || command === '/session') {
      const sessions = await this.agent.listSessionSummaries();
      if (!sessions.length) return this.handled('暂无对话。');
      const selected = this.ui.selectSession
        ? await this.ui.selectSession(sessions)
        : undefined;
      if (selected) {
        await this.agent.switchSession(selected);
        await (this.ui.restoreSession?.() ?? this.ui.resetScreen?.());
        return 'handled';
      }
      if (this.ui.selectSession) return 'handled';
      return this.handled(sessions.map((item) => `${item.id === this.agent.currentSessionId ? '*' : ' '} ${item.title}  ${item.preview}`).join('\n'));
    }
    if (command === '/switch') {
      if (!argument) throw new Error('用法：/switch <session-id>');
      await this.agent.switchSession(argument);
      await (this.ui.restoreSession?.() ?? this.ui.resetScreen?.());
      return 'handled';
    }
    if (command === '/history') {
      const items = await this.agent.history();
      return this.handled(items.map((item, index) => `${index + 1}. ${JSON.stringify(item)}`).join('\n') || '当前对话为空');
    }
    if (command === '/clear') {
      await this.agent.clearSession();
      this.lastInputs.delete(this.agent.currentSessionId);
      await this.ui.resetScreen?.();
      return this.handled('当前对话、Goal、Plan 与 Team 状态已清空。');
    }
    if (command === '/skills') {
      if (argument === 'reload') {
        const result = await this.agent.reloadSkills();
        return this.handled(`已重新加载 ${result.skills.length} 个 Skills${result.warnings.length ? `，${result.warnings.length} 个无效` : ''}`);
      }
      const skills = await this.agent.listSkills();
      return this.handled(skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n') || '暂无 Skills');
    }
    if (command === '/tools') {
      const tools = await this.agent.toolNames;
      return this.handled(tools.map((name) => `- ${name}`).join('\n') || '暂无工具');
    }
    if (command === '/mcp') {
      const statuses = argument === 'reload' ? await this.agent.reloadMcp() : await this.agent.mcpStatuses();
      if (!statuses.length) return this.handled('MCP 未配置');
      return this.handled(statuses.map((status) => status.state === 'connected'
        ? `● ${status.name} · ${status.transport} · ${status.tools} tools`
        : `○ ${status.name} · 连接失败 · ${status.error ?? '未知错误'}`).join('\n'));
    }
    if (command === '/context') {
      const info = await this.agent.contextInfo();
      return this.handled([
        `历史条目  ${info.historyItems} / ${info.historyLimit}`,
        `原始历史  ~${info.rawTokens ?? info.estimatedTokens} tokens`,
        `${info.estimateScope === 'last_request' ? '最近请求估算' : '当前历史估算'} ~${info.effectiveTokens ?? info.estimatedTokens} tokens`,
        `上次请求实际 ${info.lastRequestInputTokens ? `${info.lastRequestInputTokens} input + ${info.lastRequestOutputTokens ?? 0} output` : 'Provider 未返回'}`,
        `上轮累计用量 ${info.runTotalTokens ? `${info.runTotalTokens} tokens（input ${info.runInputTokens ?? 0} / output ${info.runOutputTokens ?? 0}）` : 'Provider 未返回'}`,
        `模型窗口  ${info.contextWindow} · 输入上限 ${info.inputBudget} · 输出预留 ${info.outputReserve}`,
        `压缩归档  ${info.archivedItems ?? 0} 条 · ~${info.archiveTokens ?? 0} tokens`,
        `压缩策略  ${info.contextStrategies?.join(', ') || '未触发'}`,
        `最近压缩  ${info.compactedAt ?? '无'}`,
        `运行状态  ${info.runStatus ?? 'idle'}`,
        `长期记忆  ${info.memories}`,
        `计划步骤  ${info.planSteps}`,
        `长期目标  ${info.goal ?? '未设置'}`,
        '原始 Session 始终保留；压缩只改变发送给模型的有效视图。',
      ].join('\n'));
    }
    if (command === '/compact') {
      const result = await this.agent.compactContext();
      const archive = result.archive;
      return this.handled([
        result.message,
        archive ? `归档范围：${archive.coveredItems} 条 · ${archive.originalTokens} → ${archive.compactedTokens} tokens` : '',
      ].filter(Boolean).join('\n'));
    }
    if (command === '/instructions') {
      const guidance = await this.agent.guidanceInfo();
      if (!guidance.files.length) return this.handled('未找到 MIMI.md。用户级：~/.mimi-agent/MIMI.md · 项目级：<workspace>/MIMI.md');
      return this.handled(guidance.files.map((file) =>
        `${file.scope === 'project' ? '项目' : '用户'}  ${file.path}${file.truncated ? '（已截断）' : ''}`,
      ).join('\n'));
    }
    if (command === '/memories') {
      const memories = await this.agent.listMemories();
      return this.handled(memories.map((memory) =>
        `- ${memory.id} [${memory.type} · ${memory.source ?? 'legacy'}${memory.sourceTrust ? `/${memory.sourceTrust}` : ''}${memory.personId ? ` · ${memory.personName ?? memory.personId}` : ''}] ${memory.content}`,
      ).join('\n') || '暂无长期记忆');
    }
    if (command === '/plan') {
      const plan = await this.agent.currentPlan();
      return this.handled(plan.map((step) => `- [${step.status}] ${step.id}. ${step.description}`).join('\n') || '当前没有计划');
    }
    if (command === '/team') {
      const tasks = await this.agent.currentTeam();
      return this.handled(tasks.map((task) => [
        `- [${task.status}] ${task.id} · ${task.role} · ${task.description}`,
        task.dependencies.length ? `依赖 ${task.dependencies.join(', ')}` : '',
        task.owner ? `负责人 ${task.owner}` : '',
        task.result ? `结果 ${task.result.slice(0, 240)}` : '',
      ].filter(Boolean).join(' · ')).join('\n') || '当前没有 Ultra Team 任务');
    }
    if (command === '/tasks') {
      const limit = argument ? Number(argument) : 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new Error('用法：/tasks [1-50]');
      }
      if (!this.agent.listBackgroundTasks) {
        return this.handled('当前运行方式不支持后台任务管理，请通过统一 mimi CLI 连接后台。');
      }
      const tasks = await this.agent.listBackgroundTasks(limit);
      return this.handled(tasks.map(taskListLine).join('\n') || '暂无后台任务。');
    }
    if (command === '/task') {
      const [actionOrId, taskId, ...reasonParts] = rest;
      if (actionOrId === 'cancel') {
        if (!taskId) throw new Error('用法：/task cancel <task-id> [reason]');
        if (!this.agent.cancelBackgroundTask) {
          return this.handled('当前运行方式不支持后台任务管理，请通过统一 mimi CLI 连接后台。');
        }
        const result = await this.agent.cancelBackgroundTask(taskId, reasonParts.join(' ').trim() || undefined);
        if (result.state === 'cancelled') return this.handled(`已请求取消后台任务：${taskId}`);
        if (result.state === 'already_terminal') return this.handled(`后台任务已经结束，无需取消：${taskId}`);
        return this.handled(`未找到后台任务：${taskId}`);
      }
      if (actionOrId === 'pause') {
        if (!taskId) throw new Error('用法：/task pause <task-id>');
        if (!this.agent.pauseBackgroundTask) {
          return this.handled('当前运行方式不支持暂停后台任务，请通过统一 mimi CLI 连接后台。');
        }
        const result = await this.agent.pauseBackgroundTask(taskId, reasonParts.join(' ').trim() || undefined);
        if (result.state === 'paused') return this.handled(`已暂停后台任务：${taskId}`);
        if (result.state === 'pause_requested') {
          return this.handled(`已请求暂停后台任务，将在当前工具调用完成后的安全点暂停：${taskId}`);
        }
        if (result.state === 'already_paused') return this.handled(`后台任务已经暂停：${taskId}`);
        if (result.state === 'already_terminal') return this.handled(`后台任务已经结束，无法暂停：${taskId}`);
        if (result.state === 'not_pauseable') return this.handled(`后台任务当前无法暂停：${taskId}`);
        return this.handled(`未找到后台任务：${taskId}`);
      }
      if (actionOrId === 'resume') {
        if (!taskId) throw new Error('用法：/task resume <task-id> [context]');
        if (!this.agent.resumeBackgroundTask) {
          return this.handled('当前运行方式不支持继续后台任务，请通过统一 mimi CLI 连接后台。');
        }
        const result = await this.agent.resumeBackgroundTask(taskId, reasonParts.join(' ').trim() || undefined);
        if (result.state === 'resumed') return this.handled(`后台任务已重新排队继续：${taskId}`);
        if (result.state === 'not_resumable') return this.handled(`后台任务当前不是 paused/blocked 状态：${taskId}`);
        return this.handled(`未找到后台任务：${taskId}`);
      }
      if (!actionOrId) {
        throw new Error('用法：/task <task-id>、/task pause <task-id>、/task resume <task-id> [context] 或 /task cancel <task-id> [reason]');
      }
      if (!this.agent.inspectBackgroundTask) {
        return this.handled('当前运行方式不支持后台任务管理，请通过统一 mimi CLI 连接后台。');
      }
      return this.handled(taskDetails(await this.agent.inspectBackgroundTask(actionOrId)));
    }
    if (command === '/goal') {
      const goal = argument ? await this.agent.setGoal(argument) : await this.agent.currentGoal();
      if (!goal) return this.handled('当前没有长期 Goal。使用 /goal <目标> 设置。');
      return this.handled([
        `[${goal.status}] ${goal.objective}`,
        goal.checkpoint ? `检查点：${goal.checkpoint}` : '',
        goal.nextAction ? `下一步：${goal.nextAction}` : '',
      ].filter(Boolean).join('\n'));
    }
    if (command === '/resume') {
      const prompt = await this.agent.resumePrompt();
      this.print('正在依据持久任务状态继续...');
      await this.runTask(prompt, signal);
      return 'handled';
    }
    if (command === '/index') {
      this.print('正在构建知识库索引...');
      const result = await this.agent.indexKnowledge(argument || 'knowledge', signal);
      return this.handled(JSON.stringify(result));
    }
    if (command === '/retry') {
      const lastInput = this.lastInputs.get(this.agent.currentSessionId);
      if (!lastInput) return this.handled('当前对话没有可重试的用户输入。');
      this.print(`重新执行：${lastInput}`);
      await this.runTask(lastInput, signal);
      return 'handled';
    }

    return this.handled(`未知命令：${command}。输入 /help 查看可用命令。`);
  }

  private handled(text: string): CommandResult {
    this.print(text);
    return 'handled';
  }

  private print(text: string): void {
    if (this.ui.write) this.ui.write(text);
    else console.log(text);
  }
}

export function commandHelp(): string {
  return HELP;
}
