import { z } from 'zod';

export const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const RESERVED_SESSION_IDS = new Set(['__proto__', 'prototype', 'constructor']);

export const sessionIdSchema = z.string()
  .min(1, '会话 ID 不能为空')
  .max(80, '会话 ID 最多 80 个字符')
  .regex(SESSION_ID_PATTERN, '会话 ID 只能包含字母、数字、下划线和连字符')
  .refine((id) => !RESERVED_SESSION_IDS.has(id.toLowerCase()), '会话 ID 不能使用保留名称');

export function assertSessionId(id: string): string {
  const result = sessionIdSchema.safeParse(id);
  if (!result.success) {
    throw new Error(result.error.issues[0]?.message ?? '会话 ID 格式无效');
  }
  return result.data;
}
