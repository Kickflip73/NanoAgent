import type { AgentInputItem } from '@openai/agents';
import type { GuidanceSnapshot } from '../../core/guidance.js';
import type { MemoryCard } from '../../core/memory.js';
import type { Goal, PlanStep } from '../../core/plan.js';
import type { ContextArchive } from '../../core/session.js';
import type { ResolvedCapabilities } from './capability-resolver.js';

export interface RunStateLoaderDependencies {
  hotProfile: () => Promise<MemoryCard[]>;
  searchMemories: () => Promise<MemoryCard[]>;
  loadPlan: () => Promise<PlanStep[]>;
  loadGoal: () => Promise<Goal | undefined>;
  loadTeamSummary: () => Promise<string>;
  loadHistory: () => Promise<AgentInputItem[]>;
  loadSoul: () => Promise<GuidanceSnapshot>;
  loadProjectGuidance: () => Promise<GuidanceSnapshot>;
  loadArchive: () => Promise<ContextArchive | undefined>;
}

export interface RunStateSnapshot {
  readonly memories: readonly MemoryCard[];
  readonly plan: readonly PlanStep[];
  readonly storedGoal?: Readonly<Goal>;
  readonly teamSummary: string;
  readonly history: readonly AgentInputItem[];
  readonly soul: Readonly<GuidanceSnapshot>;
  readonly projectGuidance: Readonly<GuidanceSnapshot>;
  readonly storedArchive?: Readonly<ContextArchive>;
}

const EMPTY_GUIDANCE: GuidanceSnapshot = Object.freeze({ instructions: '', files: [] });

export class RunStateLoader {
  constructor(private readonly dependencies: RunStateLoaderDependencies) {}

  async load(
    capabilities: ResolvedCapabilities,
    developmentTask: boolean,
  ): Promise<RunStateSnapshot> {
    const [
      hotProfile,
      memoryCards,
      plan,
      storedGoal,
      teamSummary,
      history,
      soul,
      projectGuidance,
      storedArchive,
    ] = await Promise.all([
      capabilities.canReadMemory ? this.dependencies.hotProfile() : Promise.resolve([]),
      capabilities.canReadMemory ? this.dependencies.searchMemories() : Promise.resolve([]),
      capabilities.canReadState ? this.dependencies.loadPlan() : Promise.resolve([]),
      capabilities.canReadState ? this.dependencies.loadGoal() : Promise.resolve(undefined),
      capabilities.canReadState ? this.dependencies.loadTeamSummary() : Promise.resolve(''),
      capabilities.canReadSessionContext ? this.dependencies.loadHistory() : Promise.resolve([]),
      capabilities.canReadLocal ? this.dependencies.loadSoul() : Promise.resolve(EMPTY_GUIDANCE),
      capabilities.canReadLocal && developmentTask
        ? this.dependencies.loadProjectGuidance()
        : Promise.resolve(EMPTY_GUIDANCE),
      capabilities.canReadSessionContext ? this.dependencies.loadArchive() : Promise.resolve(undefined),
    ]);
    const memories = [...hotProfile, ...memoryCards]
      .filter((memory, index, all) => all.findIndex((candidate) => (
        candidate.ref.scope === memory.ref.scope && candidate.ref.id === memory.ref.id
      )) === index)
      .slice(0, 13);
    return Object.freeze({
      memories: Object.freeze(memories),
      plan: Object.freeze(plan),
      storedGoal: storedGoal ? Object.freeze({ ...storedGoal }) : undefined,
      teamSummary,
      history: Object.freeze(history),
      soul: Object.freeze(soul),
      projectGuidance: Object.freeze(projectGuidance),
      storedArchive: storedArchive ? Object.freeze({ ...storedArchive }) : undefined,
    });
  }
}
