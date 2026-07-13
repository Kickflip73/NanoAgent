import { readFile } from 'node:fs/promises';
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

  constructor(
    workspaceRoot: string,
    userFile = path.join(os.homedir(), '.nano-agent', 'NANO.md'),
    private readonly maxCharsPerFile = 20_000,
  ) {
    this.userFile = path.resolve(userFile);
    this.projectFile = path.resolve(workspaceRoot, 'NANO.md');
  }

  async load(): Promise<GuidanceSnapshot> {
    const [user, project] = await Promise.all([
      this.read('user', this.userFile),
      this.read('project', this.projectFile),
    ]);
    const files = [user, project].filter((file): file is GuidanceFile => Boolean(file));
    const sections = [
      '以下是 NanoAgent 持久指令。项目级指令优先于用户级指令；若两者冲突，必须遵循项目级指令。',
      project ? this.section(project) : '',
      user ? this.section(user) : '',
    ].filter(Boolean);
    return { files, instructions: files.length ? sections.join('\n\n') : '' };
  }

  private section(file: GuidanceFile): string {
    const label = file.scope === 'project' ? '项目级 NANO.md（高优先级）' : '用户级 NANO.md';
    return `## ${label}\n来源：${file.path}\n${file.content}${file.truncated ? '\n\n[内容已截断，请保持 NANO.md 简洁]' : ''}`;
  }

  private async read(scope: GuidanceFile['scope'], file: string): Promise<GuidanceFile | undefined> {
    try {
      const raw = await readFile(file, 'utf8');
      const content = raw.trim();
      if (!content) return undefined;
      const truncated = content.length > this.maxCharsPerFile;
      return {
        scope,
        path: file,
        content: truncated ? content.slice(0, this.maxCharsPerFile).trimEnd() : content,
        truncated,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(`无法读取 ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
