import { spawn } from 'node:child_process';
import type { OutboxMessage } from './types.js';

export interface NotificationSink {
  deliver(message: OutboxMessage): Promise<void>;
}

export class UncertainDeliveryError extends Error {
  override readonly name = 'UncertainDeliveryError';
}

export function isUncertainDeliveryError(error: unknown): error is UncertainDeliveryError {
  return error instanceof UncertainDeliveryError;
}

function messageText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).text === 'string') {
    return String((payload as Record<string, unknown>).text);
  }
  return JSON.stringify(payload);
}

const SYSTEM_NOTIFICATION_TIMEOUT_MS = 10_000;

export async function runNotificationCommand(
  command: string,
  args: string[],
  timeoutMs = SYSTEM_NOTIFICATION_TIMEOUT_MS,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const settle = (operation: () => void) => {
      clearTimeout(timer);
      operation();
    };
    child.once('error', (error) => settle(() => reject(error)));
    child.once('exit', (code) => settle(() => {
      if (timedOut) reject(new UncertainDeliveryError(`${command} 通知命令执行超时`));
      else if (code === 0) resolve();
      else reject(new Error(`${command} 退出码 ${code}`));
    }));
  });
}

export function systemNotificationArgs(text: string): string[] {
  const script = 'on run argv\ndisplay notification (item 1 of argv) with title "MimiAgent"\nend run';
  return ['-e', script, '--', text];
}

class SystemNotificationSink implements NotificationSink {
  async deliver(message: OutboxMessage): Promise<void> {
    const text = messageText(message.payload).slice(0, 1_000);
    if (process.platform === 'darwin') {
      // Without `--`, a notification body beginning with `-` is parsed as an osascript option.
      await runNotificationCommand('/usr/bin/osascript', systemNotificationArgs(text));
      return;
    }
    process.stdout.write(`[MimiAgent] ${text}\n`);
  }
}

class ConsoleNotificationSink implements NotificationSink {
  async deliver(message: OutboxMessage): Promise<void> {
    process.stdout.write(`[MimiAgent:${message.channel}${message.target ? `:${message.target}` : ''}] ${messageText(message.payload)}\n`);
  }
}

export class NotifierRegistry {
  private readonly sinks = new Map<string, NotificationSink>();

  constructor() {
    this.sinks.set('system', new SystemNotificationSink());
    this.sinks.set('local', new ConsoleNotificationSink());
  }

  register(channel: string, sink: NotificationSink): void {
    this.sinks.set(channel, sink);
  }

  unregister(channel: string, sink: NotificationSink): void {
    if (this.sinks.get(channel) === sink) this.sinks.delete(channel);
  }

  async deliver(message: OutboxMessage): Promise<void> {
    const sink = this.sinks.get(message.channel);
    if (!sink) throw new Error(`未配置通知通道：${message.channel}`);
    await sink.deliver(message);
  }
}
