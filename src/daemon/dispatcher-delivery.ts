import {
  isPermanentDeliveryError,
  isUncertainDeliveryError,
  NotifierRegistry,
} from './notifier.js';
import type { MimiStore } from './store.js';
import type { OutboxMessage, ReplyRoute } from './types.js';

export class OutboxDeliveryCoordinator {
  private readonly deliveries = new Map<string, { route: ReplyRoute; promise: Promise<void> }>();

  constructor(
    private readonly store: MimiStore,
    private readonly notifier: NotifierRegistry,
    private readonly workerId: string,
    private readonly concurrency = 4,
  ) {}

  async waitForAll(): Promise<void> {
    await Promise.all([...this.deliveries.values()].map((delivery) => delivery.promise));
  }

  async deliverOne(): Promise<boolean> {
    const delivery = this.start();
    if (delivery) {
      await delivery;
      return true;
    }
    const inFlight = this.deliveries.values().next().value as
      | { route: ReplyRoute; promise: Promise<void> }
      | undefined;
    if (!inFlight) return false;
    await inFlight.promise;
    return true;
  }

  start(): Promise<void> | undefined {
    if (this.deliveries.size >= this.concurrency) return undefined;
    const outgoing = this.store.claimOutbox(
      this.workerId,
      undefined,
      undefined,
      [...this.deliveries.values()].map((delivery) => delivery.route),
    );
    if (!outgoing) return undefined;
    let tracked!: Promise<void>;
    tracked = this.deliverClaimed(outgoing)
      .catch((error) => {
        process.stderr.write(
          `[MimiAgent] outbox ${outgoing.id} error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      })
      .finally(() => {
        const routeKey = JSON.stringify([outgoing.channel, outgoing.target ?? '']);
        if (this.deliveries.get(routeKey)?.promise === tracked) {
          this.deliveries.delete(routeKey);
        }
      });
    const route = { channel: outgoing.channel, ...(outgoing.target ? { target: outgoing.target } : {}) };
    this.deliveries.set(JSON.stringify([outgoing.channel, outgoing.target ?? '']), { route, promise: tracked });
    return tracked;
  }

  private async deliverClaimed(outgoing: OutboxMessage): Promise<void> {
    try {
      await this.notifier.deliver(outgoing);
    } catch (error) {
      this.store.failOutbox(
        outgoing.id,
        this.workerId,
        error,
        isUncertainDeliveryError(error) || isPermanentDeliveryError(error) ? 1 : 8,
      );
      return;
    }
    try {
      this.store.completeOutbox(outgoing.id, this.workerId);
    } catch (error) {
      // The external sink already confirmed success. Leaving the message in its
      // sending lease makes recovery dead-letter it instead of redelivering it.
      process.stderr.write(
        `[MimiAgent] outbox ${outgoing.id} 已送达但本地确认失败，将停止自动重发：${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}
