import { randomUUID } from 'node:crypto';
import { tool } from '@openai/agents';
import { z } from 'zod';
import { assertSessionId } from './session-id.js';
import { AtomicJsonStore } from './state-file.js';

export type TeamRole = 'explorer' | 'architect' | 'builder' | 'tester' | 'reviewer';
export type TeamTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface TeamTask {
  id: string;
  description: string;
  role: TeamRole;
  status: TeamTaskStatus;
  dependencies: string[];
  paths: string[];
  owner?: string;
  ownerPid?: number;
  claimId?: string;
  claimedAt?: string;
  leaseExpiresAt?: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
}

export type TeamTaskInput = Pick<TeamTask, 'id' | 'description' | 'role' | 'dependencies' | 'paths'>;
type StoredTeams = Record<string, TeamTask[]>;
const TEAM_LEASE_MS = 5 * 60_000;

const storedTeamsSchema = z.record(z.string(), z.array(z.object({
  id: z.string(),
  description: z.string(),
  role: z.enum(['explorer', 'architect', 'builder', 'tester', 'reviewer']),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  dependencies: z.array(z.string()),
  paths: z.array(z.string()),
  owner: z.string().optional(),
  ownerPid: z.number().int().positive().optional(),
  claimId: z.string().optional(),
  claimedAt: z.string().optional(),
  leaseExpiresAt: z.string().optional(),
  result: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})));

export class TeamTaskStore {
  private readonly state: AtomicJsonStore<StoredTeams>;

  constructor(file: string, private sessionId: string) {
    assertSessionId(sessionId);
    this.state = new AtomicJsonStore(file, {
      defaultValue: () => Object.create(null) as StoredTeams,
      decode: (value) => Object.assign(Object.create(null), storedTeamsSchema.parse(value)) as StoredTeams,
      recoverCorrupt: true,
    });
  }

  useSession(sessionId: string): void {
    assertSessionId(sessionId);
    this.sessionId = sessionId;
  }

  async set(inputs: TeamTaskInput[]): Promise<TeamTask[]> {
    const normalized = inputs.map((item) => ({
      ...item,
      id: item.id.trim(),
      description: item.description.trim(),
      dependencies: [...new Set(item.dependencies.map((value) => value.trim()).filter(Boolean))],
      paths: [...new Set(item.paths.map((value) => value.trim()).filter(Boolean))],
    }));
    this.validate(normalized);
    const sessionId = this.sessionId;
    return this.mutate((teams) => {
      if ((teams[sessionId] ?? []).some((task) => task.status === 'running')) {
        throw new Error('当前 Team 仍有 running task，不能替换 task list');
      }
      const now = new Date().toISOString();
      const tasks = normalized.map((item) => ({
        ...item,
        status: 'pending' as const,
        createdAt: now,
        updatedAt: now,
      }));
      teams[sessionId] = tasks;
      return tasks;
    });
  }

  async list(): Promise<TeamTask[]> {
    const sessionId = this.sessionId;
    return (await this.state.read())[sessionId] ?? [];
  }

  async ready(): Promise<TeamTask[]> {
    const tasks = await this.list();
    const completed = new Set(tasks.filter((task) => task.status === 'completed').map((task) => task.id));
    return tasks.filter((task) => task.status === 'pending' && task.dependencies.every((id) => completed.has(id)));
  }

  async claim(id: string, owner: string): Promise<TeamTask> {
    const [claimed] = await this.claimMany([{ id, owner }]);
    return claimed!;
  }

  async claimMany(claims: Array<{ id: string; owner: string }>): Promise<TeamTask[]> {
    if (!claims.length) throw new Error('至少需要领取一个 Team task');
    if (new Set(claims.map((claim) => claim.id)).size !== claims.length) {
      throw new Error('批量领取的 Team task id 不能重复');
    }
    const sessionId = this.sessionId;
    return this.mutate((teams) => {
      const tasks = teams[sessionId] ?? [];
      const completed = new Set(tasks.filter((item) => item.status === 'completed').map((item) => item.id));
      const selected = claims.map(({ id, owner }) => {
        const task = tasks.find((item) => item.id === id);
        if (!task) throw new Error(`Team task 不存在：${id}`);
        if (task.status !== 'pending') throw new Error(`Team task ${id} 当前为 ${task.status}，无法领取`);
        if (!owner.trim()) throw new Error(`Team task ${id} 的 owner 不能为空`);
        const blocked = task.dependencies.filter((dependency) => !completed.has(dependency));
        if (blocked.length) throw new Error(`Team task ${id} 尚有未完成依赖：${blocked.join(', ')}`);
        return { task, owner: owner.trim() };
      });
      const now = new Date();
      const leaseExpiresAt = new Date(now.getTime() + TEAM_LEASE_MS).toISOString();
      for (const { task, owner } of selected) {
        task.status = 'running';
        task.owner = owner;
        task.ownerPid = process.pid;
        task.claimId = randomUUID();
        task.claimedAt = now.toISOString();
        task.leaseExpiresAt = leaseExpiresAt;
        task.updatedAt = now.toISOString();
      }
      return selected.map(({ task }) => ({ ...task }));
    });
  }

  async renew(id: string, claimId: string, now = Date.now()): Promise<TeamTask> {
    const sessionId = this.sessionId;
    return this.mutate((teams) => {
      const task = (teams[sessionId] ?? []).find((item) => item.id === id);
      if (!task || task.status !== 'running' || task.claimId !== claimId) {
        throw new Error(`Team task ${id} 的领取凭证已失效`);
      }
      task.leaseExpiresAt = new Date(now + TEAM_LEASE_MS).toISOString();
      task.updatedAt = new Date(now).toISOString();
      return { ...task };
    });
  }

  async update(
    id: string,
    status: Exclude<TeamTaskStatus, 'pending'>,
    result?: string,
    expectedClaimId?: string,
  ): Promise<TeamTask> {
    const sessionId = this.sessionId;
    return this.mutate((teams) => {
      const task = (teams[sessionId] ?? []).find((item) => item.id === id);
      if (!task) throw new Error(`Team task 不存在：${id}`);
      if (task.status === 'completed' || task.status === 'failed') throw new Error(`Team task ${id} 已结束`);
      if (task.status !== 'running') throw new Error(`Team task ${id} 尚未领取`);
      if (expectedClaimId && task.claimId !== expectedClaimId) throw new Error(`Team task ${id} 的领取凭证已失效`);
      task.status = status;
      task.result = result?.trim().slice(0, 12_000) || task.result;
      if (status !== 'running') task.leaseExpiresAt = undefined;
      if (status !== 'running') task.ownerPid = undefined;
      task.updatedAt = new Date().toISOString();
      return { ...task };
    });
  }

  async retry(id: string): Promise<TeamTask> {
    const sessionId = this.sessionId;
    return this.mutate((teams) => {
      const task = (teams[sessionId] ?? []).find((item) => item.id === id);
      if (!task) throw new Error(`Team task 不存在：${id}`);
      if (task.status !== 'failed') throw new Error(`只有 failed Team task 可以重试：${id}`);
      task.status = 'pending';
      task.owner = undefined;
      task.ownerPid = undefined;
      task.claimId = undefined;
      task.claimedAt = undefined;
      task.leaseExpiresAt = undefined;
      task.result = undefined;
      task.updatedAt = new Date().toISOString();
      return { ...task };
    });
  }

  async summary(): Promise<string> {
    const tasks = await this.list();
    if (!tasks.length) return '';
    return tasks.map((task) => [
      `- [${task.status}] ${task.id} (${task.role}): ${task.description}`,
      task.dependencies.length ? `依赖=${task.dependencies.join(',')}` : '',
      task.paths.length ? `路径=${task.paths.join(',')}` : '',
      task.result ? `结果=${task.result.slice(0, 500)}` : '',
    ].filter(Boolean).join(' · ')).join('\n');
  }

  async clear(sessionId = this.sessionId): Promise<void> {
    assertSessionId(sessionId);
    await this.mutate((teams) => {
      delete teams[sessionId];
    });
  }

  async recoverExpired(sessionId = this.sessionId, now = Date.now()): Promise<TeamTask[]> {
    assertSessionId(sessionId);
    return this.mutate((teams) => {
      const recovered: TeamTask[] = [];
      for (const task of teams[sessionId] ?? []) {
        if (task.status !== 'running') continue;
        const expiresAt = task.leaseExpiresAt ? Date.parse(task.leaseExpiresAt) : 0;
        if (expiresAt > now) continue;
        if (task.ownerPid && this.processIsAlive(task.ownerPid)) continue;
        task.status = 'failed';
        task.result = task.result ?? 'Worker 运行中断或领取租约已过期，请显式重试';
        task.leaseExpiresAt = undefined;
        task.updatedAt = new Date(now).toISOString();
        recovered.push({ ...task });
      }
      return recovered;
    });
  }

  createTools() {
    const input = z.object({
      id: z.string().min(1).max(80),
      description: z.string().min(1).max(2_000),
      role: z.enum(['explorer', 'architect', 'builder', 'tester', 'reviewer']),
      dependencies: z.array(z.string().min(1).max(80)).max(10).default([]),
      paths: z.array(z.string().min(1).max(500)).max(30).default([]),
    });
    return [
      tool({
        name: 'set_team_tasks',
        description: '在 Ultra Team 模式创建 2～6 个有角色、依赖和路径边界的子任务；会替换当前 Team task list。',
        parameters: z.object({ tasks: z.array(input).min(2).max(6) }),
        execute: async ({ tasks }) => this.set(tasks),
      }),
      tool({
        name: 'show_team_tasks',
        description: '查看当前会话的 Team task list、依赖、负责人和结果。',
        parameters: z.object({}),
        execute: async () => ({ tasks: await this.list(), ready: (await this.ready()).map((item) => item.id) }),
      }),
      tool({
        name: 'claim_team_task',
        description: '原子领取一个依赖已完成的 pending Team task，避免重复执行。',
        parameters: z.object({ id: z.string().min(1), owner: z.string().min(1).max(100) }),
        execute: async ({ id, owner }) => this.claim(id, owner),
      }),
      tool({
        name: 'update_team_task',
        description: '使用领取时返回的 claimId 更新 Team task，防止迟到 worker 覆盖新领取。',
        parameters: z.object({
          id: z.string().min(1),
          claimId: z.string().min(1),
          status: z.enum(['running', 'completed', 'failed']),
          result: z.string().max(12_000).optional(),
        }),
        execute: async ({ id, claimId, status, result }) => this.update(id, status, result, claimId),
      }),
      tool({
        name: 'retry_team_task',
        description: '把一个 failed Team task 重置为 pending，供修正方案后重新执行；completed task 不会被重复运行。',
        parameters: z.object({ id: z.string().min(1) }),
        execute: async ({ id }) => this.retry(id),
      }),
    ];
  }

  private validate(inputs: TeamTaskInput[]): void {
    if (inputs.length < 2 || inputs.length > 6) throw new Error('Team task 数量必须为 2～6 个');
    const ids = inputs.map((item) => item.id.trim());
    if (new Set(ids).size !== ids.length) throw new Error('Team task id 必须唯一');
    const known = new Set(ids);
    for (const item of inputs) {
      if (!item.id.trim() || !item.description.trim()) throw new Error('Team task id 和 description 不能为空');
      if (item.dependencies.includes(item.id)) throw new Error(`Team task ${item.id} 不能依赖自己`);
      const missing = item.dependencies.filter((id) => !known.has(id));
      if (missing.length) throw new Error(`Team task ${item.id} 引用了不存在的依赖：${missing.join(', ')}`);
    }
    const graph = new Map(inputs.map((item) => [item.id, item.dependencies]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Team task 存在循环依赖：${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of graph.get(id) ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of ids) visit(id);

    const dependsOn = (taskId: string, target: string, seen = new Set<string>()): boolean => {
      if (seen.has(taskId)) return false;
      seen.add(taskId);
      return (graph.get(taskId) ?? []).some((dependency) => dependency === target || dependsOn(dependency, target, seen));
    };
    for (const builder of inputs.filter((item) => item.role === 'builder')) {
      for (const role of ['tester', 'reviewer'] as const) {
        if (!inputs.some((item) => item.role === role && dependsOn(item.id, builder.id))) {
          throw new Error(`builder task ${builder.id} 必须有依赖其结果的 ${role} 验证任务`);
        }
      }
    }
  }

  private processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private mutate<T>(mutation: (teams: StoredTeams) => T): Promise<T> {
    return this.state.update(mutation);
  }

}
