import { createHash } from 'node:crypto';
import path from 'node:path';
import type { MemoryScope, RememberInput, RunMemoryContext, SourceRef } from './types.js';

const ID_PATTERN = /^[a-zA-Z0-9._-]{1,100}$/;
const SECRET_PATTERN = /(?:api[_ -]?key|password|passwd|secret|token|authorization)\s*[:=]\s*\S+/i;

export function validateRunMemoryContext(context: RunMemoryContext, workspaceRoot: string, profileId: string): void {
  if (!ID_PATTERN.test(context.profileId) || context.profileId !== profileId) throw new Error('Memory profile 不匹配');
  if (!context.sessionId || !context.runId) throw new Error('Memory 写入缺少 Session/Run ownership');
  if (path.resolve(context.workspaceRoot) !== path.resolve(workspaceRoot)) throw new Error('Memory workspace 不匹配');
}

export function assertRememberAllowed(input: RememberInput, context: RunMemoryContext): void {
  const trust = context.cause?.trust ?? 'owner';
  if (trust === 'external' || trust === 'public') throw new Error('外部来源不能直接写入 active Memory');
  if (SECRET_PATTERN.test(`${input.title}\n${input.content}`)) throw new Error('Memory 不能保存密码、token 或凭证');
  if (input.scope === 'workspace') {
    const fileSources = input.sourceRefs?.filter((source) => source.type === 'file') ?? [];
    if (fileSources.length === 0) throw new Error('workspace Memory 必须有明确的文件来源');
    if (fileSources.some((source) => source.trust !== 'owner' && source.trust !== 'system')) {
      throw new Error('workspace Memory 不能包含私人或外部 provenance');
    }
  }
}

export function assertRefVisible(scope: MemoryScope, refProfileId: string | undefined, context: RunMemoryContext): void {
  if (scope === 'private' && refProfileId !== context.profileId) throw new Error('Private Memory profile 不可见');
}

export function sourceDigest(source: Pick<SourceRef, 'type' | 'id' | 'digest'>): string {
  return createHash('sha256').update(`${source.type}\0${source.id}\0${source.digest}`).digest('hex');
}

export function contentDigest(content: string): string {
  return createHash('sha256').update(content.trim().replace(/\r\n/g, '\n')).digest('hex');
}

export function stableDirectoryId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}
