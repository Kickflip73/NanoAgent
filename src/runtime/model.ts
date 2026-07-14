import { OpenAIChatCompletionsModel, type Model } from '@openai/agents';
import OpenAI from 'openai';
import type { AppConfig } from '../config.js';

export type AgentModel = string | Model;

export interface ModelRuntime {
  model: AgentModel;
  name: string;
  profile: ModelProfile;
}

export interface ModelProfile {
  contextWindow: number;
  outputReserve: number;
}

const MODEL_PROFILES: Record<string, ModelProfile> = {
  'deepseek-v4-pro': { contextWindow: 1_048_576, outputReserve: 65_536 },
  'deepseek-v4-flash': { contextWindow: 128_000, outputReserve: 16_384 },
  'gpt-5.4-mini': { contextWindow: 400_000, outputReserve: 32_768 },
  'gpt-5.4': { contextWindow: 400_000, outputReserve: 32_768 },
  'gpt-5-mini': { contextWindow: 400_000, outputReserve: 32_768 },
};

function positiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} 必须是正整数`);
  return parsed;
}

function modelEnvironmentPrefix(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export function resolveModelProfile(config: AppConfig, name: string): ModelProfile {
  const fallback = config.provider === 'deepseek'
    ? { contextWindow: 128_000, outputReserve: 16_384 }
    : { contextWindow: 400_000, outputReserve: 32_768 };
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
  return { contextWindow, outputReserve };
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
