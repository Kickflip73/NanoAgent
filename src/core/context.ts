import type { AgentInputItem, SessionInputCallback } from '@openai/agents';
import type { Memory } from './memory.js';
import type { Goal, PlanStep } from './plan.js';
import type { RagMatch } from '../extensions/rag.js';

export interface ContextParts {
  baseInstructions: string;
  persistentInstructions?: string;
  historySummary: string;
  skillCatalog: string;
  memories: Memory[];
  documents: RagMatch[];
  plan: PlanStep[];
  goal?: Goal;
  teamSummary?: string;
}

export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return 0;
  const ascii = (text.match(/[\x00-\x7f]/g) ?? []).length;
  return Math.ceil(ascii / 4 + (text.length - ascii) / 1.5);
}

export class ContextManager {
  private readonly historyTokenBudget: number;
  private readonly instructionTokenBudget: number;

  constructor(
    private readonly historyLimit = 40,
    contextWindow = 128_000,
    historyBudgetRatio = 0.55,
  ) {
    this.historyTokenBudget = Math.max(2_000, Math.floor(contextWindow * historyBudgetRatio));
    this.instructionTokenBudget = Math.max(2_000, Math.floor(contextWindow * 0.35));
  }

  readonly sessionInput: SessionInputCallback = async (history, input) => [
    ...this.trimHistory(history),
    ...input,
  ];

  buildInstructions(parts: ContextParts): string {
    const candidates = [parts.baseInstructions];
    if (parts.persistentInstructions) candidates.push(parts.persistentInstructions);
    if (parts.goal) {
      candidates.push([
        `当前长期目标：[${parts.goal.status}] ${parts.goal.objective}`,
        parts.goal.checkpoint ? `检查点：${parts.goal.checkpoint}` : '',
        parts.goal.nextAction ? `下一步：${parts.goal.nextAction}` : '',
      ].filter(Boolean).join('\n'));
    }
    if (parts.plan.length) {
      candidates.push(
        `当前计划：\n${parts.plan.map((step) => `- [${step.status}] ${step.id}. ${step.description}`).join('\n')}`,
      );
    }
    if (parts.teamSummary) candidates.push(`当前 Ultra Team task list：\n${parts.teamSummary}`);
    if (parts.memories.length) {
      candidates.push(
        `与当前问题相关的长期记忆：\n${parts.memories.map((memory) => `- [${memory.type}:${memory.id}] ${memory.content}`).join('\n')}`,
      );
    }
    if (parts.skillCatalog) candidates.push(`可用 Agent Skills（任务匹配时先调用 use_skill）：\n${parts.skillCatalog}`);
    if (parts.documents.length) {
      candidates.push(
        `知识库检索结果（回答时标注来源）：\n${parts.documents.map((match) => `- [${match.source}] ${match.content}`).join('\n')}`,
      );
    }
    if (parts.historySummary) candidates.push(`较早会话的结构化摘要：\n${parts.historySummary}`);

    const sections: string[] = [];
    let remaining = this.instructionTokenBudget;
    for (const candidate of candidates) {
      if (remaining <= 0) break;
      const fitted = this.fitTokens(candidate, remaining);
      if (!fitted) continue;
      sections.push(fitted);
      remaining -= estimateTokens(fitted);
    }
    return this.fitTokens(sections.join('\n\n'), this.instructionTokenBudget);
  }

  summarizeHistory(history: AgentInputItem[]): string {
    const cleaned = history.filter((item) => !this.isGeneratedSummary(item));
    const start = this.historyStart(cleaned);
    return cleaned
      .slice(0, start)
      .map((item) => this.compactItem(item))
      .filter(Boolean)
      .join('\n')
      .slice(-8_000);
  }

  private trimHistory(history: AgentInputItem[]): AgentInputItem[] {
    const cleaned = history.filter((item) => !this.isGeneratedSummary(item));
    return cleaned.slice(this.historyStart(cleaned));
  }

  private historyStart(history: AgentInputItem[]): number {
    const starts = history
      .map((item, index) => this.itemRole(item) === 'user' ? index : -1)
      .filter((index) => index >= 0);
    if (!starts.length) return history.length;
    let start = history.length;
    let tokens = 0;
    let items = 0;
    for (let index = starts.length - 1; index >= 0; index -= 1) {
      const turnStart = starts[index]!;
      const turn = history.slice(turnStart, start);
      const turnTokens = estimateTokens(turn);
      const exceedsItems = items > 0 && items + turn.length > this.historyLimit;
      if (tokens + turnTokens > this.historyTokenBudget || exceedsItems) break;
      start = turnStart;
      tokens += turnTokens;
      items += turn.length;
    }
    return start;
  }

  private compactItem(item: AgentInputItem): string {
    const value = item as unknown as Record<string, unknown>;
    const role = this.itemRole(item);
    const type = typeof value.type === 'string' ? value.type : undefined;
    if (role === 'user' || role === 'assistant') {
      const label = role === 'user' ? '用户' : '助手';
      return `${label}: ${this.extractText(value.content).slice(0, 1_000)}`;
    }
    if (type === 'function_call') {
      return `工具调用: ${String(value.name ?? 'unknown')} ${String(value.arguments ?? '').slice(0, 500)}`;
    }
    if (type === 'function_call_result') {
      return `工具结果: ${String(value.name ?? 'unknown')} ${this.extractText(value.output).slice(0, 700)}`;
    }
    return '';
  }

  private extractText(content: unknown): string {
    if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim();
    if (Array.isArray(content)) return content.map((part) => this.extractText(part)).filter(Boolean).join(' ');
    if (content && typeof content === 'object') {
      const value = content as Record<string, unknown>;
      if (typeof value.text === 'string') return value.text.replace(/\s+/g, ' ').trim();
      return JSON.stringify(content).replace(/\s+/g, ' ').trim();
    }
    return content == null ? '' : String(content);
  }

  private fitTokens(text: string, budget: number): string {
    if (estimateTokens(text) <= budget) return text;
    const suffix = '…';
    const suffixTokens = estimateTokens(suffix);
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (estimateTokens(text.slice(0, middle)) <= Math.max(0, budget - suffixTokens)) low = middle;
      else high = middle - 1;
    }
    return low > 0 ? `${text.slice(0, low).trimEnd()}${suffix}` : '';
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
