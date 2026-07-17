import { setDefaultOpenAIClient, setTracingDisabled } from '@openai/agents';
import OpenAI from 'openai';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import type { AppConfig } from '../config.js';

let configured = false;

export function requireProviderApiKey(config: AppConfig): void {
  const name = config.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY';
  if (!process.env[name]) throw new Error(`缺少 ${name}`);
}

export function configureAgentRuntime(config: AppConfig): void {
  if (!configured) {
    const dispatcher = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
      ? new EnvHttpProxyAgent()
      : undefined;
    const proxyAwareFetch: typeof globalThis.fetch = (input, init) => {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
      headers.set('accept-encoding', 'identity');
      return undiciFetch(input as never, { ...init, dispatcher, headers } as never) as unknown as Promise<Response>;
    };
    globalThis.fetch = proxyAwareFetch;
    setTracingDisabled(true);
    configured = true;
  }
  if (config.provider === 'openai') {
    setDefaultOpenAIClient(new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: globalThis.fetch }));
  }
}

