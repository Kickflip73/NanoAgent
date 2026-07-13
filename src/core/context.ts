import type { AgentInputItem, SessionInputCallback } from '@openai/agents';
import type { Memory } from './memory.js';
import type { PlanStep } from './plan.js';
import type { RagMatch } from '../extensions/rag.js';

export interface ContextParts {
  baseInstructions: string;
  historySummary: string;
  skillCatalog: string;
  memories: Memory[];
  documents: RagMatch[];
  plan: PlanStep[];
}

export class ContextManager {
  constructor(private readonly historyLimit = 40) {}

  readonly sessionInput: SessionInputCallback = async (history, input) => [
    ...this.trimHistory(history),
    ...input,
  ];

  buildInstructions(parts: ContextParts): string {
    const sections = [parts.baseInstructions];
    if (parts.historySummary) sections.push(`较早会话摘要：\n${parts.historySummary}`);
    if (parts.skillCatalog) sections.push(`可用 Skills：\n${parts.skillCatalog}`);
    if (parts.memories.length) {
      sections.push(
        `与当前问题相关的长期记忆：\n${parts.memories.map((memory) => `- [${memory.type}:${memory.id}] ${memory.content}`).join('\n')}`,
      );
    }
    if (parts.documents.length) {
      sections.push(
        `知识库检索结果（回答时标注来源）：\n${parts.documents.map((match) => `- [${match.source}] ${match.content}`).join('\n')}`,
      );
    }
    if (parts.plan.length) {
      sections.push(
        `当前计划：\n${parts.plan.map((step) => `- [${step.status}] ${step.id}. ${step.description}`).join('\n')}`,
      );
    }
    return sections.join('\n\n');
  }

  summarizeHistory(history: AgentInputItem[]): string {
    const cleaned = history.filter((item) => !this.isGeneratedSummary(item));
    const start = this.historyStart(cleaned);
    return cleaned
      .slice(0, start)
      .filter((item) => this.itemRole(item) === 'user' || this.itemRole(item) === 'assistant')
      .map((item) => JSON.stringify(item).slice(0, 500))
      .join('\n')
      .slice(-4_000);
  }

  private trimHistory(history: AgentInputItem[]): AgentInputItem[] {
    const cleaned = history.filter((item) => !this.isGeneratedSummary(item));
    return cleaned.slice(this.historyStart(cleaned));
  }

  private historyStart(history: AgentInputItem[]): number {
    let start = Math.max(0, history.length - this.historyLimit);
    while (start > 0 && this.itemRole(history[start]) !== 'user') start -= 1;
    return start;
  }

  private itemRole(item: AgentInputItem | undefined): string | undefined {
    return item && typeof item === 'object' && 'role' in item
      ? String(item.role)
      : undefined;
  }

  private isGeneratedSummary(item: AgentInputItem): boolean {
    if (this.itemRole(item) !== 'user' || !('content' in item)) return false;
    return typeof item.content === 'string' && item.content.startsWith('[更早的会话历史已压缩为摘要');
  }
}
