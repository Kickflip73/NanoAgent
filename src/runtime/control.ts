import { randomUUID } from 'node:crypto';
import { tool, type AgentInputItem, type Tool } from '@openai/agents';
import { z } from 'zod';

export const RUNTIME_OUTPUT_LEVELS = ['answer', 'thinking', 'tools', 'trace'] as const;
export type RuntimeOutputLevel = typeof RUNTIME_OUTPUT_LEVELS[number];

export type RuntimeAction =
  | { type: 'switch_session'; sessionId: string }
  | { type: 'new_session'; sessionId: string }
  | { type: 'clear_session' }
  | { type: 'set_output_level'; level: RuntimeOutputLevel }
  | { type: 'reload_mcp' }
  | { type: 'exit' };

export type RuntimeEffect =
  | { type: 'session_changed'; sessionId: string }
  | { type: 'session_cleared'; sessionId: string }
  | { type: 'output_level_changed'; level: RuntimeOutputLevel }
  | { type: 'mcp_reloaded' }
  | { type: 'exit_requested' };

export interface RuntimeControls {
  status: () => unknown | Promise<unknown>;
  models: () => string[];
  modes: () => Array<{ id: string; label: string; description: string }>;
  switchModel: (model: string) => void;
  switchMode: (mode: string) => void;
  listSessions: () => unknown | Promise<unknown>;
  history: (limit: number) => Promise<AgentInputItem[]>;
  schedule: (action: RuntimeAction) => void;
}

export function createRuntimeControlTools(controls: RuntimeControls): Tool[] {
  return [
    tool({
      name: 'runtime_status',
      description: '查看 NanoAgent 当前模型、模式、输出等级、Session、工作区、运行时代码目录和扩展状态。',
      parameters: z.object({}),
      execute: controls.status,
    }),
    tool({
      name: 'switch_model',
      description: '切换 NanoAgent 模型；当前任务继续使用原模型，新模型从下一轮对话生效。',
      parameters: z.object({ model: z.string().min(1) }),
      execute: async ({ model }) => {
        controls.switchModel(model);
        return { model, effective: 'next_turn', available: controls.models() };
      },
    }),
    tool({
      name: 'switch_mode',
      description: '切换标准、规划、编码或调研模式；从下一轮对话生效。',
      parameters: z.object({ mode: z.string().min(1) }),
      execute: async ({ mode }) => {
        controls.switchMode(mode);
        return { mode, effective: 'next_turn', available: controls.modes() };
      },
    }),
    tool({
      name: 'set_output_level',
      description: '调整终端事件展示等级：answer、thinking、tools 或 trace；本轮结束后生效。',
      parameters: z.object({ level: z.enum(RUNTIME_OUTPUT_LEVELS) }),
      execute: async ({ level }) => {
        controls.schedule({ type: 'set_output_level', level });
        return { level, effective: 'after_current_turn' };
      },
    }),
    tool({
      name: 'list_sessions',
      description: '列出 NanoAgent 最近的持久会话及内容摘要。',
      parameters: z.object({}),
      execute: controls.listSessions,
    }),
    tool({
      name: 'get_session_history',
      description: '读取当前 Session 最近的原始历史条目。',
      parameters: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      execute: async ({ limit }) => controls.history(limit),
    }),
    tool({
      name: 'switch_session',
      description: '切换到指定 Session；为保证当前工具调用完整，本轮回答结束后执行。',
      parameters: z.object({ sessionId: z.string().regex(/^[a-zA-Z0-9_-]+$/) }),
      execute: async ({ sessionId }) => {
        controls.schedule({ type: 'switch_session', sessionId });
        return { sessionId, effective: 'after_current_turn' };
      },
    }),
    tool({
      name: 'new_session',
      description: '创建并切换到新 Session；本轮回答结束后执行。',
      parameters: z.object({ sessionId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional() }),
      execute: async ({ sessionId }) => {
        const id = sessionId ?? randomUUID().slice(0, 8);
        controls.schedule({ type: 'new_session', sessionId: id });
        return { sessionId: id, effective: 'after_current_turn' };
      },
    }),
    tool({
      name: 'clear_session',
      description: '清空当前 Session；本轮回答保存完成后执行。',
      parameters: z.object({}),
      execute: async () => {
        controls.schedule({ type: 'clear_session' });
        return { effective: 'after_current_turn' };
      },
    }),
    tool({
      name: 'reload_mcp',
      description: '重新读取 MCP JSON 配置并热重载 MCP Server；本轮回答完成后执行，避免中断当前工具连接。',
      parameters: z.object({}),
      execute: async () => {
        controls.schedule({ type: 'reload_mcp' });
        return { effective: 'after_current_turn' };
      },
    }),
    tool({
      name: 'request_exit',
      description: '在用户明确要求退出 NanoAgent 时关闭交互进程；本轮回答完成后执行。',
      parameters: z.object({}),
      execute: async () => {
        controls.schedule({ type: 'exit' });
        return { effective: 'after_current_turn' };
      },
    }),
  ];
}
