import { randomUUID } from 'node:crypto';
import type { NanoAgent } from './agent.js';
import type { SessionSummary } from './core/session.js';
import { OUTPUT_LEVELS, type OutputLevel } from './terminal.js';

export type CommandResult = 'handled' | 'exit' | 'pass';

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
  { value: '/goal', description: '查看或设置长期目标' },
  { value: '/resume', description: '依据持久任务状态继续' },
  { value: '/index', description: '索引本地知识库' },
  { value: '/retry', description: '重试上一条输入' },
  { value: '/help', description: '显示命令帮助' },
  { value: '/exit', description: '退出 NanoAgent' },
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
  /instructions       查看用户级与项目级 NANO.md
  /memories           列出长期记忆
  /plan               查看当前任务计划
  /team               查看 Ultra Team 子任务、依赖和结果
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
  selectMode?: (modes: ReturnType<NanoAgent['availableModes']>, current: string) => Promise<string | undefined>;
  getOutputLevel?: () => OutputLevel;
  setOutputLevel?: (level: OutputLevel) => void | Promise<void>;
  selectOutputLevel?: (current: OutputLevel) => Promise<string | undefined>;
}

export class CommandHandler {
  private lastInputs = new Map<string, string>();

  constructor(
    private readonly agent: NanoAgent,
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
      return this.handled([
        `模型      ${info.provider} / ${info.model}`,
        `模式      ${info.mode.label}`,
        `输出      ${this.ui.getOutputLevel?.() ?? 'tools'}`,
        `会话      ${info.sessionId}`,
        `工作区    ${info.workspaceRoot}`,
        `最大轮数  ${info.maxTurns}`,
        `Skills    ${info.skillCount}`,
        `Memories  ${info.memoryCount}`,
        `MCP       ${info.mcpServers.join(', ') || '未连接'}`,
        `Team      ${info.team.total ? `${info.team.completed}/${info.team.total} 完成 · ${info.team.running} 运行` : '未启用'}`,
        `NANO.md   ${info.guidanceFiles.length ? `${info.guidanceFiles.length} 个已加载` : '未配置'}`,
      ].join('\n'));
    }
    if (command === '/model') {
      const current = (await this.agent.runtimeInfo()).model;
      const selected = argument || await this.ui.selectModel?.(this.agent.availableModels(), current);
      if (!selected) return this.ui.selectModel ? 'handled' : this.handled(`当前模型：${current}`);
      await this.agent.switchModel(selected);
      return this.handled(`已切换模型：${selected}`);
    }
    if (command === '/mode') {
      const current = (await this.agent.runtimeInfo()).mode;
      const selected = argument || await this.ui.selectMode?.(this.agent.availableModes(), current.id);
      if (!selected) return this.ui.selectMode ? 'handled' : this.handled(`当前模式：${current.label}`);
      await this.agent.switchMode(selected);
      const mode = this.agent.availableModes().find((item) => item.id === selected);
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
      const skills = this.agent.listSkills();
      return this.handled(skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n') || '暂无 Skills');
    }
    if (command === '/tools') {
      return this.handled(this.agent.toolNames.map((name) => `- ${name}`).join('\n') || '暂无工具');
    }
    if (command === '/mcp') {
      const statuses = argument === 'reload' ? await this.agent.reloadMcp() : this.agent.mcpStatuses();
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
      if (!guidance.files.length) return this.handled('未找到 NANO.md。用户级：~/.nano-agent/NANO.md · 项目级：<workspace>/NANO.md');
      return this.handled(guidance.files.map((file) =>
        `${file.scope === 'project' ? '项目' : '用户'}  ${file.path}${file.truncated ? '（已截断）' : ''}`,
      ).join('\n'));
    }
    if (command === '/memories') {
      const memories = await this.agent.listMemories();
      return this.handled(memories.map((memory) =>
        `- ${memory.id} [${memory.type}${memory.confirmedAt ? '' : ' · 未确认，不会跨 Session 共享'}] ${memory.content}`,
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
