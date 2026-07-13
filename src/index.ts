import 'dotenv/config';
import process from 'node:process';
import readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { setDefaultOpenAIClient, setTracingDisabled } from '@openai/agents';
import OpenAI from 'openai';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { NanoAgent } from './agent.js';
import { loadConfig } from './config.js';
import { parseRunEvent, TerminalRenderer } from './terminal.js';

const proxyDispatcher = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
  ? new EnvHttpProxyAgent()
  : undefined;
const proxyAwareFetch: typeof globalThis.fetch = (input, init) => {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  headers.set('accept-encoding', 'identity');
  return undiciFetch(input as never, { ...init, dispatcher: proxyDispatcher, headers } as never) as unknown as Promise<Response>;
};
globalThis.fetch = proxyAwareFetch;
setTracingDisabled(true);

const config = loadConfig();
if (config.provider === 'openai') {
  setDefaultOpenAIClient(new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: proxyAwareFetch }));
}

function requireApiKey(): void {
  const key = config.provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY;
  if (!key) {
    console.error(`缺少 ${config.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY'}`);
    process.exit(1);
  }
}

function compactHistory(items: unknown[]): string {
  return items.map((item, index) => `${index + 1}. ${JSON.stringify(item)}`).join('\n');
}

async function main(): Promise<void> {
  requireApiKey();
  const agent = await NanoAgent.create(config);
  const oneShotInput = process.argv.slice(2).join(' ').trim();

  const runTask = async (input: string): Promise<void> => {
    const renderer = new TerminalRenderer();
    let finalAnswer = '';
    renderer.start();
    try {
      const stream = await agent.stream(input);
      for await (const event of stream) {
        renderer.handle(event);
        const display = parseRunEvent(event);
        if (display?.kind === 'answer') finalAnswer += display.text;
        if (display?.kind === 'status') await agent.recordEvent('status', display);
      }
      await stream.completed;
      renderer.finish();
      await agent.recordEvent('turn_end', { answer: finalAnswer.slice(0, 20_000) });
    } catch (error) {
      renderer.stop();
      await agent.recordEvent('error', { message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };

  try {
    if (oneShotInput) {
      await runTask(oneShotInput);
      return;
    }

    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('NanoAgent 已启动。输入 /help 查看命令。');
    console.log(`模型：${config.provider} · 会话：${agent.currentSessionId}`);
    console.log(`工作区：${config.workspaceRoot}`);
    if (agent.mcpServerNames.length) console.log(`MCP：${agent.mcpServerNames.join(', ')}`);

    try {
      while (true) {
        const input = (await terminal.question('\n你> ')).trim();
        if (!input) continue;
        if (input === '/exit') break;
        if (input === '/help') {
          console.log('/new [id]  /sessions  /switch <id>  /history  /clear  /index [path]  /exit');
          continue;
        }
        if (input === '/clear') {
          await agent.clearSession();
          console.log('当前会话已清空。');
          continue;
        }
        if (input === '/sessions') {
          console.log((await agent.listSessions()).map((id) => `${id === agent.currentSessionId ? '*' : ' '} ${id}`).join('\n') || '暂无会话');
          continue;
        }
        if (input === '/history') {
          console.log(compactHistory(await agent.history()) || '当前会话为空');
          continue;
        }
        if (input.startsWith('/new')) {
          const id = input.split(/\s+/)[1] ?? randomUUID().slice(0, 8);
          await agent.switchSession(id);
          console.log(`已创建并切换到会话：${id}`);
          continue;
        }
        if (input.startsWith('/switch ')) {
          const id = input.slice('/switch '.length).trim();
          await agent.switchSession(id);
          console.log(`已切换到会话：${id}`);
          continue;
        }
        if (input === '/index' || input.startsWith('/index ')) {
          const target = input.slice('/index'.length).trim() || 'knowledge';
          console.log('正在构建知识库索引...');
          console.log(await agent.indexKnowledge(target));
          continue;
        }
        try {
          await runTask(input);
        } catch (error) {
          console.error(`\n运行失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      terminal.close();
    }
  } finally {
    await agent.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
