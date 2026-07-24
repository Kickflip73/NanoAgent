import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type {
  AgentMode,
  AgentModel,
  AgentPermissionMode,
  AgentRunObserver,
  AgentRunRequest,
  AgentRunResult,
  AgentSessionSnapshot,
  AppConfig,
  CompletedExecutionReceipt,
  ContextUsageSnapshot,
  HookDiagnostic,
  HostCancelResult,
  HostedAgentRunRequest,
  MimiRunOptions,
  ModelProfile,
  ModelRuntime,
  RunCause,
  RunPolicy,
  RunTrust,
  RuntimeEvent,
  RuntimeHook,
  SubAgentRole,
  SubAgentToolsOptions,
  TeamRole,
  TeamTask,
  TeamTaskInput,
  TeamTaskStatus,
  TeamToolsOptions,
  TeamWorkerResult,
  ToolCapability,
} from '../src/agent.js';
import * as root from '../src/agent.js';
import type {
  AgentModel as OrchestrationAgentModel,
  HookDiagnostic as OrchestrationHookDiagnostic,
  ModelProfile as OrchestrationModelProfile,
  ModelRuntime as OrchestrationModelRuntime,
  RuntimeEvent as OrchestrationRuntimeEvent,
  RuntimeHook as OrchestrationRuntimeHook,
  SubAgentRole as OrchestrationSubAgentRole,
  SubAgentToolsOptions as OrchestrationSubAgentToolsOptions,
  TeamRole as OrchestrationTeamRole,
  TeamTask as OrchestrationTeamTask,
  TeamTaskInput as OrchestrationTeamTaskInput,
  TeamTaskStatus as OrchestrationTeamTaskStatus,
  TeamToolsOptions as OrchestrationTeamToolsOptions,
  TeamWorkerResult as OrchestrationTeamWorkerResult,
  ToolCapability as OrchestrationToolCapability,
} from '../src/orchestration.js';
import * as orchestration from '../src/orchestration.js';

interface PublicApiContract {
  packageVersion: string;
  entrypoints: Record<string, {
    runtimeExports: string[];
    typeExports: string[];
  }>;
}

const ROOT_TYPE_EXPORTS = [
  'AgentMode',
  'AgentModel',
  'AgentPermissionMode',
  'AgentRunObserver',
  'AgentRunRequest',
  'AgentRunResult',
  'AgentSessionSnapshot',
  'AppConfig',
  'CompletedExecutionReceipt',
  'ContextUsageSnapshot',
  'HookDiagnostic',
  'HostCancelResult',
  'HostedAgentRunRequest',
  'MimiRunOptions',
  'ModelProfile',
  'ModelRuntime',
  'RunCause',
  'RunPolicy',
  'RunTrust',
  'RuntimeEvent',
  'RuntimeHook',
  'SubAgentRole',
  'SubAgentToolsOptions',
  'TeamRole',
  'TeamTask',
  'TeamTaskInput',
  'TeamTaskStatus',
  'TeamToolsOptions',
  'TeamWorkerResult',
  'ToolCapability',
] as const;

const ORCHESTRATION_TYPE_EXPORTS = [
  'AgentModel',
  'HookDiagnostic',
  'ModelProfile',
  'ModelRuntime',
  'RuntimeEvent',
  'RuntimeHook',
  'SubAgentRole',
  'SubAgentToolsOptions',
  'TeamRole',
  'TeamTask',
  'TeamTaskInput',
  'TeamTaskStatus',
  'TeamToolsOptions',
  'TeamWorkerResult',
  'ToolCapability',
] as const;

type RootPublicTypes = [
  AgentMode,
  AgentModel,
  AgentPermissionMode,
  AgentRunObserver,
  AgentRunRequest,
  AgentRunResult,
  AgentSessionSnapshot,
  AppConfig,
  CompletedExecutionReceipt,
  ContextUsageSnapshot,
  HookDiagnostic,
  HostCancelResult,
  HostedAgentRunRequest,
  MimiRunOptions,
  ModelProfile,
  ModelRuntime,
  RunCause,
  RunPolicy,
  RunTrust,
  RuntimeEvent,
  RuntimeHook,
  SubAgentRole,
  SubAgentToolsOptions,
  TeamRole,
  TeamTask,
  TeamTaskInput,
  TeamTaskStatus,
  TeamToolsOptions,
  TeamWorkerResult,
  ToolCapability,
];

type OrchestrationPublicTypes = [
  OrchestrationAgentModel,
  OrchestrationHookDiagnostic,
  OrchestrationModelProfile,
  OrchestrationModelRuntime,
  OrchestrationRuntimeEvent,
  OrchestrationRuntimeHook,
  OrchestrationSubAgentRole,
  OrchestrationSubAgentToolsOptions,
  OrchestrationTeamRole,
  OrchestrationTeamTask,
  OrchestrationTeamTaskInput,
  OrchestrationTeamTaskStatus,
  OrchestrationTeamToolsOptions,
  OrchestrationTeamWorkerResult,
  OrchestrationToolCapability,
];

void (null as RootPublicTypes | OrchestrationPublicTypes | null);

const contract = JSON.parse(
  await readFile(new URL('../evals/public-api-contract.json', import.meta.url), 'utf8'),
) as PublicApiContract;
const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

test('public runtime exports match the versioned contract', () => {
  assert.equal(contract.packageVersion, manifest.version);
  assert.deepEqual(Object.keys(root).sort(), contract.entrypoints['.']?.runtimeExports);
  assert.deepEqual(
    Object.keys(orchestration).sort(),
    contract.entrypoints['./orchestration']?.runtimeExports,
  );
});

test('public type contract lists the compile-time compatibility imports', () => {
  assert.deepEqual(contract.entrypoints['.']?.typeExports, ROOT_TYPE_EXPORTS);
  assert.deepEqual(
    contract.entrypoints['./orchestration']?.typeExports,
    ORCHESTRATION_TYPE_EXPORTS,
  );
});
