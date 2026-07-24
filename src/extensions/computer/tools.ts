import { createHash } from 'node:crypto';
import { tool, type Tool, type ToolOutputImage, type ToolOutputText } from '@openai/agents';
import { z } from 'zod';
import { TOOL_LEDGER_ARGUMENTS } from '../../core/tool-metadata.js';
import { ComputerManager, type ComputerRunAuthority } from './manager.js';
import { computerActionSchema, computerActInputSchema, computerObserveInputSchema } from './types.js';

type StructuredOutput = ToolOutputText | ToolOutputImage;

const observeToolParameters = z.object({
  scope: z.enum(['targets', 'window', 'region', 'desktop', 'driver', 'session']),
  query: z.string().optional(),
  limit: z.number().optional(),
  target: z.object({ bundleId: z.string().optional(), pid: z.number().optional(), windowId: z.number().optional() }).optional(),
  includeScreenshot: z.boolean().optional(),
  maxElements: z.number().optional(),
  maxDepth: z.number().optional(),
  observationId: z.string().optional(),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  include: z.array(z.enum(['health', 'permissions', 'config', 'recording'])).optional(),
  promptForPermissions: z.boolean().optional(),
});

const actToolParameters = z.object({
  observationId: z.string().optional(),
  action: computerActionSchema,
});

function nonStrictToolSchema(schema: z.ZodType) {
  const converted = z.toJSONSchema(schema) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  return {
    ...converted,
    type: 'object' as const,
    properties: converted.properties ?? {},
    required: converted.required ?? [],
    additionalProperties: true as const,
  };
}

export function computerLedgerArguments(rawInput: string): string {
  try {
    const value = JSON.parse(rawInput) as Record<string, unknown>;
    const action = value.action as Record<string, unknown> | undefined;
    if (action?.type === 'type_text' && typeof action.text === 'string') {
      action.textSha256 = createHash('sha256').update(action.text).digest('hex');
      action.textLength = action.text.length;
      delete action.text;
    }
    return JSON.stringify(value);
  } catch {
    return rawInput;
  }
}

export function createComputerTools(
  manager: ComputerManager,
  currentRun: () => ComputerRunAuthority | undefined,
): Tool[] {
  const authority = () => {
    const value = currentRun();
    if (!value) throw new Error('当前没有可绑定的 Computer Run');
    return value;
  };
  const observe = tool({
    name: 'computer_observe',
    description: '只读发现本机应用/窗口、观察目标窗口 AX 元素或按授权获取局部图像。GUI 写动作前后都必须重新观察；默认不要截图。',
    parameters: nonStrictToolSchema(observeToolParameters),
    // The public schema intentionally contains optional fields. Keep SDK strict
    // conversion from rejecting otherwise valid schemas across patch releases;
    // the canonical discriminated schema is still enforced before execution.
    strict: false,
    execute: async (input, _context, details): Promise<unknown> => {
      const parsed = computerObserveInputSchema.parse(input);
      const result = await manager.observe(authority(), parsed, details?.signal);
      if (!result || typeof result !== 'object' || !('screenshot' in result) || !result.screenshot) return result;
      const { screenshot, ...metadata } = result as typeof result & { screenshot: { data: string; mediaType: string } };
      return [
        { type: 'text', text: JSON.stringify(metadata) } satisfies ToolOutputText,
        { type: 'image', image: { data: screenshot.data, mediaType: screenshot.mediaType }, detail: 'high' } satisfies ToolOutputImage,
      ] satisfies StructuredOutput[];
    },
  });
  const act = tool({
    name: 'computer_act',
    description: '执行一个受策略约束的原子电脑动作。默认后台；目标 UI 动作必须引用新鲜 observationId，动作后必须再次调用 computer_observe 验证。用户明确要求在当前桌面查看、接管或游玩应用时，使用 handoff_to_user 持久交付前台；bring_to_front 仅用于会自动恢复的短暂 lease。结果不确定时禁止重试。',
    parameters: nonStrictToolSchema(actToolParameters),
    strict: false,
    execute: (input, _context, details) => manager.act(authority(), computerActInputSchema.parse(input), details?.signal),
  }) as Tool & { [TOOL_LEDGER_ARGUMENTS]?: (rawInput: string) => string };
  act[TOOL_LEDGER_ARGUMENTS] = computerLedgerArguments;
  return [observe, act];
}
