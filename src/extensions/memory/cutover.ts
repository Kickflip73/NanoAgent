import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { contentDigest, type MemoryHub, type MemoryKind, type RunMemoryContext } from '../../core/memory.js';
import { withExclusiveFileLock } from '../../core/state-file.js';

const legacyMemorySchema = z.array(z.object({
  id: z.string(),
  type: z.enum(['preference', 'fact', 'decision', 'todo']),
  content: z.string(),
  source: z.enum(['user', 'agent']).optional(),
  sourceSessionId: z.string().optional(),
  recordedAt: z.string().optional(),
  confirmedAt: z.string().optional(),
}).passthrough());

const markerSchema = z.object({
  version: z.literal(1),
  completedAt: z.string(),
  backupDirectory: z.string(),
  converted: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  soulConverted: z.number().int().nonnegative().optional(),
  soulReset: z.boolean().optional(),
  soulCutoverAt: z.string().optional(),
}).strict();

export interface MemoryCutoverReport extends z.infer<typeof markerSchema> {}

function memoryKind(type: 'preference' | 'fact' | 'decision'): MemoryKind {
  if (type === 'preference') return 'profile';
  return type;
}

async function exists(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function writeMarker(file: string, report: MemoryCutoverReport): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}

function legacySoulFacts(content: string): string[] {
  const personal = /(?:用户|owner|我(?:的|是|叫|喜欢|偏好|希望|常用|住在)|姓名|称呼|时区|prefers?|likes?|owner['’]s)/i;
  const projectOrPolicy = /(?:AGENTS\.md|CLAUDE\.md|架构|代码|项目|npm|pnpm|yarn|pytest|cargo|go test|tool|权限|安全|shell|MCP|runtime|workflow|测试|部署)/i;
  return [...new Set(content.split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter((line) => line.length >= 4 && line.length <= 500 && personal.test(line) && !projectOrPolicy.test(line)))]
    .slice(0, 20);
}

async function cutoverLegacySoul(
  hub: MemoryHub,
  context: RunMemoryContext,
  backupDirectory: string,
  options: { userSoulFile?: string; packagedSoulFile?: string },
): Promise<Pick<MemoryCutoverReport, 'soulConverted' | 'soulReset' | 'soulCutoverAt'>> {
  if (!options.userSoulFile || !options.packagedSoulFile || !await exists(options.userSoulFile)) {
    return { soulConverted: 0, soulReset: false, soulCutoverAt: new Date().toISOString() };
  }
  const legacy = await readFile(options.userSoulFile, 'utf8');
  const alreadySoul = /^# MimiAgent Soul\b/m.test(legacy)
    && !/(?:npm run|runtime policy|工具权限|项目架构)/i.test(legacy);
  if (alreadySoul) return { soulConverted: 0, soulReset: false, soulCutoverAt: new Date().toISOString() };
  await copyFile(options.userSoulFile, path.join(backupDirectory, 'user-MIMI.md'));
  const timestamp = new Date().toISOString();
  const facts = legacySoulFacts(legacy);
  for (const [index, fact] of facts.entries()) {
    await hub.remember({
      title: `Legacy Soul owner fact ${index + 1}`,
      content: fact,
      kind: 'profile',
      scope: 'private',
      confidence: 'user-confirmed',
      sourceRefs: [{
        type: 'user-explicit', id: `legacy-soul:${index + 1}`,
        digest: `sha256:${contentDigest(fact)}`, occurredAt: timestamp, trust: 'owner',
      }],
    }, context);
  }
  const template = await readFile(options.packagedSoulFile, 'utf8');
  const temporary = `${options.userSoulFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, template.endsWith('\n') ? template : `${template}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, options.userSoulFile);
  await chmod(options.userSoulFile, 0o600);
  return { soulConverted: facts.length, soulReset: true, soulCutoverAt: timestamp };
}

async function verifyCutover(hub: MemoryHub, context: RunMemoryContext): Promise<void> {
  const lint = await hub.lint(context);
  if (!lint.valid) throw new Error(`MemoryHub 切换 Lint 失败：${lint.issues.find((issue) => issue.severity === 'error')?.message ?? 'unknown'}`);
  const status = await hub.status(context);
  if ((status.pendingReceipts ?? 0) > 0) throw new Error('MemoryHub 切换仍有 pending compilation receipt，拒绝写 completion marker');
}

export async function cutoverLegacyMemory(
  hub: MemoryHub,
  workspaceRoot: string,
  dataRoot: string,
  context: RunMemoryContext,
  options: { userSoulFile?: string; packagedSoulFile?: string } = {},
): Promise<MemoryCutoverReport> {
  const memoryRoot = path.join(dataRoot, 'memory');
  const markerFile = path.join(memoryRoot, 'cutover-v1.json');
  return withExclusiveFileLock(markerFile, async () => {
    if (await exists(markerFile)) {
      const previous = markerSchema.parse(JSON.parse(await readFile(markerFile, 'utf8')));
      if (previous.soulCutoverAt) return previous;
      const report = { ...previous, ...await cutoverLegacySoul(hub, context, previous.backupDirectory, options) };
      await verifyCutover(hub, context);
      await writeMarker(markerFile, report);
      return report;
    }
    const timestamp = new Date().toISOString();
    const backupDirectory = path.join(memoryRoot, 'backups', timestamp.replace(/[:.]/g, '-'));
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    const legacyFiles = [
      path.join(dataRoot, 'memories.json'),
      path.join(dataRoot, 'rag-index.json'),
      path.join(workspaceRoot, 'MIMI.md'),
    ];
    for (const file of legacyFiles) {
      if (await exists(file)) await copyFile(file, path.join(backupDirectory, path.basename(file)));
    }
    const legacyProjectGuidance = path.join(workspaceRoot, 'MIMI.md');
    const agentsFile = path.join(workspaceRoot, 'AGENTS.md');
    const claudeFile = path.join(workspaceRoot, 'CLAUDE.md');
    if (await exists(legacyProjectGuidance) && !await exists(agentsFile) && !await exists(claudeFile)) {
      try {
        await access(workspaceRoot, constants.W_OK);
        const legacy = (await readFile(legacyProjectGuidance, 'utf8')).trim();
        if (legacy) await writeFile(agentsFile, `# Project Agent Guide\n\n${legacy}\n`, { flag: 'wx', mode: 0o644 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EACCES' && (error as NodeJS.ErrnoException).code !== 'EROFS') throw error;
      }
    }
    let converted = 0;
    let skipped = 0;
    const memoriesFile = path.join(dataRoot, 'memories.json');
    if (await exists(memoriesFile)) {
      const memories = legacyMemorySchema.parse(JSON.parse(await readFile(memoriesFile, 'utf8')));
      for (const memory of memories) {
        if (memory.type === 'todo' || (!memory.recordedAt && !memory.confirmedAt)) {
          skipped += 1;
          continue;
        }
        const title = memory.content.replace(/\s+/g, ' ').trim().slice(0, 80) || `Legacy memory ${memory.id}`;
        await hub.remember({
          title,
          content: memory.content,
          kind: memoryKind(memory.type),
          scope: 'private',
          confidence: memory.source === 'user' || memory.confirmedAt ? 'user-confirmed' : 'inferred',
          sourceRefs: [{
            type: memory.source === 'user' ? 'user-explicit' : 'session',
            id: memory.sourceSessionId ? `${memory.sourceSessionId}/legacy` : `legacy:${memory.id}`,
            digest: `sha256:${contentDigest(memory.content)}`,
            occurredAt: memory.recordedAt ?? memory.confirmedAt ?? timestamp,
            trust: 'owner',
          }],
        }, context);
        converted += 1;
      }
    }
    const soul = await cutoverLegacySoul(hub, context, backupDirectory, options);
    const report: MemoryCutoverReport = { version: 1, completedAt: timestamp, backupDirectory, converted, skipped, ...soul };
    await verifyCutover(hub, context);
    await writeMarker(markerFile, report);
    return report;
  });
}
