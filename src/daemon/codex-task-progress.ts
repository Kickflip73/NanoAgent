import { open } from 'node:fs/promises';

const MAX_LOG_TAIL_BYTES = 1024 * 1024;
const MAX_PROGRESS_EVENTS = 12;
const MAX_SUMMARY_CHARS = 1_000;

export interface CodexProgressEvent {
  type: string;
  itemType?: string;
  status?: string;
  summary?: string;
}

export interface CodexTaskProgress {
  logBytes: number;
  logUpdatedAt: string;
  recentEvents: CodexProgressEvent[];
  latestActivity?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function compact(value: unknown, maxChars = MAX_SUMMARY_CHARS): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function itemSummary(item: Record<string, unknown>): string | undefined {
  const itemType = typeof item.type === 'string' ? item.type : undefined;
  if (itemType === 'agent_message') return compact(item.text);
  if (itemType === 'error') return compact(item.message);
  if (itemType === 'command_execution') {
    const command = compact(item.command, 600);
    const exitCode = typeof item.exit_code === 'number' ? `exit=${item.exit_code}` : undefined;
    return [command, exitCode].filter(Boolean).join(' · ') || undefined;
  }
  if (itemType === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes.slice(0, 20).map((change) => {
      const entry = record(change);
      const file = compact(entry?.path, 300);
      const kind = compact(entry?.kind, 40);
      return [kind, file].filter(Boolean).join(' ');
    }).filter(Boolean);
    return paths.length ? paths.join(', ') : undefined;
  }
  if (itemType === 'todo_list') {
    const items = Array.isArray(item.items) ? item.items : [];
    const todos = items.slice(0, 20).map((todo) => {
      const entry = record(todo);
      const text = compact(entry?.text, 300);
      return text ? `${entry?.completed === true ? '✓' : '○'} ${text}` : undefined;
    }).filter(Boolean);
    return todos.length ? todos.join(' | ') : undefined;
  }
  return compact(item.text ?? item.message ?? item.query ?? item.name);
}

function progressEvent(value: unknown): CodexProgressEvent | undefined {
  const event = record(value);
  if (!event || typeof event.type !== 'string') return undefined;
  const item = record(event.item);
  const itemType = item && typeof item.type === 'string' ? item.type : undefined;
  const status = item && typeof item.status === 'string'
    ? item.status
    : typeof event.status === 'string' ? event.status : undefined;
  return {
    type: event.type,
    ...(itemType ? { itemType } : {}),
    ...(status ? { status } : {}),
    ...(item ? { summary: itemSummary(item) } : {}),
  };
}

function activity(event: CodexProgressEvent): string | undefined {
  if (event.summary) return [event.itemType ?? event.type, event.status, event.summary]
    .filter(Boolean).join(' · ');
  if (event.type === 'turn.started') return 'Codex 开始新一轮执行';
  if (event.type === 'turn.completed') return 'Codex 本轮执行完成';
  if (event.type === 'turn.failed') return 'Codex 本轮执行失败';
  if (event.type === 'thread.started') return 'Codex 线程已启动';
  return undefined;
}

export async function readCodexTaskProgress(
  outputJsonlPath: string,
): Promise<CodexTaskProgress | undefined> {
  let file;
  try {
    file = await open(outputJsonlPath, 'r');
    const stats = await file.stat();
    const length = Math.min(stats.size, MAX_LOG_TAIL_BYTES);
    const offset = Math.max(0, stats.size - length);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, offset);
    let text = buffer.toString('utf8');
    if (offset > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    const recentEvents = text.split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = progressEvent(JSON.parse(line));
          return parsed ? [parsed] : [];
        } catch {
          return [];
        }
      })
      .slice(-MAX_PROGRESS_EVENTS);
    const latestActivity = [...recentEvents].reverse()
      .map(activity)
      .find((candidate): candidate is string => Boolean(candidate));
    return {
      logBytes: stats.size,
      logUpdatedAt: stats.mtime.toISOString(),
      recentEvents,
      ...(latestActivity ? { latestActivity } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await file?.close().catch(() => undefined);
  }
}
