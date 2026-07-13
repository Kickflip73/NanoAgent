import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tool } from '@openai/agents';
import { z } from 'zod';

export interface Skill {
  name: string;
  description: string;
  content: string;
}

function frontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match?.[1]) return {};
  return Object.fromEntries(
    match[1]
      .split('\n')
      .map((line) => line.match(/^([\w-]+):\s*(.*)$/))
      .filter((item): item is RegExpMatchArray => Boolean(item))
      .map((item) => [item[1]!, item[2]!.replace(/^['"]|['"]$/g, '')]),
  );
}

export class SkillLoader {
  private skills = new Map<string, Skill>();

  constructor(private readonly directory: string) {}

  async load(): Promise<void> {
    this.skills.clear();
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.directory, entry.name, 'SKILL.md');
      try {
        const content = await readFile(file, 'utf8');
        const metadata = frontmatter(content);
        const name = metadata.name ?? entry.name;
        this.skills.set(name, {
          name,
          description: metadata.description ?? '未提供描述',
          content,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  catalog(): string {
    return [...this.skills.values()]
      .map((skill) => `- ${skill.name}: ${skill.description}`)
      .join('\n');
  }

  list(): Array<Pick<Skill, 'name' | 'description'>> {
    return [...this.skills.values()].map(({ name, description }) => ({ name, description }));
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  createTools() {
    return [
      tool({
        name: 'use_skill',
        description: '按名称加载一个 Skill 的完整工作流说明；只有任务与 Skill 描述匹配时才使用。',
        parameters: z.object({ name: z.string().min(1) }),
        execute: async ({ name }) => {
          const skill = this.get(name);
          if (!skill) throw new Error(`未找到 Skill：${name}`);
          return skill.content;
        },
      }),
      tool({
        name: 'list_skills',
        description: '列出可用 Skills 及其描述。',
        parameters: z.object({}),
        execute: async () => this.list(),
      }),
    ];
  }
}
