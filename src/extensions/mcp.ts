import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MCPServerStdio,
  MCPServerStreamableHttp,
  tool,
  type MCPServer,
  type MCPServerWithResources,
} from '@openai/agents';
import { z } from 'zod';

const common = {
  enabled: z.boolean().optional(),
  timeoutSeconds: z.number().positive().max(300).optional(),
};
const stdioSchema = z.object({
  ...common,
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
const httpSchema = z.object({
  ...common,
  type: z.enum(['http', 'streamable-http']).optional(),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});
const serverSchema = z.union([stdioSchema, httpSchema]);
export type MCPServerConfig = z.infer<typeof serverSchema>;

export interface MCPServerStatus {
  name: string;
  transport: 'stdio' | 'streamable-http';
  state: 'connected' | 'failed';
  tools: number;
  error?: string;
}

export interface MCPConfigParseResult {
  definitions: Record<string, MCPServerConfig>;
  invalid: MCPServerStatus[];
}

function expandEnvironment(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_, name: string) => process.env[name] ?? '');
}

export function parseMcpConfig(value: unknown): Record<string, MCPServerConfig> {
  const result = parseMcpConfigWithDiagnostics(value);
  if (result.invalid.length) throw new Error(result.invalid.map((item) => `${item.name}: ${item.error}`).join('; '));
  return result.definitions;
}

export function parseMcpConfigWithDiagnostics(value: unknown): MCPConfigParseResult {
  const root = z.object({
    servers: z.record(z.string(), z.unknown()).optional(),
    mcpServers: z.record(z.string(), z.unknown()).optional(),
  }).parse(value);
  const entries = { ...(root.servers ?? {}), ...(root.mcpServers ?? {}) };
  const definitions: Record<string, MCPServerConfig> = {};
  const invalid: MCPServerStatus[] = [];
  for (const [name, config] of Object.entries(entries)) {
    const parsed = serverSchema.safeParse(config);
    if (parsed.success) definitions[name] = parsed.data;
    else invalid.push({
      name,
      transport: typeof config === 'object' && config && 'url' in config ? 'streamable-http' : 'stdio',
      state: 'failed',
      tools: 0,
      error: `配置无效：${parsed.error.issues[0]?.message ?? 'unknown error'}`,
    });
  }
  return { definitions, invalid };
}

function hasResources(server: MCPServer): server is MCPServerWithResources {
  return 'listResources' in server && 'readResource' in server;
}

export class MCPManager {
  readonly servers: MCPServer[] = [];
  private statusList: MCPServerStatus[] = [];

  constructor(
    private readonly configFile: string,
    private readonly workspaceRoot: string,
  ) {}

  async connect(): Promise<string[]> {
    return this.replaceConnections(false);
  }

  async reload(): Promise<MCPServerStatus[]> {
    await this.replaceConnections(true);
    return this.statuses();
  }

  private async replaceConnections(preserveFailed: boolean): Promise<string[]> {
    const { definitions, invalid } = await this.load();
    const oldServers = [...this.servers];
    const oldByName = new Map(oldServers.map((server) => [server.name, server]));
    const oldStatus = new Map(this.statusList.map((status) => [status.name, status]));
    const results = await Promise.all(Object.entries(definitions).map(async ([name, config]) => {
      if (config.enabled === false) return undefined;
      const transport = 'url' in config ? 'streamable-http' : 'stdio';
      const server = this.createServer(name, config);
      try {
        await server.connect();
        const tools = await server.listTools();
        return {
          server,
          status: { name, transport, state: 'connected', tools: tools.length } satisfies MCPServerStatus,
        };
      } catch (error) {
        await server.close().catch(() => undefined);
        const previous = preserveFailed ? oldByName.get(name) : undefined;
        if (previous) return {
          server: previous,
          retained: true,
          status: {
            ...(oldStatus.get(name) ?? { name, transport, state: 'connected' as const, tools: 0 }),
            error: `重载失败，保留旧连接：${error instanceof Error ? error.message : String(error)}`,
          },
        };
        return { status: {
          name,
          transport,
          state: 'failed',
          tools: 0,
          error: error instanceof Error ? error.message : String(error),
        } satisfies MCPServerStatus };
      }
    }));
    const nextServers: MCPServer[] = [];
    const retained = new Set<string>();
    const statuses: MCPServerStatus[] = [];
    for (const status of invalid) {
      const previous = preserveFailed ? oldByName.get(status.name) : undefined;
      if (previous) {
        nextServers.push(previous);
        retained.add(previous.name);
        statuses.push({
          ...(oldStatus.get(status.name) ?? { ...status, state: 'connected' as const }),
          error: `配置无效，保留旧连接：${status.error}`,
        });
      } else statuses.push(status);
    }
    for (const result of results) {
      if (!result) continue;
      statuses.push(result.status);
      if (result.server) nextServers.push(result.server);
      if ('retained' in result && result.retained && result.server) retained.add(result.server.name);
    }
    await Promise.allSettled(oldServers
      .filter((server) => !retained.has(server.name))
      .map((server) => server.close()));
    this.servers.length = 0;
    this.servers.push(...nextServers);
    this.statusList = statuses;
    return this.statusList.filter((item) => item.state === 'connected').map((item) => item.name);
  }

  statuses(): MCPServerStatus[] {
    return this.statusList.map((status) => ({ ...status }));
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.servers.map((server) => server.close()));
    this.servers.length = 0;
  }

  createTools() {
    return [
      tool({
        name: 'list_mcp_resources',
        description: '列出已连接 MCP Server 暴露的 Resources。',
        parameters: z.object({ server: z.string().optional() }),
        execute: async ({ server }) => {
          const targets = server ? [this.getServer(server)] : this.servers;
          return Promise.all(targets.map(async (target) => ({
            server: target.name,
            resources: hasResources(target) ? await target.listResources() : { resources: [] },
          })));
        },
      }),
      tool({
        name: 'read_mcp_resource',
        description: '读取指定 MCP Server 的 Resource URI。',
        parameters: z.object({ server: z.string().min(1), uri: z.string().min(1) }),
        execute: async ({ server, uri }) => {
          const target = this.getServer(server);
          if (!hasResources(target)) throw new Error(`MCP Server ${server} 不支持 Resources`);
          return target.readResource(uri);
        },
      }),
    ];
  }

  private getServer(name: string): MCPServer {
    const server = this.servers.find((item) => item.name === name);
    if (!server) throw new Error(`MCP Server 未连接：${name}`);
    return server;
  }

  private createServer(name: string, config: MCPServerConfig): MCPServer {
    const timeout = (config.timeoutSeconds ?? 30) * 1_000;
    if ('url' in config) {
      return new MCPServerStreamableHttp({
        name,
        url: expandEnvironment(config.url),
        requestInit: config.headers
          ? { headers: Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, expandEnvironment(value)])) }
          : undefined,
        cacheToolsList: true,
        timeout,
        clientSessionTimeoutSeconds: config.timeoutSeconds ?? 30,
      });
    }
    return new MCPServerStdio({
      name,
      command: expandEnvironment(config.command),
      args: (config.args ?? []).map(expandEnvironment),
      cwd: path.resolve(this.workspaceRoot, config.cwd ?? '.'),
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        ...Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, expandEnvironment(value)])),
      },
      cacheToolsList: true,
      timeout,
      clientSessionTimeoutSeconds: config.timeoutSeconds ?? 30,
    });
  }

  private async load(): Promise<{ definitions: Record<string, MCPServerConfig>; invalid: MCPServerStatus[] }> {
    try {
      return parseMcpConfigWithDiagnostics(JSON.parse(await readFile(this.configFile, 'utf8')) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { definitions: {}, invalid: [] };
      throw new Error(`无法读取 MCP 配置 ${this.configFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
