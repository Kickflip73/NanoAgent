import { randomUUID } from 'node:crypto';
import { tool, type AgentInputItem, type Tool } from '@openai/agents';
import { z } from 'zod';
import { sessionIdSchema } from '../core/session-id.js';

export const RUNTIME_OUTPUT_LEVELS = ['answer', 'thinking', 'tools', 'trace'] as const;
export type RuntimeOutputLevel = typeof RUNTIME_OUTPUT_LEVELS[number];

const modelNameSchema = z.string().regex(/^[a-zA-Z0-9._:/-]+$/).max(200);
const modeIdSchema = z.string().regex(/^[a-zA-Z0-9._-]+$/).max(60);

export const runtimeActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('switch_model'), model: modelNameSchema }).strict(),
  z.object({ type: z.literal('switch_mode'), mode: modeIdSchema }).strict(),
  z.object({ type: z.literal('switch_session'), sessionId: sessionIdSchema }).strict(),
  z.object({ type: z.literal('new_session'), sessionId: sessionIdSchema }).strict(),
  z.object({ type: z.literal('clear_session') }).strict(),
  z.object({ type: z.literal('set_output_level'), level: z.enum(RUNTIME_OUTPUT_LEVELS) }).strict(),
  z.object({ type: z.literal('reload_mcp') }).strict(),
  z.object({ type: z.literal('exit') }).strict(),
]);
export type RuntimeAction = z.infer<typeof runtimeActionSchema>;

export const runtimeEffectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('model_changed'), model: modelNameSchema }).strict(),
  z.object({ type: z.literal('mode_changed'), mode: modeIdSchema }).strict(),
  z.object({ type: z.literal('session_changed'), sessionId: sessionIdSchema }).strict(),
  z.object({ type: z.literal('session_cleared'), sessionId: sessionIdSchema }).strict(),
  z.object({ type: z.literal('output_level_changed'), level: z.enum(RUNTIME_OUTPUT_LEVELS) }).strict(),
  z.object({ type: z.literal('mcp_reloaded') }).strict(),
  z.object({ type: z.literal('exit_requested') }).strict(),
]);
export type RuntimeEffect = z.infer<typeof runtimeEffectSchema>;

export interface RuntimeControls {
  status: () => unknown | Promise<unknown>;
  models: () => string[];
  modes: () => Array<{ id: string; label: string; description: string }>;
  listSessions: () => unknown | Promise<unknown>;
  history: (limit: number) => Promise<AgentInputItem[]>;
  canAccessSessions?: () => boolean;
  canClearSession?: () => boolean;
  schedule: (action: RuntimeAction) => void;
}

export function createRuntimeControlTools(controls: RuntimeControls): Tool[] {
  return [
    tool({
      name: 'runtime_status',
      description: '查看 MimiAgent 当前模型、模式、输出等级、Session、工作区、运行时代码目录和扩展状态。',
      parameters: z.object({}),
      execute: controls.status,
    }),
    tool({
      name: 'switch_model',
      description: '切换 MimiAgent 模型；当前任务继续使用原模型，新模型从下一轮对话生效。',
      parameters: z.object({ model: z.string().min(1) }),
      execute: async ({ model }) => {
        if (!modelNameSchema.safeParse(model).success) throw new Error('模型名称格式无效');
        const available = controls.models();
        controls.schedule({ type: 'switch_model', model });
        return { model, effective: 'next_turn', available };
      },
    }),
    tool({
      name: 'switch_mode',
      description: '切换通用（general）、Plan（plan）或 Ultra Team（ultra）模式；从下一轮对话生效。',
      parameters: z.object({ mode: z.string().min(1) }),
      execute: async ({ mode }) => {
        const available = controls.modes();
        if (!available.some((candidate) => candidate.id === mode)) throw new Error(`未知模式：${mode}`);
        controls.schedule({ type: 'switch_mode', mode });
        return { mode, effective: 'next_turn', available };
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
      description: '列出 MimiAgent 持久会话的 ID、时间、轮数和恢复状态；不会读取其他会话内容。',
      parameters: z.object({}),
      execute: async () => {
        if (controls.canAccessSessions && !controls.canAccessSessions()) throw new Error('本轮用户没有要求访问其他 Session');
        return controls.listSessions();
      },
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
      parameters: z.object({ sessionId: sessionIdSchema }),
      execute: async ({ sessionId }) => {
        if (controls.canAccessSessions && !controls.canAccessSessions()) throw new Error('本轮用户没有要求切换 Session');
        controls.schedule({ type: 'switch_session', sessionId });
        return { sessionId, effective: 'after_current_turn' };
      },
    }),
    tool({
      name: 'new_session',
      description: '创建并切换到新 Session；本轮回答结束后执行。',
      parameters: z.object({ sessionId: sessionIdSchema.optional() }),
      execute: async ({ sessionId }) => {
        if (controls.canAccessSessions && !controls.canAccessSessions()) throw new Error('本轮用户没有要求创建 Session');
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
        if (controls.canClearSession && !controls.canClearSession()) {
          throw new Error('本轮用户没有明确要求清空当前 Session');
        }
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
      description: '在用户明确要求退出 MimiAgent 时关闭交互进程；本轮回答完成后执行。',
      parameters: z.object({}),
      execute: async () => {
        controls.schedule({ type: 'exit' });
        return { effective: 'after_current_turn' };
      },
    }),
  ];
}
