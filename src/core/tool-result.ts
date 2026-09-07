import path from 'node:path';
import { z } from 'zod';
import type { ExecutionCallRecord } from './execution-ledger.js';
import { sanitizeSensitiveData } from './data-sanitizer.js';

export function toolResultObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function toolResultFailure(value: unknown): string | undefined {
  const result = toolResultObject(value);
  if (!result) return undefined;
  const failed = ['tool_failed', 'tool_input_rejected', 'action_uncertain'].includes(String(result.mimiStatus))
    || ['failed', 'uncertain'].includes(String(result.outcome))
    || ['failed', 'uncertain'].includes(String(result.status))
    || result.success === false || result.ok === false || result.timedOut === true
    || (typeof result.exitCode === 'number' && result.exitCode !== 0);
  if (!failed) return undefined;
  const message = [result.message, result.error, result.stderr, result.code]
    .find((candidate) => typeof candidate === 'string' && candidate.trim());
  return typeof message === 'string' ? message.slice(0, 2_000) : '工具返回结构化失败';
}

export function toolResultUncertain(value: unknown): boolean {
  const result = toolResultObject(value);
  return result?.mimiStatus === 'action_uncertain' || result?.status === 'uncertain'
    || result?.outcome === 'uncertain' || result?.uncertain === true;
}

export const resultArtifactSchema = z.object({
  path: z.string().min(1).max(2_000),
  toolName: z.string().min(1).max(200),
  callId: z.string().min(1).max(200),
}).strict();
export type ResultArtifact = z.infer<typeof resultArtifactSchema>;

/** References reported by tools, not a claim that a file still exists or meets acceptance criteria. */
export function resultArtifacts(calls: readonly ExecutionCallRecord[]): ResultArtifact[] {
  const artifacts = new Map<string, ResultArtifact>();
  for (const call of calls) {
    if (call.status !== 'succeeded' || toolResultFailure(call.output) || toolResultUncertain(call.output)) continue;
    const visit = (value: unknown, depth: number): void => {
      if (depth > 4 || artifacts.size >= 100) return;
      if (Array.isArray(value)) { value.slice(0, 100).forEach((item) => visit(item, depth + 1)); return; }
      const record = toolResultObject(value);
      if (!record) return;
      for (const key of ['path', 'file', 'outputPath', 'filePath']) {
        const file = record[key];
        if (typeof file === 'string' && path.isAbsolute(file) && file.length <= 2_000) {
          artifacts.set(file, { path: file, toolName: call.toolName.slice(0, 200), callId: call.callId.slice(0, 200) });
        }
      }
      for (const key of ['result', 'output', 'audio', 'artifacts', 'files']) visit(record[key], depth + 1);
    };
    visit(call.output, 0);
  }
  return sanitizeSensitiveData([...artifacts.values()]).filter((artifact) => artifact.path.length <= 2_000);
}

export const toolProgressSchema = z.object({
  toolName: z.string().max(200), callId: z.string().max(200),
  status: z.enum(['succeeded', 'failed', 'uncertain', 'started']),
  arguments: z.string().max(1_000), result: z.string().max(2_000),
}).strict();
export type ToolProgress = z.infer<typeof toolProgressSchema>;

export function toolProgress(call: ExecutionCallRecord): ToolProgress {
  const preview = (value: unknown, limit: number): string => {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    return text.length <= limit ? text : `${text.slice(0, limit - 16)} [truncated]`;
  };
  const argumentsValue = sanitizeSensitiveData(toolResultObject(call.argumentsJson) ?? call.argumentsJson);
  const output = call.error ?? call.output;
  const resultValue = sanitizeSensitiveData(toolResultObject(output) ?? output);
  return { toolName: call.toolName.slice(0, 200), callId: call.callId.slice(0, 200),
    status: call.status, arguments: preview(argumentsValue, 1_000), result: preview(resultValue, 2_000) };
}
