import { constants } from 'node:fs';
import { access, open, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface GuidanceFile {
  scope: 'soul' | 'project';
  path: string;
  content: string;
  truncated: boolean;
}

export interface GuidanceSnapshot {
  files: GuidanceFile[];
  instructions: string;
}

async function readGuidance(file: string, scope: GuidanceFile['scope'], maxChars: number): Promise<GuidanceFile | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('指令文件必须是常规文件');
    const buffer = Buffer.alloc(Math.min(info.size, maxChars * 4));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (!content) return undefined;
    const truncated = info.size > bytesRead || content.length > maxChars;
    return { scope, path: file, content: truncated ? content.slice(0, maxChars).trimEnd() : content, truncated };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`无法读取 ${file}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await handle?.close();
  }
}

export class SoulLoader {
  readonly userFile: string;

  constructor(
    userFile = path.join(os.homedir(), '.mimi-agent', 'MIMI.md'),
    private readonly packagedFile?: string,
    private readonly maxChars = 20_000,
  ) {
    this.userFile = path.resolve(userFile);
  }

  async load(): Promise<GuidanceSnapshot> {
    const user = await readGuidance(this.userFile, 'soul', this.maxChars);
    const packaged = !user && this.packagedFile
      ? await readGuidance(path.resolve(this.packagedFile), 'soul', this.maxChars)
      : undefined;
    const file = user ?? packaged;
    return {
      files: file ? [file] : [],
      instructions: file ? `## MimiAgent Soul（身份与人格；不授予权限）\n来源：${file.path}\n${file.content}` : '',
    };
  }
}

export class ProjectGuidanceLoader {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string, private readonly maxChars = 20_000) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  async load(currentDirectory = this.workspaceRoot): Promise<GuidanceSnapshot> {
    const current = path.resolve(currentDirectory);
    const relative = path.relative(this.workspaceRoot, current);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Project Guidance 目录必须位于 workspace 内');
    const directories = [this.workspaceRoot];
    let cursor = this.workspaceRoot;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      directories.push(cursor);
    }
    const files: GuidanceFile[] = [];
    for (const directory of directories) {
      const agents = await readGuidance(path.join(directory, 'AGENTS.md'), 'project', this.maxChars);
      const claude = await readGuidance(path.join(directory, 'CLAUDE.md'), 'project', this.maxChars);
      if (claude) files.push(claude);
      if (agents) files.push(agents);
    }
    return {
      files,
      instructions: files.length ? [
        '## Project Guidance（项目开发合约；不授予 Runtime 权限）',
        '同目录 AGENTS.md 优先于 CLAUDE.md；更深目录只在其作用域内具体化上层约束。',
        ...files.map((file) => `### ${file.path}\n${file.content}${file.truncated ? '\n[内容已截断]' : ''}`),
      ].join('\n\n') : '',
    };
  }

  async ensureMinimal(summary: { mission?: string; stack?: string; commands?: string[] } = {}): Promise<string> {
    const existing = await this.load();
    if (existing.files.length) return existing.files[0]!.path;
    await access(this.workspaceRoot, constants.W_OK);
    const detected = await this.detectProject();
    const file = path.join(this.workspaceRoot, 'AGENTS.md');
    const content = [
      '# Project Agent Guide',
      '',
      `## Mission\n\n${summary.mission ?? detected.mission}`,
      `\n## Stack\n\n${summary.stack ?? detected.stack}`,
      `\n## Core directories\n\n${detected.directories.map((directory) => `- \`${directory}/\``).join('\n') || '- Inspect the workspace before changing files.'}`,
      `\n## Verification\n\n${(summary.commands ?? detected.commands).map((command) => `- \`${command}\``).join('\n') || '- Run the narrowest relevant checks.'}`,
      '\n## Working rules\n\n- Make small, verifiable changes and preserve unrelated work.\n- Do not commit secrets or generated runtime data.',
    ].filter(Boolean).join('\n');
    await writeFile(file, `${content}\n`, { flag: 'wx', mode: 0o644 });
    return file;
  }

  async loadForDevelopment(): Promise<GuidanceSnapshot> {
    const existing = await this.load();
    if (existing.files.length) return existing;
    const detected = await this.detectProject();
    return {
      files: [],
      instructions: [
        '## Project Guidance（本轮只读扫描，未持久化；不授予 Runtime 权限）',
        `Mission: ${detected.mission}`,
        `Stack: ${detected.stack}`,
        detected.directories.length ? `Core directories: ${detected.directories.join(', ')}` : '',
        detected.commands.length ? `Verification: ${detected.commands.join(', ')}` : '',
      ].filter(Boolean).join('\n'),
    };
  }

  private async detectProject(): Promise<{ mission: string; stack: string; commands: string[]; directories: string[] }> {
    const entries = await readdir(this.workspaceRoot, { withFileTypes: true });
    const names = new Set(entries.map((entry) => entry.name));
    const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name).slice(0, 12);
    let mission = `Maintain ${path.basename(this.workspaceRoot)} with small, verifiable changes.`;
    let stack = 'Inspect project manifests before choosing tools or commands.';
    let commands: string[] = [];
    if (names.has('package.json')) {
      try {
        const manifest = JSON.parse(await readFile(path.join(this.workspaceRoot, 'package.json'), 'utf8')) as {
          name?: string; description?: string; scripts?: Record<string, string>;
        };
        mission = manifest.description?.trim() || `Maintain the ${manifest.name ?? path.basename(this.workspaceRoot)} project.`;
        stack = 'Node.js / TypeScript or JavaScript; follow package.json and the existing module conventions.';
        const preferred = ['check', 'test', 'build', 'lint'];
        commands = preferred.filter((name) => manifest.scripts?.[name]).map((name) => `npm run ${name}`);
      } catch {
        stack = 'Node.js project; package.json exists but could not be safely summarized.';
      }
    } else if (names.has('pyproject.toml') || names.has('requirements.txt')) {
      stack = 'Python; follow pyproject.toml/requirements.txt and the existing test runner.';
      commands = names.has('pyproject.toml') ? ['python -m pytest'] : [];
    } else if (names.has('Cargo.toml')) {
      stack = 'Rust; follow Cargo.toml and existing crate conventions.';
      commands = ['cargo test', 'cargo check'];
    } else if (names.has('go.mod')) {
      stack = 'Go; follow go.mod and existing package conventions.';
      commands = ['go test ./...'];
    }
    return { mission, stack, commands, directories };
  }
}
