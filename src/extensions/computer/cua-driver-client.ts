import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type {
  BackendActionResult,
  BackendActionRequest,
  BackendObservation,
  BackendObserveRequest,
  BackendSession,
  ComputerActInput,
  ComputerBackend,
  ComputerObserveInput,
  ComputerTargetSummary,
} from './types.js';

const execFileAsync = promisify(execFile);
const contentSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  data: z.string().optional(),
  mimeType: z.string().optional(),
}).passthrough();
const envelopeSchema = z.object({
  content: z.array(contentSchema).default([]),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
}).passthrough();

interface DriverResult {
  structured: unknown;
  image?: { data: string; mediaType: string };
}

function rawDriverResult(value: unknown): DriverResult {
  const structured = record(value);
  const screenshot = typeof structured.screenshot_png_b64 === 'string'
    ? { data: structured.screenshot_png_b64, mediaType: typeof structured.screenshot_mime_type === 'string' ? structured.screenshot_mime_type : 'image/png' }
    : undefined;
  if (screenshot) {
    delete structured.screenshot_png_b64;
    delete structured.screenshot_mime_type;
  }
  return { structured, ...(screenshot ? { image: screenshot } : {}) };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function imageDimensions(data: string): { width: number; height: number } | undefined {
  try {
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length >= 24 && bytes.subarray(1, 4).toString('ascii') === 'PNG') {
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      if (width > 0 && height > 0) return { width, height };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function toolForAction(input: ComputerActInput): { name: string; arguments: Record<string, unknown> } {
  const action = input.action;
  switch (action.type) {
    case 'launch_app': return { name: 'launch_app', arguments: { bundle_id: action.bundleId, name: action.name, urls: action.urls, creates_new_application_instance: action.newInstance } };
    case 'click': return { name: 'click', arguments: { element_index: 'elementIndex' in action ? action.elementIndex : undefined, x: 'x' in action ? action.x : undefined, y: 'y' in action ? action.y : undefined, button: action.button, action: 'axAction' in action ? action.axAction : undefined, delivery_mode: action.dispatch } };
    case 'double_click': return { name: 'double_click', arguments: { element_index: action.elementIndex, x: action.x, y: action.y, delivery_mode: action.dispatch } };
    case 'type_text': return { name: 'type_text', arguments: { element_index: action.elementIndex, text: action.text, delivery_mode: action.dispatch } };
    case 'set_value': return { name: 'set_value', arguments: { element_index: action.elementIndex, value: String(action.value) } };
    case 'keypress': return action.keys.length === 1
      ? { name: 'press_key', arguments: { key: action.keys[0], delivery_mode: action.dispatch } }
      : { name: 'hotkey', arguments: { keys: action.keys, delivery_mode: action.dispatch } };
    case 'scroll': {
      const vertical = Math.abs(action.deltaY) >= Math.abs(action.deltaX);
      const delta = vertical ? action.deltaY : action.deltaX;
      const direction = vertical ? (delta >= 0 ? 'down' : 'up') : (delta >= 0 ? 'right' : 'left');
      return { name: 'scroll', arguments: { x: action.x, y: action.y, direction, amount: Math.max(1, Math.ceil(Math.abs(delta) / 100)), by: 'line', delivery_mode: action.dispatch } };
    }
    case 'drag': return { name: 'drag', arguments: { from_x: action.path[0]?.x, from_y: action.path[0]?.y, to_x: action.path.at(-1)?.x, to_y: action.path.at(-1)?.y, delivery_mode: action.dispatch } };
    case 'escalate_session': return { name: 'escalate_session', arguments: { reason: action.reason, detail: action.detail } };
    case 'bring_to_front': return { name: 'bring_to_front', arguments: { pid: action.pid, window_id: action.windowId } };
    case 'handoff_to_user': return { name: 'bring_to_front', arguments: { pid: action.pid, window_id: action.windowId } };
    case 'release_foreground': return { name: 'release_foreground', arguments: {} };
    case 'move_cursor': return { name: 'move_cursor', arguments: { scope: action.scope, x: action.x, y: action.y } };
    case 'kill_app': return { name: 'kill_app', arguments: { pid: action.pid, reason: action.reason } };
    case 'start_recording': return { name: 'start_recording', arguments: { record_video: action.recordVideo } };
    case 'stop_recording': return { name: 'stop_recording', arguments: {} };
    case 'replay_trajectory': return { name: 'replay_trajectory', arguments: { trajectory_id: action.trajectoryId, manifest_sha256: action.manifestSha256, delay_ms: action.delayMs, stop_on_error: action.stopOnError } };
    case 'set_driver_config': return { name: 'set_config', arguments: action.values };
    case 'set_agent_cursor': return { name: 'set_agent_cursor_style', arguments: { enabled: action.enabled, ...action.style } };
    case 'request_permissions': return { name: 'check_permissions', arguments: { prompt: true, permissions: action.permissions } };
    case 'wait': return { name: 'wait', arguments: { milliseconds: action.milliseconds } };
  }
}

export class CuaDriverClient implements ComputerBackend {
  readonly kind = 'cua' as const;
  private versionPromise?: Promise<string>;

  constructor(
    private readonly command: string,
    private readonly timeoutMs: number,
  ) {}

  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const [version, health] = await Promise.all([
      this.ensureCompatibleVersion(signal),
      this.call('health_report', {}, signal),
    ]);
    return { version, ...record(health.structured) };
  }

  async diagnostics(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const [health, permissions] = await Promise.all([
      this.health(signal),
      this.call('check_permissions', { prompt: false }, signal),
    ]);
    return { health, permissions: permissions.structured };
  }

  async startSession(input: { sessionId: string; captureScope: 'auto' }, signal?: AbortSignal): Promise<BackendSession> {
    await this.call('start_session', { session: input.sessionId, capture_scope: input.captureScope }, signal);
    return { id: input.sessionId };
  }

  async listTargets(query: { query?: string; limit: number }, signal?: AbortSignal): Promise<ComputerTargetSummary[]> {
    const [appsResult, windowsResult] = await Promise.all([
      this.call('list_apps', {}, signal),
      this.call('list_windows', { on_screen_only: false }, signal),
    ]);
    const apps = Array.isArray(appsResult.structured) ? appsResult.structured : record(appsResult.structured).apps;
    const windows = Array.isArray(windowsResult.structured) ? windowsResult.structured : record(windowsResult.structured).windows;
    const appByPid = new Map<number, Record<string, unknown>>();
    if (Array.isArray(apps)) for (const value of apps) {
      const app = record(value);
      const pid = finite(app.pid);
      if (pid > 0) appByPid.set(pid, app);
    }
    const normalized = (Array.isArray(windows) ? windows : []).map((value): ComputerTargetSummary => {
      const window = record(value);
      const pid = finite(window.pid);
      const app = appByPid.get(pid) ?? {};
      const bounds = record(window.bounds);
      return {
        bundleId: String(app.bundle_id ?? window.bundle_id ?? ''),
        pid,
        windowId: finite(window.window_id),
        appName: String(window.app_name ?? app.name ?? ''),
        title: String(window.title ?? ''),
        bounds: { x: finite(bounds.x), y: finite(bounds.y), width: finite(bounds.width), height: finite(bounds.height) },
        frontmost: app.active === true,
      };
    }).filter((target) => target.pid > 0 && target.windowId > 0 && target.bundleId);
    const needle = query.query?.toLowerCase();
    return normalized.filter((target) => !needle || `${target.bundleId} ${target.appName} ${target.title}`.toLowerCase().includes(needle)).slice(0, query.limit);
  }

  async observe(session: BackendSession, request: BackendObserveRequest, signal?: AbortSignal): Promise<BackendObservation> {
    const input = request.input;
    if (input.scope === 'targets') return { data: await this.listTargets(input, signal) };
    if (input.scope === 'driver') {
      const data: Record<string, unknown> = {};
      for (const item of input.include) {
        const mapping = { health: 'health_report', permissions: 'check_permissions', config: 'get_config', recording: 'get_recording_state' } as const;
        data[item] = (await this.call(mapping[item], item === 'permissions' ? { prompt: false } : {}, signal)).structured;
      }
      return { data };
    }
    if (input.scope === 'session') {
      return { data: (await this.call('get_session_state', { session: session.id }, signal)).structured };
    }
    if (input.scope === 'desktop') {
      const result = await this.call('get_desktop_state', { session: session.id }, signal);
      return this.observation(result);
    }
    if (input.scope === 'region') {
      if (!request.target) throw new Error('zoom 缺少绑定的窗口目标');
      const result = await this.call('zoom', {
        session: session.id, pid: request.target.pid, window_id: request.target.windowId,
        x1: input.rect.x, y1: input.rect.y, x2: input.rect.x + input.rect.width, y2: input.rect.y + input.rect.height,
      }, signal);
      return this.observation(result);
    }
    const targets = await this.listTargets({ query: input.target.bundleId, limit: 50 }, signal);
    const matches = targets.filter((target) => (input.target.bundleId === undefined || target.bundleId === input.target.bundleId)
      && (input.target.pid === undefined || target.pid === input.target.pid)
      && (input.target.windowId === undefined || target.windowId === input.target.windowId));
    if (matches.length !== 1) return { data: { status: matches.length ? 'ambiguous_target' : 'target_not_found', candidates: matches } };
    const target = matches[0]!;
    const result = await this.call('get_window_state', {
      session: session.id, pid: target.pid, window_id: target.windowId, query: input.query,
      include_screenshot: input.includeScreenshot, max_elements: input.maxElements, max_depth: input.maxDepth,
    }, signal);
    return { ...this.observation(result), target, frontmost: target.frontmost };
  }

  async act(session: BackendSession, request: BackendActionRequest, signal?: AbortSignal): Promise<BackendActionResult> {
    if (request.input.action.type === 'set_agent_cursor') {
      let applied = false;
      try {
        if (request.input.action.enabled !== undefined) {
          await this.call('set_agent_cursor_enabled', {
            session: session.id, cursor_id: session.id, enabled: request.input.action.enabled,
          }, signal, true);
          applied = true;
        }
        if (request.input.action.style) {
          const style = request.input.action.style;
          await this.call('set_agent_cursor_motion', {
            session: session.id,
            cursor_id: session.id,
            cursor_color: style.color,
            cursor_label: style.label,
            cursor_icon: style.icon,
            cursor_size: style.size,
            cursor_opacity: style.opacity,
          }, signal, true);
        }
        return { status: 'applied', delivery: 'background' };
      } catch (error) {
        if (applied) {
          const uncertain = new Error('Agent cursor 配置部分完成，结果不确定；不会自动重试', { cause: error });
          uncertain.name = 'ComputerActionUncertainError';
          throw uncertain;
        }
        throw error;
      }
    }
    const selected = toolForAction(request.input);
    if (request.input.action.type === 'start_recording') {
      if (!request.artifactPath) throw new Error('start_recording 缺少受保护的 artifact 路径');
      selected.arguments.output_dir = request.artifactPath;
    }
    if (request.input.action.type === 'replay_trajectory') {
      if (!request.artifactPath) throw new Error('replay_trajectory 缺少已封存的 artifact 路径');
      selected.arguments.dir = request.artifactPath;
      delete selected.arguments.trajectory_id;
      delete selected.arguments.manifest_sha256;
    }
    const result = await this.call(selected.name, {
      ...selected.arguments,
      session: session.id,
      pid: request.target?.pid,
      window_id: request.target?.windowId,
      from_zoom: request.fromZoom || undefined,
    }, signal, true);
    const structured = record(result.structured);
    const status = String(structured.status ?? structured.code ?? 'applied');
    if (/uncertain|partial/i.test(status)) return { status: 'uncertain' };
    if (/background.*(unsupported|unavailable|occluded)/i.test(status)) return { status: 'background_unsupported', data: structured };
    const foregroundControl = ['escalate_session', 'bring_to_front', 'handoff_to_user', 'release_foreground']
      .includes(request.input.action.type);
    return {
      status: 'applied',
      delivery: String(structured.delivery_mode ?? structured.delivery) === 'foreground' || foregroundControl
        ? 'foreground'
        : 'background',
      data: structured,
    };
  }

  async endSession(session: BackendSession, signal?: AbortSignal): Promise<void> {
    await this.call('end_session', { session: session.id }, signal);
  }

  async close(): Promise<void> {}

  private observation(result: DriverResult): BackendObservation {
    const value = record(result.structured);
    const dimensions = record(value.dimensions ?? value.size);
    const screenshotDimensions = result.image ? imageDimensions(result.image.data) : undefined;
    const elements = Array.isArray(value.elements) ? value.elements.map((candidate) => {
      const item = record(candidate);
      const frame = record(item.frame);
      return {
        index: finite(item.element_index ?? item.index),
        role: String(item.role ?? ''),
        ...(item.label === undefined ? {} : { label: String(item.label) }),
        ...(Array.isArray(item.actions) ? { actions: item.actions.map(String) } : {}),
        ...(Object.keys(frame).length ? { frame: {
          x: finite(frame.x), y: finite(frame.y), width: finite(frame.width ?? frame.w), height: finite(frame.height ?? frame.h),
        } } : {}),
        secure: item.secure === true || /secure|password/i.test(String(item.role ?? '')),
        writable: item.writable === true || item.value_settable === true,
      };
    }) : undefined;
    return {
      dimensions: screenshotDimensions ?? (finite(dimensions.width) > 0 && finite(dimensions.height) > 0
        ? { width: finite(dimensions.width), height: finite(dimensions.height) }
        : undefined),
      elements,
      truncated: value.truncated === true,
      screenshot: result.image,
      data: value,
    };
  }

  private async call(name: string, argumentsValue: Record<string, unknown>, signal?: AbortSignal, action = false): Promise<DriverResult> {
    await this.ensureCompatibleVersion(signal);
    const argumentsJson = JSON.stringify(Object.fromEntries(Object.entries(argumentsValue).filter(([, value]) => value !== undefined)));
    try {
      const { stdout } = await execFileAsync(this.command, ['call', name, argumentsJson], {
        encoding: 'utf8', timeout: this.timeoutMs, maxBuffer: name.includes('state') || name === 'zoom' ? 16 * 1024 * 1024 : 1024 * 1024,
        signal,
      });
      const parsed = JSON.parse(stdout) as unknown;
      const envelopeCandidate = envelopeSchema.safeParse(parsed);
      if (!envelopeCandidate.success || !record(parsed).content) return rawDriverResult(parsed);
      const envelope = envelopeCandidate.data;
      const text = envelope.content.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n');
      if (envelope.isError) {
        if (action && /background.*(unsupported|unavailable|occluded)/i.test(text)) {
          return { structured: { status: 'background_unsupported', reason: text.slice(0, 1_000) } };
        }
        const rejected = new Error(`Cua Driver 拒绝 ${name}：${text.slice(0, 1_000)}`);
        rejected.name = 'CuaDriverRejectedError';
        throw rejected;
      }
      let structured = envelope.structuredContent;
      if (structured === undefined) {
        const candidate = text.replace(/^✅[^\n]*\n?/, '').trim();
        try { structured = candidate ? JSON.parse(candidate) : {}; } catch { structured = { summary: text.slice(0, 2_000) }; }
      }
      const image = envelope.content.find((item) => item.type === 'image' && item.data);
      return { structured, ...(image?.data ? { image: { data: image.data, mediaType: image.mimeType ?? 'image/png' } } : {}) };
    } catch (error) {
      if (action && (!(error instanceof Error) || error.name !== 'CuaDriverRejectedError')) {
        const uncertain = new Error('Cua Driver 动作结果通道失败，结果不确定；不会自动重试', { cause: error });
        uncertain.name = 'ComputerActionUncertainError';
        throw uncertain;
      }
      throw new Error(`Cua Driver ${name} 调用失败`, { cause: error });
    }
  }


  private ensureCompatibleVersion(signal?: AbortSignal): Promise<string> {
    if (this.versionPromise) return this.versionPromise;
    this.versionPromise = (async () => {
      const { stdout } = await execFileAsync(this.command, ['--version'], {
        encoding: 'utf8', timeout: this.timeoutMs, maxBuffer: 64 * 1024, signal,
      });
      const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
      if (!match) throw new Error('无法识别 Cua Driver 版本');
      const [major, minor, patch] = match.slice(1).map(Number);
      const compatible = major === 0 && ((minor === 8 && patch! >= 3) || (minor === 9 && patch === 0));
      if (!compatible) {
        throw new Error(`Cua Driver ${match[0]} 不在已测试兼容范围 >=0.8.3 <=0.9.0`);
      }
      return match[0];
    })();
    void this.versionPromise.catch(() => { this.versionPromise = undefined; });
    return this.versionPromise;
  }
}
