import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import { AttentionEngine } from './attention.js';

export function createMimiBriefingTools(attention: AttentionEngine): Tool[] {
  return [tool({
    name: 'request_mimi_briefing',
    description: '立即把当前摘要池中的待处理事项生成一份 MimiAgent 简报，并通过 owner 的回复渠道主动送达。适用于“现在汇总一下”“给我一份简报”。该工具只返回创建状态，不返回其他事件正文。',
    parameters: z.object({}),
    execute: async () => {
      const event = attention.forceBriefing();
      if (!event) {
        return { created: false, reason: '当前没有待汇总事项' };
      }
      return {
        created: true,
        eventId: event.id,
        sessionKey: event.sessionKey,
        replyChannel: event.replyRoute?.channel,
      };
    },
  })];
}
