import { OpenAIChatCompletionsModel, type Model } from '@openai/agents';
import OpenAI from 'openai';
import type { AppConfig } from '../config.js';

export type AgentModel = string | Model;

export interface ModelRuntime {
  model: AgentModel;
  name: string;
}

export function createModel(config: AppConfig, name?: string): ModelRuntime {
  const modelName = name ?? (config.provider === 'deepseek'
    ? (process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash')
    : (process.env.OPENAI_MODEL ?? 'gpt-5.4-mini'));
  if (config.provider === 'openai') return { model: modelName, name: modelName };
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
  };
}
