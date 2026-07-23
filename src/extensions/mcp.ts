import { readFile, realpath } from 'node:fs/promises';
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
  allowedEnv: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/i)).max(50).optional(),
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

export type McpEnvironmentResolver = (name: string) => string | undefined;

export function expandMcpEnvironment(
  value: string,
  allowedEnv: readonly string[] = [],
  resolveEnvironment: McpEnvironmentResolver = (name) => process.env[name],
): string {
  const allowed = new Set(allowedEnv);
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_, name: string) => {
    if (!allowed.has(name)) throw new Error(`MCP 环境变量 ${name} 未在 allowedEnv 中显式授权`);
    return resolveEnvironment(name) ?? '';
  });
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

async function isWorkspaceConfig(configFile: string, workspaceRoot: string): Promise<boolean> {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(configFile);
  const lexical = path.relative(root, target);
  if (lexical === '' || (!lexical.startsWith('..') && !path.isAbsolute(lexical))) return true;
  try {
    const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(target)]);
    const relative = path.relative(canonicalRoot, canonicalTarget);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

export async function isMcpConfigurationTrusted(
  configFile: string,
  workspaceRoot: string,
  trustedWorkspaceMcp?: string,
): Promise<boolean> {
  if (!await isWorkspaceConfig(configFile, workspaceRoot)) return true;
  return trustedWorkspaceMcp !== undefined
    && await canonicalPath(trustedWorkspaceMcp) === await canonicalPath(workspaceRoot);
}

export async function collectTrustedMcpEnvironment(
  configFile: string,
  workspaceRoot: string,
  trustedWorkspaceMcp: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  if (!await isMcpConfigurationTrusted(configFile, workspaceRoot, trustedWorkspaceMcp)) return {};
  let raw: string;
  try {
    raw = await readFile(configFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const { definitions } = parseMcpConfigWithDiagnostics(JSON.parse(raw) as unknown);
  const names = new Set(Object.values(definitions)
    .filter((definition) => definition.enabled !== false)
    .flatMap((definition) => definition.allowedEnv ?? []));
  if (names.size > 50) throw new Error('MCP allowedEnv 合计不能超过 50 项');
  const entries: Array<[string, string]> = [];
  let totalBytes = 0;
  for (const name of names) {
    const value = environment[name];
    if (value === undefined) continue;
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > 16_384) throw new Error(`MCP 环境变量 ${name} 超过 16384 字节`);
    totalBytes += bytes;
    if (totalBytes > 65_536) throw new Error('MCP allowedEnv 环境值合计不能超过 65536 字节');
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

function safeProcessEnvironment(): Record<string, string> {
  const names = process.platform === 'win32'
    ? ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE']
    : ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL'];
  return Object.fromEntries(names
    .map((name) => [name, process.env[name]])
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
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
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(
    private readonly configFile: string,
    private readonly workspaceRoot: string,
    private readonly options: {
      enabled?: boolean;
      disabledReason?: string;
      allowStdio?: boolean;
      resolveEnvironment?: McpEnvironmentResolver;
      redactError?: (message: string) => string;
    } = {},
  ) {
    if (options.enabled === false) {
      this.statusList = [{
        name: 'workspace-mcp',
        transport: 'stdio',
        state: 'failed',
        tools: 0,
        error: options.disabledReason ?? 'MCP 配置未被信任，未连接',
      }];
    }
  }

  async connect(): Promise<string[]> {
    return this.serialized(() => this.replaceConnections(false));
  }

  async reload(): Promise<MCPServerStatus[]> {
    return this.serialized(async () => {
      await this.replaceConnections(true);
      return this.statuses();
    });
  }

  private async replaceConnections(preserveFailed: boolean): Promise<string[]> {
    if (this.options.enabled === false) return [];
    const { definitions, invalid } = await this.load();
    const oldServers = [...this.servers];
    const oldByName = new Map(oldServers.map((server) => [server.name, server]));
    const oldStatus = new Map(this.statusList.map((status) => [status.name, status]));
    const results = await Promise.all(Object.entries(definitions).map(async ([name, config]) => {
      if (config.enabled === false) return undefined;
      const transport = 'url' in config ? 'streamable-http' : 'stdio';
      if (transport === 'stdio' && this.options.allowStdio === false) {
        return { status: {
          name,
          transport,
          state: 'failed',
          tools: 0,
          error: 'stdio MCP 配置未被本机授权执行',
        } satisfies MCPServerStatus };
      }
      let server: MCPServer | undefined;
      try {
        server = this.createServer(name, config);
        await server.connect();
        const tools = await server.listTools();
        return {
          server,
          status: { name, transport, state: 'connected', tools: tools.length } satisfies MCPServerStatus,
        };
      } catch (error) {
        await server?.close().catch(() => undefined);
        const previous = preserveFailed ? oldByName.get(name) : undefined;
        if (previous) return {
          server: previous,
          retained: true,
          status: {
            ...(oldStatus.get(name) ?? { name, transport, state: 'connected' as const, tools: 0 }),
            error: `重载失败，保留旧连接：${this.errorMessage(error)}`,
          },
        };
        return { status: {
          name,
          transport,
          state: 'failed',
          tools: 0,
          error: this.errorMessage(error),
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
      .map(async (server) => {
        try {
          await server.invalidateToolsCache();
        } finally {
          await server.close();
        }
      }));
    this.servers.length = 0;
    this.servers.push(...nextServers);
    this.statusList = statuses;
    return this.statusList.filter((item) => item.state === 'connected').map((item) => item.name);
  }

  statuses(): MCPServerStatus[] {
    return this.statusList.map((status) => ({ ...status }));
  }

  async close(): Promise<void> {
    await this.serialized(async () => {
      await Promise.allSettled(this.servers.map((server) => server.close()));
      this.servers.length = 0;
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.then(() => undefined, () => undefined);
    return result;
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
    const allowedEnv = config.allowedEnv ?? [];
    const expand = (value: string) => expandMcpEnvironment(
      value,
      allowedEnv,
      this.options.resolveEnvironment,
    );
    if ('url' in config) {
      return new MCPServerStreamableHttp({
        name,
        url: expand(config.url),
        requestInit: config.headers
          ? { headers: Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, expand(value)])) }
          : undefined,
        cacheToolsList: true,
        timeout,
        clientSessionTimeoutSeconds: config.timeoutSeconds ?? 30,
      });
    }
    return new MCPServerStdio({
      name,
      command: expand(config.command),
      args: (config.args ?? []).map(expand),
      cwd: path.resolve(this.workspaceRoot, config.cwd ?? '.'),
      env: {
        ...safeProcessEnvironment(),
        ...Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, expand(value)])),
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

  private errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return this.options.redactError?.(message) ?? message;
  }
}
