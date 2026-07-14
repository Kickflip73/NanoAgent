import type { AgentInputItem, SessionInputCallback } from '@openai/agents';
import type { Memory } from './memory.js';
import type { Goal, PlanStep } from './plan.js';
import type { RagMatch } from '../extensions/rag.js';
import type { ContextArchive } from './session.js';

export interface ContextParts {
  baseInstructions: string;
  sessionState?: string;
  persistentInstructions?: string;
  historySummary: string;
  skillCatalog: string;
  memories: Memory[];
  documents: RagMatch[];
  plan: PlanStep[];
  goal?: Goal;
  teamSummary?: string;
  recoverySummary?: string;
}

export interface ContextStats {
  rawTokens: number;
  effectiveTokens: number;
  archiveTokens: number;
  coveredItems: number;
  strategies: string[];
}

export interface RequestBudget {
  contextWindow: number;
  outputReserveTokens: number;
  toolSchemaTokens: number;
  inputBudget: number;
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
  private readonly contextWindow: number;

  constructor(
    private readonly historyLimit = 40,
    contextWindow = 128_000,
    historyBudgetRatio = 0.55,
    private readonly outputReserveTokens = Math.max(4_096, Math.floor(contextWindow * 0.1)),
  ) {
    this.contextWindow = contextWindow;
    this.historyTokenBudget = Math.max(2_000, Math.floor(contextWindow * historyBudgetRatio));
    this.instructionTokenBudget = Math.max(2_000, Math.floor(contextWindow * 0.35));
  }

  requestBudget(toolSchemas: unknown): RequestBudget {
    const estimatedSchemas = estimateTokens(toolSchemas);
    // Covers provider/SDK message wrappers and MCP tools whose schemas are resolved lazily.
    const protocolReserve = Math.max(1_000, Math.floor(this.contextWindow * 0.02));
    const toolSchemaTokens = estimatedSchemas + protocolReserve;
    const inputBudget = this.contextWindow - this.outputReserveTokens - toolSchemaTokens;
    if (inputBudget < 256) throw new Error('模型上下文窗口不足以容纳工具定义和输出预留');
    return {
      contextWindow: this.contextWindow,
      outputReserveTokens: this.outputReserveTokens,
      toolSchemaTokens,
      inputBudget,
    };
  }

  readonly sessionInput: SessionInputCallback = async (history, input) => this.effectiveHistory(history, input);

  inputCallback(archive?: ContextArchive, tokenBudget?: number): SessionInputCallback {
    return async (history, input) => this.effectiveHistory(history, input, archive, tokenBudget);
  }

  effectiveHistory(
    history: AgentInputItem[],
    input: AgentInputItem[],
    archive?: ContextArchive,
    tokenBudget = this.historyTokenBudget,
  ): AgentInputItem[] {
    const start = archive && archive.coveredItems <= history.length ? archive.coveredItems : 0;
    const visible = this.microcompact(history.slice(start));
    const fittedInput = this.fitInput(input, tokenBudget);
    const historyBudget = Math.max(0, tokenBudget - estimateTokens(fittedInput));
    return [...this.trimHistory(visible, historyBudget), ...fittedInput];
  }

  compactArchive(
    history: AgentInputItem[],
    previous?: ContextArchive,
    strategy: ContextArchive['strategy'] = 'collapse',
  ): ContextArchive | undefined {
    const previousCovered = previous && previous.coveredItems <= history.length ? previous.coveredItems : 0;
    const uncovered = history.slice(previousCovered);
    const shouldCollapse = uncovered.length > this.historyLimit || estimateTokens(uncovered) > this.historyTokenBudget;
    if (strategy === 'collapse' && !shouldCollapse) return previous;

    const cutoff = strategy === 'full'
      ? this.startOfRecentTurns(history, 2)
      : previousCovered + this.historyStart(this.microcompact(uncovered));
    if (cutoff <= previousCovered) return previous;

    const addition = history.slice(previousCovered, cutoff)
      .map((item) => this.compactItem(item))
      .filter(Boolean)
      .join('\n');
    if (!addition) return previous;
    const summary = this.mergeSummary(previousCovered ? previous?.summary ?? '' : '', addition);
    return {
      coveredItems: cutoff,
      summary,
      strategy,
      originalTokens: (previousCovered ? previous?.originalTokens ?? 0 : 0) + estimateTokens(history.slice(previousCovered, cutoff)),
      compactedTokens: estimateTokens(summary),
      updatedAt: new Date().toISOString(),
    };
  }

  stats(history: AgentInputItem[], effective: AgentInputItem[], archive?: ContextArchive, inputItems = 0): ContextStats {
    const strategies: string[] = [];
    if (archive?.coveredItems) strategies.push(archive.strategy === 'full' ? 'full-compact' : 'context-collapse');
    const visible = history.slice(archive?.coveredItems ?? 0);
    if (JSON.stringify(this.microcompact(visible)) !== JSON.stringify(visible)) strategies.push('microcompact');
    if (effective.length < visible.length + inputItems) strategies.push('ptl-truncation');
    return {
      rawTokens: estimateTokens(history),
      effectiveTokens: estimateTokens(effective),
      archiveTokens: archive?.compactedTokens ?? 0,
      coveredItems: archive?.coveredItems ?? 0,
      strategies,
    };
  }

  buildInstructions(parts: ContextParts, tokenBudget = this.instructionTokenBudget): string {
    const candidates = [parts.baseInstructions];
    if (parts.sessionState) candidates.push(`当前会话状态：\n${parts.sessionState}`);
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
    if (parts.recoverySummary) candidates.push(`最近一次未完成运行：\n${parts.recoverySummary}`);
    if (parts.historySummary) candidates.push(`较早会话的结构化摘要：\n${parts.historySummary}`);
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

    const sections: string[] = [];
    let remaining = Math.max(0, tokenBudget);
    for (const candidate of candidates) {
      if (remaining <= 0) break;
      const fitted = this.fitTokens(candidate, remaining);
      if (!fitted) continue;
      sections.push(fitted);
      remaining -= estimateTokens(fitted);
    }
    return this.fitTokens(sections.join('\n\n'), Math.max(0, tokenBudget));
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

  private trimHistory(history: AgentInputItem[], tokenBudget = this.historyTokenBudget): AgentInputItem[] {
    const cleaned = history.filter((item) => !this.isGeneratedSummary(item));
    return cleaned.slice(this.historyStart(cleaned, tokenBudget));
  }

  private microcompact(history: AgentInputItem[]): AgentInputItem[] {
    const starts = history
      .map((item, index) => this.itemRole(item) === 'user' ? index : -1)
      .filter((index) => index >= 0);
    const keepFullFrom = starts.length > 2 ? starts.at(-2)! : 0;
    return history.map((item, index) => {
      const value = item as unknown as Record<string, unknown>;
      if (index >= keepFullFrom || value.type !== 'function_call_result') return item;
      const output = this.extractText(value.output);
      if (output.length <= 800) return item;
      return {
        ...value,
        output: `[较早工具结果已压缩，原始内容保存在 Session] ${output.slice(0, 760)}...`,
      } as unknown as AgentInputItem;
    });
  }

  private historyStart(history: AgentInputItem[], tokenBudget = this.historyTokenBudget): number {
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
      if (tokens + turnTokens > tokenBudget || exceedsItems) break;
      start = turnStart;
      tokens += turnTokens;
      items += turn.length;
    }
    return start;
  }

  private fitInput(input: AgentInputItem[], tokenBudget: number): AgentInputItem[] {
    if (estimateTokens(input) <= tokenBudget) return input;
    if (!input.length || tokenBudget <= 0) return [];
    const last = input.at(-1)!;
    if ('role' in last && last.role === 'user' && 'content' in last && typeof last.content === 'string') {
      const empty = { ...last, content: '' } as AgentInputItem;
      const contentBudget = Math.max(0, tokenBudget - estimateTokens([empty]));
      return [{ ...last, content: this.fitTokens(last.content, contentBudget) } as AgentInputItem];
    }
    return estimateTokens([last]) <= tokenBudget ? [last] : [];
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

  private startOfRecentTurns(history: AgentInputItem[], count: number): number {
    const starts = history
      .map((item, index) => this.itemRole(item) === 'user' ? index : -1)
      .filter((index) => index >= 0);
    return starts.length > count ? starts[starts.length - count]! : 0;
  }

  private mergeSummary(previous: string, addition: string): string {
    const merged = [previous, addition].filter(Boolean).join('\n');
    const limit = Math.min(16_000, Math.floor(this.contextWindow * 0.08));
    if (merged.length <= limit) return merged;
    const head = Math.floor(limit * 0.3);
    const tail = limit - head - 32;
    return `${merged.slice(0, head)}\n...[中间归档已省略]...\n${merged.slice(-tail)}`;
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
