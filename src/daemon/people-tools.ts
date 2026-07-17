import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import { AttentionEngine, mimiPersonSchema } from './attention.js';

const personIdSchema = z.string().regex(/^[a-zA-Z0-9._-]+$/).min(1).max(60);

export function createMimiPeopleTools(attention: AttentionEngine): Tool[] {
  const list = tool({
    name: 'list_mimi_people',
    description: '列出 owner 已明确维护的跨渠道人物，包括稳定 ID、显示名、source/actor aliases 和可信关系 context。用于新增、更新或删除前核对。',
    parameters: z.object({}),
    execute: async () => attention.listPeople(),
  });

  const upsert = tool({
    name: 'upsert_mimi_person',
    description: '按稳定 ID 新增或完整更新一个人物映射，让邮件、IM、短信等渠道中的同一人物共享 Session、Memory 和关系上下文。仅根据 owner 明确提供或已核实的 actor 标识维护，修改前应先列出现有人物。',
    parameters: mimiPersonSchema,
    execute: async (person) => attention.upsertPerson(person),
  });

  const remove = tool({
    name: 'remove_mimi_person',
    description: '按稳定 ID 删除一个跨渠道人物映射。不会删除既有 Session、Memory 或历史事件，只影响后续身份解析。',
    parameters: z.object({ id: personIdSchema }),
    execute: async ({ id }) => ({ id, removed: await attention.removePerson(id) }),
  });

  return [list, upsert, remove];
}
