import type { AppConfig } from '../config.js';
import type { MimiSchedulePage } from './types.js';

export function daemonHelp(): string {
  return `MimiAgent 后台维护（正常使用只需运行 mimi）：
  mimi daemon status                      查看状态
  mimi daemon doctor                      检查本机就绪度与下一步
  mimi daemon activity [数量]              查看积压、失败与近期活动
  mimi daemon events [数量]                查看不可变事件时间线
  mimi daemon tasks [数量]                 查看任务队列与执行状态
  mimi daemon runs [数量]                  查看执行尝试
  mimi daemon outbox [数量]                查看待投递与投递历史
  mimi daemon show <类型> <id>             查看 event/task/run/outbox/schedule 完整详情
  mimi daemon retry task <id>              重新排队 dead-letter Task
  mimi daemon retry outbox <id>            重新投递失败消息（可能重复）
  mimi daemon archive outbox <id>          归档失败投递
  mimi daemon connectors [reload]          查看或重载 Connector 在线状态和可执行能力
  mimi daemon attention [reload]           查看或重载注意力策略
  mimi daemon digest [数量]                 查看待简报摘要
  mimi daemon brief                        立即生成主动简报
  mimi daemon schedule list                查看计划任务
  mimi daemon schedule at <ISO时间> "任务" 创建一次任务
  mimi daemon schedule every <10m|1h> "任务" 创建周期任务
  mimi daemon schedule remove <id>         删除计划任务`;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function durationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value);
  if (!match) throw new Error('周期格式应为 30s、10m、1h 或 1d');
  const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  const duration = Number(match[1]) * units[match[2] as keyof typeof units];
  if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error('周期必须是正安全整数');
  return duration;
}

export async function runDaemonCommand(config: AppConfig, args: string[]): Promise<void> {
  const command = args[0] ?? 'status';
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${daemonHelp()}\n`);
    return;
  }
  const [{ mimiRpc }, { mimiPaths }] = await Promise.all([
    import('./ipc.js'),
    import('./client-runtime.js'),
  ]);
  const socket = mimiPaths(config).socket;
  if (command === 'run') {
    const { runMimiDaemon } = await import('./service.js');
    process.stdout.write(`MimiAgent 前台运行中，控制端点：${socket}\n`);
    await runMimiDaemon(config);
    return;
  }
  if (command === 'init') {
    const { initializeMimi } = await import('./service.js');
    output(await initializeMimi(config));
    return;
  }
  if (command === 'doctor') {
    const { doctorMimi } = await import('./service.js');
    output(await doctorMimi(config));
    return;
  }
  if (command === 'start') {
    const { startMimiDaemon } = await import('./service.js');
    output(await startMimiDaemon(config));
    return;
  }
  if (command === 'stop') {
    const { stopMimiDaemon } = await import('./service.js');
    await stopMimiDaemon(config);
    process.stdout.write('MimiAgent 已收到停止请求。\n');
    return;
  }
  if (command === 'install') {
    const { installMimiLaunchAgent } = await import('./service.js');
    process.stdout.write(`MimiAgent launchd 服务已安装：${await installMimiLaunchAgent(config)}\n`);
    return;
  }
  if (command === 'uninstall') {
    const { uninstallMimiLaunchAgent } = await import('./service.js');
    process.stdout.write(`MimiAgent launchd 服务已卸载：${await uninstallMimiLaunchAgent()}\n`);
    return;
  }
  if (command === 'status') {
    output(await mimiRpc(socket, 'status'));
    return;
  }
  if (command === 'activity') {
    output(await mimiRpc(socket, 'activity.get', { limit: Number(args[1] ?? 10) }));
    return;
  }
  if (command === 'submit') {
    const wait = args.includes('--wait');
    const text = args.slice(1).filter((arg) => arg !== '--wait').join(' ').trim();
    if (!text) throw new Error('请提供要提交的任务');
    const submitted = await mimiRpc<{ event: { id: string }; task?: { id: string }; inserted: boolean }>(socket, 'submit', { text });
    if (!wait) {
      output(submitted);
      return;
    }
    if (!submitted.task) throw new Error('MimiAgent 没有为命令创建 Task');
    const { waitForRemoteTask } = await import('./service.js');
    output(await waitForRemoteTask(config, submitted.task.id));
    return;
  }
  if (command === 'events') {
    output(await mimiRpc(socket, 'events.list', { limit: Number(args[1] ?? 20) }));
    return;
  }
  if (command === 'tasks') {
    output(await mimiRpc(socket, 'tasks.list', { limit: Number(args[1] ?? 20) }));
    return;
  }
  if (command === 'runs') {
    output(await mimiRpc(socket, 'runs.list', { limit: Number(args[1] ?? 20) }));
    return;
  }
  if (command === 'outbox') {
    output(await mimiRpc(socket, 'outbox.list', { limit: Number(args[1] ?? 20) }));
    return;
  }
  if (command === 'show') {
    const entity = args[1];
    const methods = {
      event: 'event.get',
      task: 'tasks.get',
      run: 'run.get',
      outbox: 'outbox.get',
      schedule: 'schedule.get',
    } as const;
    if (!entity || !Object.hasOwn(methods, entity)) {
      throw new Error('show 仅支持 event、task、run、outbox 或 schedule');
    }
    const id = args[2]?.trim();
    if (!id) throw new Error(`请提供要查看的 ${entity} id`);
    const detail = await mimiRpc(socket, methods[entity as keyof typeof methods], { id });
    if (detail === undefined) throw new Error(`${entity} ${id} 不存在`);
    output(detail);
    return;
  }
  if (command === 'retry' || command === 'archive') {
    const entity = args[1];
    const supported = command === 'retry' ? ['task', 'outbox'] : ['outbox'];
    if (!entity || !supported.includes(entity)) throw new Error(`${command} 仅支持 ${supported.join(' 或 ')}`);
    const id = args[2]?.trim();
    if (!id) throw new Error(`请提供要${command === 'retry' ? '重试' : '归档'}的 ${entity} id`);
    output(await mimiRpc(socket, `${entity}.${command}`, { id }));
    return;
  }
  if (command === 'connectors') {
    output(await mimiRpc(
      socket,
      args[1] === 'reload' ? 'connectors.reload' : 'connectors.list',
      {},
      args[1] === 'reload' ? 15_000 : 5_000,
    ));
    return;
  }
  if (command === 'attention') {
    output(await mimiRpc(socket, args[1] === 'reload' ? 'attention.reload' : 'attention.status'));
    return;
  }
  if (command === 'digest') {
    output(await mimiRpc(socket, 'digest.list', { limit: Number(args[1] ?? 50) }));
    return;
  }
  if (command === 'brief') {
    output(await mimiRpc(socket, 'attention.brief'));
    return;
  }
  if (command === 'schedule') {
    const operation = args[1] ?? 'list';
    if (operation === 'list') {
      const schedules: MimiSchedulePage['items'] = [];
      let offset = 0;
      let revision: string | undefined;
      let total: number | undefined;
      while (true) {
        const page = await mimiRpc<MimiSchedulePage>(socket, 'schedules.page', {
          offset, limit: 200, revision,
        });
        if (!Number.isSafeInteger(page.total) || page.total < 0 || (total !== undefined && page.total !== total)) {
          throw new Error('MimiAgent 返回了无效的计划任务总数');
        }
        if (revision && page.revision !== revision) {
          throw new Error('计划任务在读取期间发生变化，请重试 mimi daemon schedule list');
        }
        revision = page.revision;
        total = page.total;
        schedules.push(...page.items);
        const expectedOffset = offset + page.items.length;
        if (page.nextOffset === undefined) {
          if (expectedOffset !== page.total) throw new Error('MimiAgent 计划任务分页提前结束');
          break;
        }
        if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset !== expectedOffset || page.nextOffset > page.total) {
          throw new Error('MimiAgent 返回了无效的计划任务分页游标');
        }
        offset = page.nextOffset;
      }
      output(schedules);
      return;
    }
    if (operation === 'remove') {
      output({ removed: await mimiRpc(socket, 'schedules.remove', { id: args[2] }) });
      return;
    }
    if (operation === 'at') {
      const at = args[2];
      const prompt = args.slice(3).join(' ').trim();
      output(await mimiRpc(socket, 'schedules.add', {
        name: prompt.slice(0, 80), type: 'at', value: at, prompt, nextRunAt: at, trust: 'owner',
      }));
      return;
    }
    if (operation === 'every') {
      const duration = durationMs(args[2] ?? '');
      const prompt = args.slice(3).join(' ').trim();
      output(await mimiRpc(socket, 'schedules.add', {
        name: prompt.slice(0, 80), type: 'interval', value: String(duration), prompt,
        nextRunAt: new Date(Date.now() + duration).toISOString(), trust: 'owner',
      }));
      return;
    }
  }
  throw new Error(`未知 MimiAgent 命令：${args.join(' ')}\n\n${daemonHelp()}`);
}
