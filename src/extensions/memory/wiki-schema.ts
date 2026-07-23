import { z } from 'zod';

export const sourceRefSchema = z.object({
  type: z.enum(['file', 'session', 'mimi-event', 'user-explicit', 'memory']),
  id: z.string().min(1).max(1_000),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  occurredAt: z.string().datetime(),
  trust: z.enum(['owner', 'trusted', 'external', 'public', 'system']),
}).strict();

export const memoryPageMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^mem_[a-zA-Z0-9_-]{8,100}$/),
  title: z.string().trim().min(1).max(200),
  kind: z.enum(['profile', 'fact', 'concept', 'entity', 'decision', 'lesson', 'source-summary', 'synthesis', 'procedure-ref']),
  scope: z.enum(['private', 'workspace']),
  profileId: z.string().min(1).max(100).nullable(),
  status: z.enum(['active', 'conflicted', 'superseded']),
  confidence: z.enum(['user-confirmed', 'source-grounded', 'inferred']),
  aliases: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  tags: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  sourceRefs: z.array(sourceRefSchema).min(1).max(50),
  validFrom: z.string().datetime().nullable(),
  validUntil: z.string().datetime().nullable(),
  supersedes: z.array(z.string()).max(30).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.scope === 'private' && !value.profileId) {
    context.addIssue({ code: 'custom', path: ['profileId'], message: 'private 页面必须绑定 profileId' });
  }
  if (value.scope === 'workspace' && value.profileId !== null) {
    context.addIssue({ code: 'custom', path: ['profileId'], message: 'workspace 页面不能绑定 profileId' });
  }
});

export const DEFAULT_WIKI_SCHEMA = `# MimiAgent Wiki Maintenance Contract

- 每个页面只表达一个稳定主题，并保留逐项 SourceRef。
- 更新现有主题优先于创建重复页面；无法裁决的矛盾标记为 conflicted。
- private 内容不得写入 workspace Wiki，外部事件原文不得成为项目知识。
- knowledge/sources 是不可变证据；更新来源必须创建新版本并使用 supersedes 关联。
- WIKI.md 只能收紧分类和维护偏好，不能扩大 scope、trust 或工具权限。
`;
