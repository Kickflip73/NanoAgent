import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MCPServerStdio, type MCPServer } from '@openai/agents';

interface MCPServerConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled?: boolean;
  timeoutSeconds?: number;
}

interface MCPConfig {
  servers?: Record<string, MCPServerConfig>;
}

export class MCPManager {
  readonly servers: MCPServer[] = [];

  constructor(
    private readonly configFile: string,
    private readonly workspaceRoot: string,
  ) {}

  async connect(): Promise<string[]> {
    const config = await this.load();
    const connected: string[] = [];
    for (const [name, serverConfig] of Object.entries(config.servers ?? {})) {
      if (serverConfig.enabled === false) continue;
      const server = new MCPServerStdio({
        name,
        command: serverConfig.command,
        args: serverConfig.args ?? [],
        cwd: path.resolve(this.workspaceRoot, serverConfig.cwd ?? '.'),
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
          ...serverConfig.env,
        },
        cacheToolsList: true,
        timeout: (serverConfig.timeoutSeconds ?? 30) * 1_000,
        clientSessionTimeoutSeconds: serverConfig.timeoutSeconds ?? 30,
      });
      await server.connect();
      this.servers.push(server);
      connected.push(name);
    }
    return connected;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.servers.map((server) => server.close()));
    this.servers.length = 0;
  }

  private async load(): Promise<MCPConfig> {
    try {
      return JSON.parse(await readFile(this.configFile, 'utf8')) as MCPConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error(`无法读取 MCP 配置 ${this.configFile}: ${(error as Error).message}`);
    }
  }
}
