import type { ComputerAccess } from '../../extensions/computer/types.js';
import type { ToolCapability } from '../tool-policy.js';
import type { RunScope } from './run-scope.js';

export interface CapabilityPolicy {
  allowedCapabilities: readonly ToolCapability[];
  allowedTools?: readonly string[];
  allowSessionContext?: boolean;
  computerAccess?: ComputerAccess;
}

export interface CapabilityResolverInput {
  scope: RunScope;
  policy?: CapabilityPolicy;
  requestedComputerAccess?: ComputerAccess;
  defaultComputerAccess?: ComputerAccess;
  developmentTask: boolean;
  expectedArtifactCompletion: boolean;
}

export interface ResolvedCapabilities {
  canReadLocal: boolean;
  canReadMemory: boolean;
  canReadState: boolean;
  canReadSessionContext: boolean;
  canInitializeProjectGuidance: boolean;
  completionToolsAllowed: boolean;
  computerAccess: ComputerAccess;
}

export class CapabilityResolver {
  resolve(input: CapabilityResolverInput): Readonly<ResolvedCapabilities> {
    const allowed = new Set(input.policy?.allowedCapabilities ?? []);
    const canReadLocal = !input.policy || allowed.has('read');
    const executableCompletion = input.scope.mode !== 'plan'
      && !(input.scope.permissionMode === 'read-only' && input.expectedArtifactCompletion);
    const completionToolsAllowed = executableCompletion
      && (!input.policy || allowed.has('state-read'))
      && (!input.policy?.allowedTools
        || (input.policy.allowedTools.includes('prepare_task')
          && input.policy.allowedTools.includes('finish_task')));
    return Object.freeze({
      canReadLocal,
      canReadMemory: !input.policy || allowed.has('memory-read'),
      canReadState: !input.policy || allowed.has('state-read'),
      canReadSessionContext: input.policy?.allowSessionContext !== false,
      canInitializeProjectGuidance: canReadLocal
        && input.scope.mode !== 'plan'
        && input.scope.permissionMode !== 'read-only'
        && (!input.policy || allowed.has('write'))
        && input.developmentTask,
      completionToolsAllowed,
      computerAccess: input.requestedComputerAccess
        ?? input.policy?.computerAccess
        ?? (input.scope.cause ? 'none' : input.defaultComputerAccess ?? 'none'),
    });
  }
}
