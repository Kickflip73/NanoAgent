import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const artifactIdSchema = z.string().regex(/^artifact-[a-f0-9-]{36}$/);
const manifestSchema = z.object({
  version: z.literal(1),
  artifactId: artifactIdSchema,
  runId: z.string().min(1),
  createdAt: z.string(),
  sealedAt: z.string(),
  actionCount: z.number().int().nonnegative(),
  containsText: z.boolean(),
  containsDesktopCoordinates: z.boolean(),
  totalBytes: z.number().int().nonnegative(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ComputerArtifactManifest = z.infer<typeof manifestSchema>;

interface PendingArtifact {
  artifactId: string;
  runId: string;
  directory: string;
  createdAt: string;
}

export class ComputerArtifactStore {
  private readonly pending = new Map<string, PendingArtifact>();

  constructor(
    private readonly root: string,
    private readonly maxBytes: number,
  ) {}

  async create(runId: string): Promise<PendingArtifact> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    const artifactId = `artifact-${randomUUID()}`;
    const directory = this.directory(artifactId);
    await mkdir(directory, { mode: 0o700 });
    const pending = { artifactId, runId, directory, createdAt: new Date().toISOString() };
    this.pending.set(artifactId, pending);
    return pending;
  }

  async seal(artifactId: string, runId: string): Promise<ComputerArtifactManifest> {
    const pending = this.pending.get(artifactId);
    if (!pending || pending.runId !== runId) throw new Error('录制 artifact 不属于当前 Run 或尚未开始');
    const files = await this.files(pending.directory, false, true);
    let totalBytes = 0;
    let actionCount = 0;
    let containsText = false;
    let containsDesktopCoordinates = false;
    const content = createHash('sha256');
    for (const file of files) {
      totalBytes += file.size;
      if (totalBytes > this.maxBytes) throw new Error(`Computer artifact 超过 ${this.maxBytes} 字节配额`);
      content.update(file.relative).update('\0');
      await new Promise<void>((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(file.absolute);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => { content.update(hash.digest('hex')).update('\0'); resolve(); });
      });
      if (path.basename(file.absolute) === 'action.json') {
        actionCount += 1;
        if (file.size > 1024 * 1024) throw new Error('trajectory action.json 超过 1 MiB 上限');
        const source = await readFile(file.absolute, 'utf8');
        const value = JSON.parse(source) as unknown;
        const serialized = JSON.stringify(value);
        containsText ||= /"text"\s*:/.test(serialized);
        containsDesktopCoordinates ||= /"scope"\s*:\s*"desktop"/.test(serialized);
      }
    }
    const base = {
      version: 1 as const,
      artifactId,
      runId,
      createdAt: pending.createdAt,
      sealedAt: new Date().toISOString(),
      actionCount,
      containsText,
      containsDesktopCoordinates,
      totalBytes,
      contentSha256: content.digest('hex'),
    };
    const manifest = manifestSchema.parse({
      ...base,
      manifestSha256: createHash('sha256').update(JSON.stringify(base)).digest('hex'),
    });
    const temporary = path.join(pending.directory, `.manifest-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path.join(pending.directory, 'manifest.json'));
    this.pending.delete(artifactId);
    return manifest;
  }

  async openReplay(
    artifactId: string,
    manifestSha256: string,
  ): Promise<{ directory: string; manifest: ComputerArtifactManifest }> {
    const directory = this.directory(artifactId);
    const manifestFile = path.join(directory, 'manifest.json');
    const info = await lstat(manifestFile);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Computer artifact manifest 必须是单链接普通文件');
    const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestFile, 'utf8')) as unknown);
    if (manifest.artifactId !== artifactId || manifest.manifestSha256 !== manifestSha256) {
      throw new Error('trajectory manifest hash 不匹配，批准已失效');
    }
    const { manifestSha256: _storedHash, ...base } = manifest;
    const actualHash = createHash('sha256').update(JSON.stringify(base)).digest('hex');
    if (actualHash !== manifestSha256) throw new Error('trajectory manifest 内容已变化');
    const files = await this.files(directory);
    let totalBytes = 0;
    const content = createHash('sha256');
    for (const file of files) {
      totalBytes += file.size;
      if (totalBytes > this.maxBytes) throw new Error(`Computer artifact 超过 ${this.maxBytes} 字节配额`);
      content.update(file.relative).update('\0');
      await new Promise<void>((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(file.absolute);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => { content.update(hash.digest('hex')).update('\0'); resolve(); });
      });
    }
    if (totalBytes !== manifest.totalBytes || content.digest('hex') !== manifest.contentSha256) {
      throw new Error('trajectory 文件内容已变化，批准已失效');
    }
    for (const file of files.filter((candidate) => path.basename(candidate.absolute) === 'action.json')) {
      if (file.size > 1024 * 1024) throw new Error('trajectory action.json 超过 1 MiB 上限');
      const source = await readFile(file.absolute, 'utf8');
      if (/"element_(?:index|token)"\s*:/.test(source)) {
        throw new Error('trajectory 含跨 Session 不稳定的 element index/token，拒绝回放');
      }
    }
    return { directory, manifest };
  }

  private directory(artifactId: string): string {
    const selected = artifactIdSchema.parse(artifactId);
    const directory = path.resolve(this.root, selected);
    const relative = path.relative(path.resolve(this.root), directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Computer artifact 路径越界');
    return directory;
  }

  private async files(
    directory: string,
    allowManifest = false,
    normalizePermissions = false,
  ): Promise<Array<{ absolute: string; relative: string; size: number }>> {
    const rootInfo = await lstat(directory);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Computer artifact 根必须是普通目录');
    if (normalizePermissions) await chmod(directory, 0o700);
    const result: Array<{ absolute: string; relative: string; size: number }> = [];
    const visit = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        if (!allowManifest && entry.name === 'manifest.json') continue;
        if (entry.name.startsWith('.manifest-')) continue;
        const absolute = path.join(current, entry.name);
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) throw new Error('Computer artifact 不允许符号链接');
        if (info.isDirectory()) {
          if (normalizePermissions) await chmod(absolute, 0o700);
          await visit(absolute);
        } else if (info.isFile() && info.nlink === 1) {
          if (normalizePermissions) await chmod(absolute, 0o600);
          result.push({ absolute, relative: path.relative(directory, absolute), size: info.size });
        }
        else throw new Error('Computer artifact 只允许单链接普通文件和目录');
      }
    };
    await visit(directory);
    return result.sort((left, right) => left.relative.localeCompare(right.relative));
  }
}
