import path from 'node:path';
import type { AppConfig } from '../config.js';
import { ExecutionLedger } from '../core/execution-ledger.js';
import { PlanStore } from '../core/plan.js';
import { RunCommitJournal } from '../core/run-commit-journal.js';
import { FileSession } from '../core/session.js';
import { TeamTaskStore } from '../core/team.js';
import { TraceStore } from '../core/trace.js';

export interface SessionStatePort {
  open(sessionId: string, isolated?: boolean): FileSession;
}

export interface GoalPlanStatePort {
  store: PlanStore;
}

export interface TeamStatePort {
  store: TeamTaskStore;
}

export interface ExecutionLedgerPort {
  store: ExecutionLedger;
}

export interface TaskCommitPort {
  acknowledge(sessionId: string, executionKey: string): Promise<void>;
}

export interface RuntimeStatePorts {
  sessions: SessionStatePort;
  goalsAndPlans: GoalPlanStatePort;
  team: TeamStatePort;
  executionLedger: ExecutionLedgerPort;
  runCommits: RunCommitJournal;
  traces: TraceStore;
}

export function createFileRuntimeStatePorts(
  config: Pick<AppConfig, 'dataRoot'>,
  sessionId: string,
): RuntimeStatePorts {
  return {
    sessions: {
      open: (id, isolated = false) => new FileSession(
        path.join(config.dataRoot, isolated ? 'isolated-sessions' : 'sessions'),
        id,
      ),
    },
    goalsAndPlans: { store: new PlanStore(path.join(config.dataRoot, 'plans.json'), sessionId) },
    team: { store: new TeamTaskStore(path.join(config.dataRoot, 'teams.json'), sessionId) },
    executionLedger: {
      store: new ExecutionLedger(path.join(config.dataRoot, 'execution-ledger.json')),
    },
    runCommits: new RunCommitJournal(path.join(config.dataRoot, 'run-commit-journal.json')),
    traces: new TraceStore(path.join(config.dataRoot, 'traces')),
  };
}
