export interface BridgeEvent {
  content?: string;
  body?: string;
  timestamp?: number;
  messageId?: string;
}

export interface BridgeContext {
  channelId?: string;
  accountId?: string;
  senderId?: string;
  conversationId?: string;
  messageId?: string;
}

export function bridgeTarget(accountId: string, recipient: string): string;
export function defaultSocketPath(homeDirectory?: string): string;
export function controlTokenPathForSocket(socketPath: string): string;
export function socketPathFor(
  config?: unknown,
  environment?: Record<string, string | undefined>,
  homeDirectory?: string,
): string;
export function externalIdFor(event: BridgeEvent, context: BridgeContext): string;
export type BridgeSubmitParams = {
  externalId: string;
  source: 'openclaw-weixin';
  kind: 'command';
  profileId: 'owner';
  actor: { id: string };
  conversation: { id: string };
  payload: { text: string; channel: 'weixin' };
  replyRoute: { channel: 'connector:openclaw-weixin'; target: string };
} & (
  | { trust: 'owner'; priority: 100; sessionKey: string }
  | { trust: 'external'; priority: 50; sessionKey?: never }
);
export function submitParams(
  event: BridgeEvent,
  context: BridgeContext,
  ownerSessionId?: string,
): BridgeSubmitParams;
export function rpc(socketPath: string, method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;

declare const plugin: unknown;
export default plugin;
