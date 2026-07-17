export function parseTarget(target: string): { account: string; to: string };

export interface LocalInboundHistoryResult {
  account: string;
  to: string;
  source: 'openclaw-local-session-archive';
  upstreamHistory: false;
  count: number;
  truncated: boolean;
  messages: Array<{ messageId: string; occurredAt: string; text: string }>;
}

export function localInboundHistory(
  target: string,
  payload?: { count?: number },
  env?: NodeJS.ProcessEnv,
): Promise<LocalInboundHistoryResult>;
