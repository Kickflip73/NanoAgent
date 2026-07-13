#!/usr/bin/env node
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { setDefaultOpenAIClient, setTracingDisabled } from '@openai/agents';
import OpenAI from 'openai';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { NanoAgent } from './agent.js';
import { COMMANDS, CommandHandler, commandHelp } from './commands.js';
import { loadConfig, loadEnvironment } from './config.js';
import { InteractiveTerminal } from './interactive.js';
import type { RuntimeEffect } from './runtime/control.js';
import { normalizeOutputLevel, OUTPUT_LEVELS, parseRunEvent, renderBanner, renderSessionTranscript, TerminalRenderer, type OutputLevel } from './terminal.js';

loadEnvironment();

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
  return `NanoAgent - 轻量级通用 Agent

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
  let outputLevel: OutputLevel = normalizeOutputLevel(process.env.OUTPUT_LEVEL);
  agent.setOutputLevel(outputLevel);
  let handleRuntimeEffects = async (_effects: RuntimeEffect[]): Promise<void> => undefined;

  const runTask = async (
    input: string,
    signal?: AbortSignal,
    renderer = new TerminalRenderer(process.stderr, process.stdout, outputLevel),
  ): Promise<void> => {
    let finalAnswer = '';
    renderer.start('模型思考中', input);
    try {
      const stream = await agent.stream(input, signal);
      for await (const event of stream) {
        renderer.handle(event);
        const display = parseRunEvent(event);
        if (display?.kind === 'answer') finalAnswer += display.text;
        if (display?.kind === 'status') await agent.recordEvent('status', display);
      }
      await stream.completed;
      renderer.finish();
      const effects = await agent.completeRun(finalAnswer.slice(0, 20_000));
      await handleRuntimeEffects(effects);
    } catch (error) {
      renderer.stop();
      await agent.failRun(error);
      throw error;
    }
  };

  try {
    if (oneShotInput) {
      await runTask(oneShotInput);
      return;
    }

    const terminal = new InteractiveTerminal([...COMMANDS]);
    const stdout = terminal.createWriter(process.stdout);
    const stderr = terminal.createWriter(process.stderr);
    const appVersion = await version();
    const banner = async () => {
      const info = await agent.runtimeInfo();
      return renderBanner({
        version: appVersion,
        provider: info.provider,
        model: info.model,
        sessionTitle: info.sessionTitle,
        workspaceRoot: info.workspaceRoot,
        skillCount: info.skillCount,
        mcpServers: info.mcpServers,
      }, Boolean(process.stdout.isTTY));
    };
    const sessionView = async () => {
      const [header, history] = await Promise.all([banner(), agent.history()]);
      const transcript = renderSessionTranscript(history, Boolean(process.stdout.isTTY));
      return [header, transcript].filter(Boolean).join('\n\n');
    };
    handleRuntimeEffects = async (effects) => {
      const latest = [...effects].reverse();
      const output = latest.find((effect) => effect.type === 'output_level_changed');
      if (output?.type === 'output_level_changed') outputLevel = output.level;
      const session = latest.find((effect) => effect.type === 'session_changed' || effect.type === 'session_cleared');
      if (session?.type === 'session_changed') terminal.clearScreen(await sessionView());
      if (session?.type === 'session_cleared') terminal.clearScreen(await banner());
      if (latest.some((effect) => effect.type === 'exit_requested')) {
        exitRequested = true;
        queue.length = 0;
        terminal.setQueue(queue);
        terminal.close();
        resolveClosed();
      }
    };
    const refreshRuntimeStatus = async () => {
      const [info, context] = await Promise.all([agent.runtimeInfo(), agent.contextInfo()]);
      terminal.setRuntimeStatus({
        mode: info.mode.label,
        model: info.model,
        contextUsed: context.estimatedTokens,
        contextWindow: context.contextWindow,
      });
    };
    let currentAbort: AbortController | undefined;
    let drainPromise: Promise<void> | undefined;
    let exitRequested = false;
    const queue: string[] = [];
    const queuedRunTask = (input: string) => runTask(input, currentAbort?.signal, new TerminalRenderer(stderr, stdout, outputLevel));
    const commands = new CommandHandler(agent, queuedRunTask, {
      write: (text) => terminal.notify(text),
      resetScreen: async () => terminal.clearScreen(await banner()),
      restoreSession: async () => terminal.clearScreen(await sessionView()),
      selectSession: async (sessions) => terminal.select(sessions.map((session) => ({
        value: session.id,
        label: `${session.id === agent.currentSessionId ? '● ' : ''}${session.title}`,
        detail: `${session.turns} 轮 · ${session.preview}`,
      })), '选择对话'),
      selectModel: async (models, current) => terminal.select(models.map((model) => ({
        value: model,
        label: `${model === current ? '● ' : ''}${model}`,
        detail: model === current ? '当前模型' : config.provider,
      })), '选择模型'),
      selectMode: async (modes, current) => terminal.select(modes.map((mode) => ({
        value: mode.id,
        label: `${mode.id === current ? '● ' : ''}${mode.label}`,
        detail: mode.description,
      })), '选择模式'),
      getOutputLevel: () => outputLevel,
      setOutputLevel: (level) => {
        outputLevel = level;
        agent.setOutputLevel(level);
      },
      selectOutputLevel: async (current) => terminal.select(OUTPUT_LEVELS.map((level) => ({
        value: level.id,
        label: `${level.id === current ? '● ' : ''}${level.label}`,
        detail: level.description,
      })), '选择输出等级'),
    });
    await refreshRuntimeStatus();
    console.log(await sessionView());

    const drain = async (): Promise<void> => {
      if (drainPromise) return drainPromise;
      drainPromise = (async () => {
        terminal.setBusy(true);
        while (queue.length && !exitRequested) {
          const input = queue.shift()!;
          terminal.setQueue(queue);
          terminal.recordInput(input);
          currentAbort = new AbortController();
          try {
            const result = await commands.execute(input);
            if (result === 'exit') {
              exitRequested = true;
              queue.length = 0;
              terminal.setQueue(queue);
              terminal.close();
              resolveClosed();
              break;
            }
            if (result === 'handled') continue;
            commands.remember(input);
            await queuedRunTask(input);
          } catch (error) {
            if (currentAbort.signal.aborted) {
              terminal.notify('已停止当前任务。');
            } else {
              terminal.notify(`运行失败：${error instanceof Error ? error.message : String(error)}`);
            }
          } finally {
            currentAbort = undefined;
            await refreshRuntimeStatus();
          }
        }
        terminal.setBusy(false);
      })().finally(() => {
        drainPromise = undefined;
        if (queue.length && !exitRequested) void drain();
      });
      return drainPromise;
    };

    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    terminal.start({
      onLine: (input) => {
        queue.push(input);
        terminal.setQueue(queue);
        void drain();
      },
      onEscape: () => {
        if (!currentAbort || currentAbort.signal.aborted) return;
        currentAbort.abort(new Error('用户按下 Esc 停止任务'));
      },
      onExit: () => {
        exitRequested = true;
        queue.length = 0;
        terminal.setQueue(queue);
        currentAbort?.abort(new Error('用户退出'));
        terminal.close();
        resolveClosed();
      },
    });

    try {
      await closed;
      await drainPromise;
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
