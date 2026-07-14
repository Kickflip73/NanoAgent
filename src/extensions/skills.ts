import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tool } from '@openai/agents';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const metadataSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  'allowed-tools': z.string().optional(),
}).passthrough();

const MAX_SKILL_BYTES = 512_000;
const MAX_RESOURCE_BYTES = 256_000;
const MAX_SKILLS = 200;
const MAX_TOTAL_SKILL_BYTES = 10_000_000;

async function readBoundedUtf8(file: string, maxBytes: number, label: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${label} 必须是常规文件`);
    if (info.size > maxBytes) throw new Error(`${label} 超过 ${Math.floor(maxBytes / 1_000)}KB`);
    const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error(`${label} 超过 ${Math.floor(maxBytes / 1_000)}KB`);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

export interface Skill {
  name: string;
  description: string;
  content: string;
  root: string;
  file: string;
  metadata: z.infer<typeof metadataSchema>;
}

function parseFrontmatter(markdown: string): z.infer<typeof metadataSchema> {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) throw new Error('SKILL.md 缺少 YAML frontmatter');
  try {
    return metadataSchema.parse(parseYaml(match[1]));
  } catch (error) {
    throw new Error(`Skill 元数据无效：${error instanceof Error ? error.message : String(error)}`);
  }
}

export class SkillLoader {
  private skills = new Map<string, Skill>();
  private warnings: string[] = [];

  constructor(private readonly directory: string) {}

  async load(): Promise<void> {
    this.skills.clear();
    this.warnings = [];
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const directories = entries.filter((entry) => entry.isDirectory());
    let totalBytes = 0;
    for (const entry of directories.slice(0, MAX_SKILLS)) {
      const root = path.join(this.directory, entry.name);
      const file = path.join(root, 'SKILL.md');
      try {
        const content = await readBoundedUtf8(file, MAX_SKILL_BYTES, 'SKILL.md');
        totalBytes += Buffer.byteLength(content, 'utf8');
        if (totalBytes > MAX_TOTAL_SKILL_BYTES) throw new Error('Skill 总文本超过 10MB');
        const metadata = parseFrontmatter(content);
        if (metadata.name !== entry.name) {
          throw new Error(`目录名 ${entry.name} 必须与 name ${metadata.name} 一致`);
        }
        if (this.skills.has(metadata.name)) throw new Error(`Skill 名称重复：${metadata.name}`);
        this.skills.set(metadata.name, {
          name: metadata.name,
          description: metadata.description,
          content,
          root,
          file,
          metadata,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        this.warnings.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (directories.length > MAX_SKILLS) this.warnings.push(`Skill 目录超过 ${MAX_SKILLS} 项，仅加载前 ${MAX_SKILLS} 项`);
  }

  catalog(): string {
    return [...this.skills.values()]
      .map((skill) => `- ${skill.name}: ${skill.description}\n  location: ${skill.file}`)
      .join('\n');
  }

  list(): Array<Pick<Skill, 'name' | 'description' | 'root' | 'file'>> {
    return [...this.skills.values()].map(({ name, description, root, file }) => ({ name, description, root, file }));
  }

  diagnostics(): string[] {
    return [...this.warnings];
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  async readResource(name: string, resource: string): Promise<{ path: string; content: string }> {
    const skill = this.get(name);
    if (!skill) throw new Error(`未找到 Skill：${name}`);
    if (!resource || path.isAbsolute(resource)) throw new Error('Skill 资源必须是相对路径');
    const target = path.resolve(skill.root, resource);
    const relative = path.relative(skill.root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Skill 资源不能超出 Skill 目录');
    const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(skill.root), realpath(target)]);
    const canonicalRelative = path.relative(canonicalRoot, canonicalTarget);
    if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
      throw new Error('Skill 资源不能通过符号链接超出 Skill 目录');
    }
    const content = await readBoundedUtf8(canonicalTarget, MAX_RESOURCE_BYTES, 'Skill 文本资源');
    return { path: canonicalTarget, content };
  }

  createTools() {
    return [
      tool({
        name: 'use_skill',
        description: '按名称激活匹配的 Agent Skill，返回完整说明和资源根目录。',
        parameters: z.object({ name: z.string().min(1) }),
        execute: async ({ name }) => {
          const skill = this.get(name);
          if (!skill) throw new Error(`未找到 Skill：${name}`);
          return skill.content;
        },
      }),
      tool({
        name: 'read_skill_resource',
        description: '读取已激活 Skill 中按需引用的文本资源，路径相对于该 Skill 根目录。',
        parameters: z.object({ name: z.string().min(1), path: z.string().min(1) }),
        execute: async ({ name, path: resource }) => this.readResource(name, resource),
      }),
      tool({
        name: 'list_skills',
        description: '列出可用 Agent Skills 及其位置。',
        parameters: z.object({}),
        execute: async () => this.list(),
      }),
      tool({
        name: 'reload_skills',
        description: '重新扫描工作区 Skills，适用于新增或修改 SKILL.md 后立即生效。',
        parameters: z.object({}),
        execute: async () => {
          await this.load();
          return { skills: this.list(), warnings: this.diagnostics() };
        },
      }),
    ];
  }
}
