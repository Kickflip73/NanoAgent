import type { RuntimeEffect } from '../control.js';

export interface RunCommitUsage {
  lastRequestInputTokens?: number;
  lastRequestOutputTokens?: number;
  runInputTokens?: number;
  runOutputTokens?: number;
  runTotalTokens?: number;
}

export interface RunCommitInput {
  answer: string;
  usage?: RunCommitUsage;
}

export interface RunFailureInput {
  error: unknown;
  interrupted: boolean;
  usage?: RunCommitUsage;
}

export interface RunCommitCoordinatorPort {
  complete(answer: string, usage?: RunCommitUsage): Promise<RuntimeEffect[]>;
  fail(error: unknown, interrupted: boolean, usage?: RunCommitUsage): Promise<void>;
}

export class RunCommitCoordinator {
  constructor(private readonly port: RunCommitCoordinatorPort) {}

  complete(input: RunCommitInput): Promise<RuntimeEffect[]> {
    return this.port.complete(input.answer, input.usage);
  }

  fail(input: RunFailureInput): Promise<void> {
    return this.port.fail(input.error, input.interrupted, input.usage);
  }
}
