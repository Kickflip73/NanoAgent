import 'dotenv/config';
import process from 'node:process';
import readline from 'node:readline/promises';
import { setDefaultOpenAIClient } from '@openai/agents';
import OpenAI from 'openai';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { NanoAgent } from './agent.js';
import { TerminalRenderer } from './terminal.js';

const proxyDispatcher =
  process.env.HTTPS_PROXY || process.env.HTTP_PROXY
    ? new EnvHttpProxyAgent()
    : undefined;
const proxyAwareFetch: typeof globalThis.fetch = (input, init) => {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  headers.set('accept-encoding', 'identity');
  return undiciFetch(input as never, {
    ...init,
    dispatcher: proxyDispatcher,
    headers,
  } as never) as unknown as Promise<Response>;
};

globalThis.fetch = proxyAwareFetch;

if ((process.env.MODEL_PROVIDER ?? 'openai') === 'openai') {
  setDefaultOpenAIClient(
    new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      fetch: proxyAwareFetch,
    }),
  );
}

function requireApiKey(): void {
  const provider = process.env.MODEL_PROVIDER ?? 'openai';
  const key =
    provider === 'deepseek'
      ? process.env.DEEPSEEK_API_KEY
      : process.env.OPENAI_API_KEY;
  if (!key) {
    console.error(`缺少 ${provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY'}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  requireApiKey();

  const workspaceRoot = process.env.AGENT_WORKSPACE ?? process.cwd();
  const agent = new NanoAgent(workspaceRoot);
  const oneShotInput = process.argv.slice(2).join(' ').trim();

  const runTask = async (input: string): Promise<void> => {
    const renderer = new TerminalRenderer();
    renderer.start();
    try {
      const stream = await agent.stream(input);
      for await (const event of stream) renderer.handle(event);
      await stream.completed;
      renderer.finish();
    } catch (error) {
      renderer.stop();
      throw error;
    }
  };

  if (oneShotInput) {
    await runTask(oneShotInput);
    return;
  }

  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('NanoAgent 已启动。输入 /exit 退出，/clear 清屏。');
  console.log(`模型：${process.env.MODEL_PROVIDER ?? 'openai'}`);
  console.log(`工作区：${workspaceRoot}`);

  try {
    while (true) {
      const input = (await terminal.question('\n你> ')).trim();
      if (!input) continue;
      if (input === '/exit') break;
      if (input === '/clear') {
        console.clear();
        continue;
      }

      try {
        await runTask(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`\n运行失败：${message}`);
      }
    }
  } finally {
    terminal.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
