import { OpenAIChatCompletionsModel, type AgentInputItem } from '@openai/agents';
import OpenAI from 'openai';
import type { AppConfig } from '../config.js';
import type { AgentModel } from '../extensions/model-port.js';

export type { AgentModel } from '../extensions/model-port.js';

export interface ModelRuntime {
  model: AgentModel;
  name: string;
  profile: ModelProfile;
}

export interface ModelProfile {
  contextWindow: number;
  outputReserve: number;
  supportsImageInput: boolean;
}

export function normalizeModelInput(
  provider: AppConfig['provider'],
  items: AgentInputItem[],
): AgentInputItem[] {
  if (provider !== 'openai') return items;
  return items.map((item) => {
    const value = item as unknown as Record<string, unknown>;
    if (value.type !== 'message' || typeof value.id !== 'string' || value.id.startsWith('msg')) {
      return item;
    }
    const { id: _providerSpecificId, ...portable } = value;
    return portable as unknown as AgentInputItem;
  });
}

export function prepareComputerHistoryForModelInput(items: AgentInputItem[]): AgentInputItem[] {
  const callIds = new Set<string>();
  for (const item of items) {
    const value = item as unknown as Record<string, unknown>;
    if (value.type === 'function_call' && value.name === 'computer_observe' && typeof value.callId === 'string') {
      callIds.add(value.callId);
    }
  }
  return items.map((item) => {
    const value = item as unknown as Record<string, unknown>;
    const computerResult = value.type === 'function_call_result'
      && (value.name === 'computer_observe' || (typeof value.callId === 'string' && callIds.has(value.callId)));
    if (!computerResult || !Array.isArray(value.output)) return item;
    let replaced = false;
    const output = value.output.map((part) => {
      const block = part as Record<string, unknown>;
      if (block?.type !== 'image') return part;
      replaced = true;
      return { type: 'text', text: '[历史 Computer Observation 图片已省略；执行新动作前请重新观察。]' };
    });
    return replaced ? { ...value, output } as unknown as AgentInputItem : item;
  });
}

const MODEL_PROFILES: Record<string, ModelProfile> = {
  'deepseek-v4-pro': { contextWindow: 1_048_576, outputReserve: 65_536, supportsImageInput: false },
  'deepseek-v4-flash': { contextWindow: 128_000, outputReserve: 16_384, supportsImageInput: false },
  'gpt-5.4-mini': { contextWindow: 400_000, outputReserve: 32_768, supportsImageInput: true },
  'gpt-5.4': { contextWindow: 400_000, outputReserve: 32_768, supportsImageInput: true },
  'gpt-5-mini': { contextWindow: 400_000, outputReserve: 32_768, supportsImageInput: true },
};

function positiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} 必须是正整数`);
  return parsed;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${label} 只能是 true 或 false`);
}

function modelEnvironmentPrefix(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export function resolveModelProfile(config: AppConfig, name: string): ModelProfile {
  const fallback = config.provider === 'deepseek'
    ? { contextWindow: 128_000, outputReserve: 16_384, supportsImageInput: false }
    : { contextWindow: 400_000, outputReserve: 32_768, supportsImageInput: false };
  const builtIn = MODEL_PROFILES[name] ?? fallback;
  const prefix = modelEnvironmentPrefix(name);
  const contextOverride = positiveInteger(
    process.env[`${prefix}_CONTEXT_WINDOW`] ?? config.contextWindow,
    `${prefix}_CONTEXT_WINDOW`,
  );
  const contextWindow = contextOverride ?? builtIn.contextWindow;
  const reserveOverride = positiveInteger(
    process.env[`${prefix}_OUTPUT_RESERVE`] ?? config.outputReserve,
    `${prefix}_OUTPUT_RESERVE`,
  );
  const outputReserve = reserveOverride
    ?? (contextOverride ? Math.min(builtIn.outputReserve, Math.max(256, Math.floor(contextWindow * 0.1))) : builtIn.outputReserve);
  if (outputReserve >= contextWindow) throw new Error(`模型 ${name} 的输出预留必须小于上下文窗口`);
  const supportsImageInput = optionalBoolean(
    process.env[`${prefix}_SUPPORTS_IMAGE_INPUT`] ?? process.env.MIMI_MODEL_SUPPORTS_IMAGE_INPUT,
    `${prefix}_SUPPORTS_IMAGE_INPUT`,
  ) ?? builtIn.supportsImageInput;
  return { contextWindow, outputReserve, supportsImageInput };
}

export function createModel(config: AppConfig, name?: string): ModelRuntime {
  const modelName = name ?? (config.provider === 'deepseek'
    ? (process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro')
    : (process.env.OPENAI_MODEL ?? 'gpt-5.4-mini'));
  const profile = resolveModelProfile(config, modelName);
  if (config.provider === 'openai') return { model: modelName, name: modelName, profile };
  return {
    model: new OpenAIChatCompletionsModel(
      new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
        fetch: globalThis.fetch,
      }),
      modelName,
    ),
    name: modelName,
    profile,
  };
}
