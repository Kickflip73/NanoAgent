import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface GuidanceFile {
  scope: 'user' | 'project';
  path: string;
  content: string;
  truncated: boolean;
}

export interface GuidanceSnapshot {
  files: GuidanceFile[];
  instructions: string;
}

export class GuidanceLoader {
  readonly userFile: string;
  readonly projectFile: string;
  private readonly userFiles: readonly string[];
  private readonly projectFiles: readonly string[];

  constructor(
    workspaceRoot: string,
    userFile?: string,
    private readonly maxCharsPerFile = 20_000,
  ) {
    const workspace = path.resolve(workspaceRoot);
    this.userFiles = userFile
      ? [path.resolve(userFile)]
      : [path.join(os.homedir(), '.mimi-agent', 'MIMI.md')];
    this.projectFiles = [path.join(workspace, 'MIMI.md')];
    this.userFile = this.userFiles[0]!;
    this.projectFile = this.projectFiles[0]!;
  }

  async load(): Promise<GuidanceSnapshot> {
    const [user, project] = await Promise.all([
      this.readFirst('user', this.userFiles),
      this.readFirst('project', this.projectFiles),
    ]);
    const files = [user, project].filter((file): file is GuidanceFile => Boolean(file));
    const sections = [
      '以下是 MimiAgent 持久指令。项目级指令优先于用户级指令；若两者冲突，必须遵循项目级指令。',
      project ? this.section(project) : '',
      user ? this.section(user) : '',
    ].filter(Boolean);
    return { files, instructions: files.length ? sections.join('\n\n') : '' };
  }

  private section(file: GuidanceFile): string {
    const name = path.basename(file.path);
    const label = file.scope === 'project' ? `项目级 ${name}（高优先级）` : `用户级 ${name}`;
    return `## ${label}\n来源：${file.path}\n${file.content}${file.truncated ? `\n\n[内容已截断，请保持 ${name} 简洁]` : ''}`;
  }

  private async readFirst(
    scope: GuidanceFile['scope'],
    files: readonly string[],
  ): Promise<GuidanceFile | undefined> {
    for (const file of files) {
      const guidance = await this.read(scope, file);
      if (guidance) return guidance;
    }
    return undefined;
  }

  private async read(scope: GuidanceFile['scope'], file: string): Promise<GuidanceFile | undefined> {
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
      const maxBytes = this.maxCharsPerFile * 4;
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('持久指令必须是常规文件');
      const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const raw = buffer.subarray(0, bytesRead).toString('utf8');
      const content = raw.trim();
      if (!content) return undefined;
      const truncated = info.size > bytesRead || content.length > this.maxCharsPerFile;
      return {
        scope,
        path: file,
        content: truncated ? content.slice(0, this.maxCharsPerFile).trimEnd() : content,
        truncated,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(`无法读取 ${file}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await handle?.close();
    }
  }
}
