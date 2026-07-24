import process from 'node:process';
import { preferredEnvironmentValue, securityProfileSummary, type AppConfig } from './config.js';
import {
  COMMANDS,
  CommandHandler,
  commandHelp,
} from './commands.js';
import { capabilityDisclosureForInput } from './core/user-intent.js';
import {
  MimiChatClient,
  RemoteCommandTarget,
  eventAnswer,
  eventEffects,
  synchronizeRemoteRuntimeEffects,
  type DaemonReconciler,
} from './daemon/chat-client.js';
import type { MimiChatSnapshot } from './daemon/types.js';
import { InteractiveTerminal, type CompletionItem } from './interactive.js';
import {
  normalizeOutputLevel,
  OUTPUT_LEVELS,
  renderRecoveryCheckpoint,
  renderSessionTranscript,
  TerminalRenderer,
} from './terminal.js';

const CHAT_COMMANDS: CompletionItem[] = [...COMMANDS];

export const CHAT_HELP = `${commandHelp()}

这些命令作用于后台唯一 MimiAgent。/exit 只关闭当前终端。`;

function runLabel(input: string): string {
  return capabilityDisclosureForInput(input) === 'status' ? '读取本机状态' : '模型思考中';
}

export function renderChatHistory(snapshot: MimiChatSnapshot, tty: boolean): string {
  return [
    renderSessionTranscript(snapshot.items, tty),
    renderRecoveryCheckpoint(snapshot.recovery, tty),
  ].filter(Boolean).join('\n\n');
}

function renderBanner(version: string, snapshot: MimiChatSnapshot, securityLabel: string): string {
  return [
    `MimiAgent v${version}`,
    '全天候个人 Agent · CLI 已连接统一后台',
    `模型    ${snapshot.provider} · ${snapshot.model}`,
    `对话    ${snapshot.draft ? '新对话（发送消息后创建）' : snapshot.sessionId}`,
    `工作区  ${snapshot.workspaceRoot}`,
    `安全    ${securityLabel} · /security 查看权限边界`,
  ].join('\n');
}

export async function runMimiCli(
  config: AppConfig,
  args: string[],
  version: string,
  reconcileDaemon?: DaemonReconciler,
): Promise<void> {
  const client = reconcileDaemon
    ? new MimiChatClient(config, reconcileDaemon)
    : new MimiChatClient(config);
  await client.connect();
  const securityLabel = securityProfileSummary(config).label;
  const configuredSession = preferredEnvironmentValue('MIMI_SESSION', 'AGENT_SESSION');
  const oneShotInput = args.join(' ').trim();
  if (oneShotInput) {
    const current = configuredSession
      ? await client.snapshot(30, configuredSession)
      : await client.bootstrap();
    const renderer = new TerminalRenderer(process.stderr, process.stdout, normalizeOutputLevel(current.outputLevel));
    renderer.start(runLabel(oneShotInput), oneShotInput);
    let streamedAnswer = '';
    try {
      const accepted = await client.submit(oneShotInput, current.sessionId);
      const event = await client.wait(accepted.eventId, undefined, (streamed) => {
        if (streamed.kind === 'plan') return;
        if (streamed.kind === 'answer') streamedAnswer += streamed.text;
        renderer.handleDisplay(streamed);
      });
      const answer = eventAnswer(event);
      if (!streamedAnswer) renderer.handleDisplay({ kind: 'answer', text: answer });
      else if (answer.startsWith(streamedAnswer)) {
        const tail = answer.slice(streamedAnswer.length);
        if (tail) renderer.handleDisplay({ kind: 'answer', text: tail });
      }
      renderer.finish();
    } catch (error) {
      renderer.stop();
      throw error;
    }
    return;
  }

  let snapshot = configuredSession
    ? await client.snapshot(30, configuredSession)
    : await client.bootstrap();
  const target = new RemoteCommandTarget(client, snapshot.sessionId, !snapshot.draft);
  const terminal = new InteractiveTerminal(CHAT_COMMANDS);
  const queue: string[] = [];
  let activeAbort: AbortController | undefined;
  let activeEventId: string | undefined;
  let activeCancelRequested = false;
  let activeCancelSent = false;
  let cyclingMode = false;
  let draining = false;
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const tty = Boolean(process.stdout.isTTY);

  const refresh = async () => {
    snapshot = target.sessionReady
      ? await client.snapshot(30, target.currentSessionId)
      : await client.bootstrap(target.currentSessionId);
    terminal.useSession(snapshot.sessionId);
    terminal.setRuntimeStatus({
      mode: snapshot.mode,
      model: snapshot.model,
      contextUsed: snapshot.contextUsed,
      contextWindow: snapshot.contextWindow,
      contextSource: snapshot.contextStatus?.source ?? 'raw-history',
      compressedFrom: snapshot.contextStatus?.compressedFrom,
    });
    terminal.setTasks(snapshot.plan);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    queue.length = 0;
    activeAbort?.abort(new Error('终端已退出；MimiAgent 任务继续在后台执行'));
    terminal.setQueue(queue);
    terminal.close();
    resolveClosed();
  };
  const cancelActiveEvent = () => {
    const eventId = activeEventId;
    if (!eventId || activeCancelSent) return;
    activeCancelSent = true;
    void client.cancel(eventId, '用户按下 Esc 取消任务').then((result) => {
      if (result.state === 'not_found') terminal.notify(`未找到可取消的任务：${eventId}`);
    }).catch((error) => {
      terminal.notify(`取消任务失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const submitAndDisplay = async (input: string, signal = activeAbort?.signal) => {
    const renderer = new TerminalRenderer(
      terminal.createWriter(process.stderr),
      terminal.createWriter(process.stdout),
      normalizeOutputLevel(snapshot.outputLevel),
    );
    renderer.start(runLabel(input), input);
    let streamedAnswer = '';
    try {
      const accepted = await client.submit(input, target.currentSessionId);
      target.markSessionReady();
      snapshot.draft = false;
      activeEventId = accepted.eventId;
      if (activeCancelRequested) cancelActiveEvent();
      const event = await client.wait(accepted.eventId, signal, (streamed) => {
        if (streamed.kind === 'plan') {
          terminal.setTasks(streamed.steps);
          return;
        }
        if (streamed.kind === 'answer') streamedAnswer += streamed.text;
        renderer.handleDisplay(streamed);
      });
      const effects = eventEffects(event);
      const answer = eventAnswer(event);
      if (!streamedAnswer) renderer.handleDisplay({ kind: 'answer', text: answer });
      else if (answer.startsWith(streamedAnswer)) {
        const tail = answer.slice(streamedAnswer.length);
        if (tail) renderer.handleDisplay({ kind: 'answer', text: tail });
      }
      renderer.finish();
      await synchronizeRemoteRuntimeEffects(target, effects, { restoreSession, resetSession, close });
    } catch (error) {
      renderer.stop();
      throw error;
    }
  };
  const restoreSession = async () => {
    await refresh();
    terminal.clearScreen([renderBanner(version, snapshot, securityLabel), renderChatHistory(snapshot, tty)]
      .filter(Boolean).join('\n\n'));
  };
  const resetSession = async () => {
    await refresh();
    terminal.clearScreen(renderBanner(version, snapshot, securityLabel));
  };
  const commands = new CommandHandler(target, submitAndDisplay, {
    write: (text) => terminal.notify(text),
    resetScreen: async () => {
      await resetSession();
    },
    restoreSession,
    selectSession: async (sessions) => terminal.select(sessions.map((session) => ({
      value: session.id,
      label: `${session.id === target.currentSessionId ? '● ' : ''}${session.title}`,
      detail: `${session.recoverable ? '↻ 可恢复 · ' : ''}${session.turns} 轮 · ${session.preview}`,
    })), '选择 MimiAgent 对话'),
    selectModel: async (models, current) => terminal.select(models.map((model) => ({
      value: model,
      label: `${model === current ? '● ' : ''}${model}`,
    })), '选择模型'),
    selectMode: async (modes, current) => terminal.select(modes.map((mode) => ({
      value: mode.id,
      label: `${mode.id === current ? '● ' : ''}${mode.label}`,
      detail: mode.description,
    })), '选择模式'),
    getOutputLevel: () => normalizeOutputLevel(snapshot.outputLevel),
    setOutputLevel: async (level) => {
      await target.setOutputLevel(level);
      snapshot.outputLevel = level;
    },
    selectOutputLevel: async (current) => terminal.select(OUTPUT_LEVELS.map((level) => ({
      value: level.id,
      label: `${level.id === current ? '● ' : ''}${level.label}`,
      detail: level.description,
    })), '选择输出等级'),
  });
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && !closed) {
        const input = queue.shift()!;
        terminal.setQueue(queue);
        terminal.recordInput(input);
        activeAbort = new AbortController();
        activeEventId = undefined;
        activeCancelRequested = false;
        activeCancelSent = false;
        try {
          terminal.setBusy(true);
          const result = await commands.execute(input, activeAbort.signal);
          if (result === 'exit') {
            close();
            break;
          }
          if (result === 'handled') continue;
          commands.remember(input);
          await submitAndDisplay(input);
        } catch (error) {
          const message = activeCancelRequested
            ? '已请求取消当前任务。'
            : activeAbort.signal.aborted
              ? '已停止等待；任务仍由 MimiAgent 在后台可靠执行，可稍后用 /history 查看结果。'
              : `运行失败：${error instanceof Error ? error.message : String(error)}`;
          terminal.notify(message);
        } finally {
          activeAbort = undefined;
          activeEventId = undefined;
          activeCancelRequested = false;
          activeCancelSent = false;
          terminal.setBusy(false);
          if (!closed) await refresh().catch(() => undefined);
        }
      }
    } finally {
      draining = false;
      if (queue.length && !closed) void drain();
    }
  };

  await refresh();
  process.stdout.write(`${renderBanner(version, snapshot, securityLabel)}\n`);
  const history = renderChatHistory(snapshot, tty);
  if (history) process.stdout.write(`\n${history}\n`);
  terminal.start({
    onLine: (input) => {
      if (input.trim() === '/exit') {
        close();
        return;
      }
      queue.push(input);
      terminal.setQueue(queue);
      void drain();
    },
    onEscape: () => {
      if (!activeAbort || activeAbort.signal.aborted) return;
      activeCancelRequested = true;
      cancelActiveEvent();
      activeAbort.abort(new Error('用户按下 Esc 取消任务'));
    },
    onModeCycle: () => {
      if (cyclingMode) return;
      cyclingMode = true;
      void (async () => {
        try {
          const modes = await target.availableModes();
          const current = modes.findIndex((mode) => mode.label === snapshot.mode);
          const next = modes[(current + 1) % modes.length];
          if (!next) return;
          await target.switchMode(next.id);
          await refresh();
          terminal.notify(`已切换到 ${next.label} 模式。`);
        } catch (error) {
          terminal.notify(`切换模式失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          cyclingMode = false;
        }
      })();
    },
    onExit: close,
  });
  await closedPromise;
}
