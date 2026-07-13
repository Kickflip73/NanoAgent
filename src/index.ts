#!/usr/bin/env node
import 'dotenv/config';
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import readline from 'node:readline/promises';
import { setDefaultOpenAIClient, setTracingDisabled } from '@openai/agents';
import OpenAI from 'openai';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { NanoAgent } from './agent.js';
import { CommandHandler, commandHelp } from './commands.js';
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

async function version(): Promise<string> {
  const file = new URL('../package.json', import.meta.url);
  const manifest = JSON.parse(await readFile(file, 'utf8')) as { version: string };
  return manifest.version;
}

function cliHelp(): string {
  return `NanoAgent - 轻量级 Agent 学习助手

用法：
  nano                    启动交互模式
  nano "任务"             执行单次任务
  nano --help             查看帮助
  nano --version          查看版本

${commandHelp()}`;
}

function requireApiKey(): void {
  const key = config.provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY;
  if (!key) {
    console.error(`缺少 ${config.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY'}`);
    process.exit(1);
  }
}

function configureOpenAI(): void {
  if (config.provider === 'openai') {
    setDefaultOpenAIClient(new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: proxyAwareFetch }));
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(cliHelp());
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(await version());
    return;
  }

  requireApiKey();
  configureOpenAI();
  const agent = await NanoAgent.create(config);
  const oneShotInput = args.join(' ').trim();

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
    const commands = new CommandHandler(agent, runTask);
    console.log(`NanoAgent v${await version()} · 输入 /help 查看命令`);
    console.log(`模型：${config.provider} · 会话：${agent.currentSessionId}`);
    console.log(`工作区：${config.workspaceRoot}`);
    if (agent.mcpServerNames.length) console.log(`MCP：${agent.mcpServerNames.join(', ')}`);

    try {
      while (true) {
        const input = (await terminal.question('\n你> ')).trim();
        if (!input) continue;
        try {
          const result = await commands.execute(input);
          if (result === 'exit') break;
          if (result === 'handled') continue;
          commands.remember(input);
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
