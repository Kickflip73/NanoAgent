import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { withExclusiveFileLock } from '../../core/state-file.js';
import type {
  BackendObservation,
  BackendSession,
  ComputerAccess,
  ComputerActInput,
  ComputerBackend,
  ComputerConfig,
  ComputerElement,
  ComputerObserveInput,
  ComputerTargetSummary,
} from './types.js';
import { ComputerActionUncertainError } from './types.js';
import { ComputerArtifactStore } from './artifact-store.js';

const ACCESS_LEVEL: Record<ComputerAccess, number> = {
  none: 0, observe: 1, background: 2, foreground: 3, admin: 4,
};
const OBSERVATION_TTL_MS = 30_000;

export interface ComputerRunAuthority {
  runId: string;
  access: ComputerAccess;
  allowedApps?: readonly string[];
  supportsImageInput?: boolean;
}

interface StoredObservation extends BackendObservation {
  id: string;
  runId: string;
  capturedAt: number;
  expiresAt: number;
  valid: boolean;
}

interface RunState {
  session?: BackendSession;
  observations: Map<string, StoredObservation>;
  actions: number;
  screenshots: number;
  foregroundRestore?: {
    target: ComputerTargetSummary;
    timer: ReturnType<typeof setTimeout>;
  };
  activeArtifactId?: string;
}

function requiresAccess(input: ComputerObserveInput | ComputerActInput): ComputerAccess {
  if ('scope' in input) return input.scope === 'desktop' ? 'foreground' : 'observe';
  const action = input.action;
  if (action.type === 'move_cursor') return action.scope === 'desktop' ? 'foreground' : 'background';
  if (['kill_app', 'start_recording', 'stop_recording', 'replay_trajectory', 'set_driver_config', 'set_agent_cursor', 'request_permissions'].includes(action.type)) return 'admin';
  if (['escalate_session', 'bring_to_front', 'handoff_to_user', 'release_foreground'].includes(action.type)) return 'foreground';
  if ('dispatch' in action && action.dispatch === 'foreground') return 'foreground';
  return 'background';
}

function hasAccess(actual: ComputerAccess, required: ComputerAccess): boolean {
  return ACCESS_LEVEL[actual] >= ACCESS_LEVEL[required];
}

function actionCoordinates(action: ComputerActInput['action']): Array<{ x: number; y: number }> {
  if (action.type === 'click' && action.x !== undefined && action.y !== undefined) return [{ x: action.x, y: action.y }];
  if (action.type === 'double_click' && action.x !== undefined && action.y !== undefined) return [{ x: action.x, y: action.y }];
  if (action.type === 'scroll' && action.x !== undefined && action.y !== undefined) return [{ x: action.x, y: action.y }];
  if (action.type === 'drag') return action.path;
  return [];
}

function actionElement(action: ComputerActInput['action'], observation: StoredObservation): ComputerElement | undefined {
  if (!('elementIndex' in action) || action.elementIndex === undefined) return undefined;
  const element = observation.elements?.find((candidate) => candidate.index === action.elementIndex);
  if (!element) throw new Error(`Observation 中不存在 elementIndex ${action.elementIndex}`);
  if (action.type === 'type_text' && element.secure) throw new Error('拒绝向 secure/password field 输入文本');
  if (action.type === 'set_value' && element.writable !== true) throw new Error('目标元素未声明 value 可写');
  return element;
}

export class ComputerManager {
  private readonly runs = new Map<string, RunState>();
  private actionQueue: Promise<void> = Promise.resolve();
  private readonly artifacts: ComputerArtifactStore;

  constructor(
    private readonly config: ComputerConfig,
    private readonly backend: ComputerBackend,
    private readonly dataRoot: string,
  ) {
    this.artifacts = new ComputerArtifactStore(
      path.join(dataRoot, 'computer-artifacts'),
      config.artifactMaxBytes,
    );
  }

  async observe(authority: ComputerRunAuthority, input: ComputerObserveInput, signal?: AbortSignal) {
    this.authorize(authority, requiresAccess(input));
    if ((('includeScreenshot' in input && input.includeScreenshot) || input.scope === 'region')
      && authority.supportsImageInput === false) {
      throw new Error('vision_unavailable：当前模型未声明图像输入能力');
    }
    if (input.scope === 'targets') return { targets: await this.backend.listTargets(input, signal) };
    const run = await this.run(authority.runId, signal);
    if (((input.scope === 'window' || input.scope === 'desktop') && input.includeScreenshot) || input.scope === 'region') {
      if (run.screenshots >= this.config.maxScreenshotsPerRun) throw new Error(`当前 Run 已达到 ${this.config.maxScreenshotsPerRun} 张截图上限`);
      run.screenshots += 1;
    }
    let parent: StoredObservation | undefined;
    if (input.scope === 'region') {
      parent = this.freshObservation(run, authority.runId, input.observationId);
      if (!parent.target || !parent.dimensions) throw new Error('region 只能引用带窗口尺寸的有效 Observation');
      this.assertRect(input.rect.x, input.rect.y, input.rect.width, input.rect.height, parent.dimensions);
    }
    const result = await this.backend.observe(run.session!, { input, target: parent?.target }, signal);
    if (input.scope === 'window' && result.target && !result.dimensions) {
      const { width, height } = result.target.bounds;
      if (width > 0 && height > 0) result.dimensions = { width, height };
    }
    if (parent) {
      result.target = parent.target;
      result.frontmost = parent.frontmost;
      result.fromZoom = true;
    }
    if (input.scope === 'driver' || input.scope === 'session') return result.data ?? {};
    if (result.target) this.authorizeApp(authority, result.target.bundleId);
    if (result.data && !result.target && !result.screenshot && !result.elements) return result.data;
    const now = Date.now();
    const observation: StoredObservation = {
      ...result,
      id: randomUUID(),
      runId: authority.runId,
      capturedAt: now,
      expiresAt: now + OBSERVATION_TTL_MS,
      valid: true,
    };
    if (observation.target) {
      for (const previous of run.observations.values()) {
        if (previous.target?.pid === observation.target.pid && previous.target.windowId === observation.target.windowId) previous.valid = false;
      }
    }
    run.observations.set(observation.id, observation);
    return {
      observationId: observation.id,
      capturedAt: new Date(observation.capturedAt).toISOString(),
      expiresAt: new Date(observation.expiresAt).toISOString(),
      target: observation.target,
      frontmost: observation.frontmost,
      dimensions: observation.dimensions,
      elements: observation.elements,
      truncated: observation.truncated ?? false,
      data: observation.data,
      screenshot: observation.screenshot,
    };
  }

  async act(authority: ComputerRunAuthority, input: ComputerActInput, signal?: AbortSignal) {
    const requiredAccess = requiresAccess(input);
    this.authorize(authority, requiredAccess);
    if (input.action.type === 'set_driver_config') {
      const entries = Object.entries(input.action.values);
      if (entries.length !== 1 || entries[0]?.[0] !== 'max_image_dimension'
        || !Number.isSafeInteger(entries[0][1]) || Number(entries[0][1]) < 0 || Number(entries[0][1]) > 4_096) {
        throw new Error('set_driver_config 第一阶段只允许 max_image_dimension=0..4096 的安全整数');
      }
    }
    const run = await this.run(authority.runId, signal);
    if (run.actions >= this.config.maxActionsPerRun) throw new Error(`当前 Run 已达到 ${this.config.maxActionsPerRun} 个写动作上限`);
    let observation: StoredObservation | undefined;
    let target: ComputerTargetSummary | undefined;
    let element: ComputerElement | undefined;
    let backendInput = input;
    let foregroundRestoreTarget: ComputerTargetSummary | undefined;
    let artifactId: string | undefined;
    let artifactPath: string | undefined;
    if (input.action.type === 'start_recording') {
      if (run.activeArtifactId) throw new Error('当前 Run 已有活跃录制');
      const pending = await this.artifacts.create(authority.runId);
      artifactId = pending.artifactId;
      artifactPath = pending.directory;
    } else if (input.action.type === 'stop_recording') {
      if (!run.activeArtifactId) throw new Error('当前 Run 没有活跃录制');
      artifactId = run.activeArtifactId;
    } else if (input.action.type === 'replay_trajectory') {
      const replay = await this.artifacts.openReplay(input.action.trajectoryId, input.action.manifestSha256);
      artifactId = replay.manifest.artifactId;
      artifactPath = replay.directory;
    }
    if ('observationId' in input) {
      observation = this.freshObservation(run, authority.runId, input.observationId);
      target = observation.target;
      if (!target || !observation.dimensions) throw new Error('UI 动作必须引用带精确窗口目标和尺寸的 Observation');
      this.authorizeApp(authority, target.bundleId);
      if (this.config.pauseWhenTargetFrontmost && requiredAccess === 'background' && observation.frontmost) {
        throw new Error('target_in_use：目标应用当前处于前台，暂停后台动作');
      }
      for (const point of actionCoordinates(input.action)) this.assertPoint(point.x, point.y, observation.dimensions);
      element = actionElement(input.action, observation);
    } else if (input.action.type === 'launch_app' && input.action.bundleId) {
      this.authorizeApp(authority, input.action.bundleId);
    } else if (input.action.type === 'launch_app') {
      throw new Error('launch_app 必须使用经过发现的精确 bundleId，不能仅按名称启动');
    } else if (input.action.type === 'bring_to_front' || input.action.type === 'handoff_to_user' || input.action.type === 'kill_app') {
      const controlAction = input.action;
      const targets = await this.backend.listTargets({ limit: 50 }, signal);
      target = targets.find((candidate) => candidate.pid === controlAction.pid
        && (controlAction.type === 'kill_app' || controlAction.windowId === undefined || candidate.windowId === controlAction.windowId));
      if (!target) throw new Error('target_not_found：无法把 pid 解析为精确应用窗口');
      this.authorizeApp(authority, target.bundleId);
      if (input.action.type === 'bring_to_front') {
        if (run.foregroundRestore) throw new Error('当前 Run 已持有 foreground lease，请先释放');
        foregroundRestoreTarget = targets.find((candidate) => candidate.frontmost && candidate.pid !== target!.pid);
        if (!foregroundRestoreTarget) throw new Error('无法确定可恢复的原前台窗口，拒绝获取 foreground lease');
      }
    } else if (input.action.type === 'release_foreground') {
      if (!run.foregroundRestore) return {
        status: 'applied', delivery: 'foreground', requiredAccess, verified: true, requiresObservation: false,
      };
      const restore = run.foregroundRestore.target;
      backendInput = { action: { type: 'bring_to_front', pid: restore.pid, windowId: restore.windowId } };
      target = restore;
    }
    run.actions += 1;
    if (observation) observation.valid = false;
    const execute = async () => withExclusiveFileLock(
      path.join(this.dataRoot, 'computer-action'),
      async () => {
        if (target) {
          const freshTargets = await this.backend.listTargets({ query: target.bundleId, limit: 50 }, signal);
          const fresh = freshTargets.find((candidate) => candidate.bundleId === target.bundleId
            && candidate.pid === target.pid && candidate.windowId === target.windowId);
          if (!fresh) throw new Error('stale_observation：目标窗口身份已变化，请重新观察');
          if (this.config.pauseWhenTargetFrontmost && requiredAccess === 'background' && fresh.frontmost) {
            throw new Error('target_in_use：目标应用当前处于前台，暂停后台动作');
          }
        }
        if (input.action.type === 'drag' && input.action.path.length !== 2) {
          throw new Error('当前 Cua Driver 版本的 drag 只支持起点和终点两个路径点');
        }
        const applied = await this.backend.act(run.session!, {
          input: backendInput, target, element, fromZoom: observation?.fromZoom, artifactPath,
        }, signal);
        if (target && requiredAccess === 'background') {
          const after = await this.backend.listTargets({ query: target.bundleId, limit: 50 }, signal);
          const fresh = after.find((candidate) => candidate.pid === target.pid && candidate.windowId === target.windowId);
          if (fresh?.frontmost) throw new ComputerActionUncertainError('foreground_violation：后台动作后目标应用意外成为前台，停止后续动作');
        }
        return applied;
      },
      signal,
    );
    const result = await this.enqueueAction(execute);
    let artifactResult: Record<string, unknown> = {};
    if (input.action.type === 'start_recording' && artifactId) {
      run.activeArtifactId = artifactId;
      artifactResult = { artifactId };
    } else if (input.action.type === 'stop_recording' && artifactId) {
      const manifest = await this.artifacts.seal(artifactId, authority.runId).catch((error) => {
        throw new ComputerActionUncertainError(`录制已停止但 artifact 封存失败：${error instanceof Error ? error.message : String(error)}`);
      });
      delete run.activeArtifactId;
      artifactResult = {
        trajectoryId: manifest.artifactId,
        manifestSha256: manifest.manifestSha256,
        actionCount: manifest.actionCount,
      };
    } else if (input.action.type === 'replay_trajectory' && artifactId) {
      artifactResult = { trajectoryId: artifactId };
    }
    if (input.action.type === 'bring_to_front' && foregroundRestoreTarget) {
      const seconds = input.action.leaseSeconds ?? this.config.foregroundLeaseSeconds;
      const timer = setTimeout(() => void this.restoreForeground(authority.runId), seconds * 1_000);
      timer.unref?.();
      run.foregroundRestore = { target: foregroundRestoreTarget, timer };
    } else if (input.action.type === 'handoff_to_user' && run.foregroundRestore) {
      clearTimeout(run.foregroundRestore.timer);
      delete run.foregroundRestore;
    } else if (input.action.type === 'release_foreground' && run.foregroundRestore) {
      clearTimeout(run.foregroundRestore.timer);
      delete run.foregroundRestore;
    }
    if (result.status === 'uncertain') throw new ComputerActionUncertainError();
    if (result.status === 'background_unsupported') return {
      status: 'background_unsupported', requiredAccess, requiresObservation: true, target,
    };
    return {
      status: 'applied',
      delivery: result.delivery ?? (requiredAccess === 'background' ? 'background' : 'foreground'),
      requiredAccess,
      verified: false,
      requiresObservation: true,
      ...(input.action.type === 'handoff_to_user' ? { foregroundDisposition: 'retained_for_user' } : {}),
      target,
      ...artifactResult,
    };
  }

  async endRun(runId: string): Promise<void> {
    const state = this.runs.get(runId);
    await this.restoreForeground(runId);
    this.runs.delete(runId);
    if (state?.session) await this.backend.endSession(state.session).catch(() => undefined);
    if (state?.activeArtifactId) await this.artifacts.seal(state.activeArtifactId, runId).catch(() => undefined);
  }

  async close(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((runId) => this.endRun(runId)));
    await this.backend.close();
  }

  status() {
    return {
      configured: true,
      backend: this.backend.kind,
      strategy: 'background-preferred',
      defaultAccess: this.config.defaultAccess,
      activeSessions: [...this.runs.values()].filter((state) => state.session).length,
      foregroundLeaseActive: [...this.runs.values()].some((state) => state.foregroundRestore),
    };
  }

  private async run(runId: string, signal?: AbortSignal): Promise<RunState> {
    let state = this.runs.get(runId);
    if (!state) {
      state = { observations: new Map(), actions: 0, screenshots: 0 };
      this.runs.set(runId, state);
    }
    if (!state.session) state.session = await this.backend.startSession({ sessionId: `mimi-${randomUUID()}`, captureScope: 'auto' }, signal);
    return state;
  }

  private freshObservation(state: RunState, runId: string, id: string): StoredObservation {
    const observation = state.observations.get(id);
    if (!observation || observation.runId !== runId || !observation.valid || observation.expiresAt <= Date.now()) {
      throw new Error('stale_observation：请重新观察目标窗口');
    }
    return observation;
  }

  private authorize(authority: ComputerRunAuthority, required: ComputerAccess): void {
    if (!hasAccess(authority.access, required)) throw new Error(`approval_required：Computer 动作需要 ${required}，当前授权为 ${authority.access}`);
  }

  private authorizeApp(authority: ComputerRunAuthority, bundleId: string): void {
    if (authority.allowedApps !== undefined && !authority.allowedApps.includes(bundleId)) {
      throw new Error(`应用 ${bundleId} 不在当前 Run 的 computerApps allowlist`);
    }
  }

  private assertPoint(x: number, y: number, dimensions: { width: number; height: number }): void {
    if (x < 0 || y < 0 || x >= dimensions.width || y >= dimensions.height) throw new Error('坐标超出 Observation 窗口边界');
  }

  private assertRect(x: number, y: number, width: number, height: number, dimensions: { width: number; height: number }): void {
    if (x < 0 || y < 0 || x + width > dimensions.width || y + height > dimensions.height) throw new Error('region 超出 Observation 窗口边界');
  }

  private enqueueAction<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.actionQueue.then(operation, operation);
    this.actionQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async restoreForeground(runId: string): Promise<void> {
    const state = this.runs.get(runId);
    const restore = state?.foregroundRestore;
    if (!state?.session || !restore) return;
    clearTimeout(restore.timer);
    delete state.foregroundRestore;
    await this.enqueueAction(() => withExclusiveFileLock(
      path.join(this.dataRoot, 'computer-action'),
      () => this.backend.act(state.session!, {
        input: { action: { type: 'bring_to_front', pid: restore.target.pid, windowId: restore.target.windowId } },
        target: restore.target,
      }),
    )).catch(() => undefined);
  }
}
