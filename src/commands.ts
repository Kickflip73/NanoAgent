import { randomUUID } from 'node:crypto';
import type { NanoAgent } from './agent.js';

export type CommandResult = 'handled' | 'exit' | 'pass';

const HELP = `内置命令：
  /status             查看模型、会话和扩展状态
  /new [id]           新建并切换会话
  /sessions           列出会话
  /switch <id>        切换会话
  /history            查看当前会话历史
  /clear              清空当前会话
  /skills             列出可用 Skills
  /memories           列出长期记忆
  /plan               查看当前任务计划
  /index [path]       索引知识库，默认 knowledge
  /retry              重新执行上一条用户输入
  /help               显示帮助
  /exit               退出`;

export class CommandHandler {
  private lastInput?: string;

  constructor(
    private readonly agent: NanoAgent,
    private readonly runTask: (input: string) => Promise<void>,
  ) {}

  remember(input: string): void {
    this.lastInput = input;
  }

  async execute(input: string): Promise<CommandResult> {
    if (!input.startsWith('/')) return 'pass';
    const [command, ...rest] = input.split(/\s+/);
    const argument = rest.join(' ').trim();

    if (command === '/exit') return 'exit';
    if (command === '/help') {
      console.log(HELP);
      return 'handled';
    }
    if (command === '/status') {
      const info = await this.agent.runtimeInfo();
      console.log([
        `模型      ${info.provider} / ${info.model}`,
        `会话      ${info.sessionId}`,
        `工作区    ${info.workspaceRoot}`,
        `最大轮数  ${info.maxTurns}`,
        `Skills    ${info.skillCount}`,
        `Memories  ${info.memoryCount}`,
        `MCP       ${info.mcpServers.join(', ') || '未连接'}`,
      ].join('\n'));
      return 'handled';
    }
    if (command === '/new') {
      const id = argument || randomUUID().slice(0, 8);
      await this.agent.switchSession(id);
      console.log(`已创建并切换到会话：${id}`);
      return 'handled';
    }
    if (command === '/sessions') {
      const sessions = await this.agent.listSessions();
      console.log(sessions.map((id) => `${id === this.agent.currentSessionId ? '*' : ' '} ${id}`).join('\n') || '暂无会话');
      return 'handled';
    }
    if (command === '/switch') {
      if (!argument) throw new Error('用法：/switch <session-id>');
      await this.agent.switchSession(argument);
      console.log(`已切换到会话：${argument}`);
      return 'handled';
    }
    if (command === '/history') {
      const items = await this.agent.history();
      console.log(items.map((item, index) => `${index + 1}. ${JSON.stringify(item)}`).join('\n') || '当前会话为空');
      return 'handled';
    }
    if (command === '/clear') {
      await this.agent.clearSession();
      console.log('当前会话已清空。');
      return 'handled';
    }
    if (command === '/skills') {
      const skills = this.agent.listSkills();
      console.log(skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n') || '暂无 Skills');
      return 'handled';
    }
    if (command === '/memories') {
      const memories = await this.agent.listMemories();
      console.log(memories.map((memory) => `- ${memory.id} [${memory.type}] ${memory.content}`).join('\n') || '暂无长期记忆');
      return 'handled';
    }
    if (command === '/plan') {
      const plan = await this.agent.currentPlan();
      console.log(plan.map((step) => `- [${step.status}] ${step.id}. ${step.description}`).join('\n') || '当前没有计划');
      return 'handled';
    }
    if (command === '/index') {
      console.log('正在构建知识库索引...');
      console.log(await this.agent.indexKnowledge(argument || 'knowledge'));
      return 'handled';
    }
    if (command === '/retry') {
      if (!this.lastInput) {
        console.log('没有可重试的用户输入。');
        return 'handled';
      }
      console.log(`重新执行：${this.lastInput}`);
      await this.runTask(this.lastInput);
      return 'handled';
    }

    console.log(`未知命令：${command}。输入 /help 查看可用命令。`);
    return 'handled';
  }
}

export function commandHelp(): string {
  return HELP;
}
