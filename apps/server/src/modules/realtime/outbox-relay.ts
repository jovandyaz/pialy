import type { SseHub } from './sse-hub.js';

/** Messages read per drain; the relay drains every 500 ms, far above the booking rate. */
export const RELAY_BATCH = 100;
export const RELAY_INTERVAL_MS = 500;

export interface PendingOutboxMessage {
  readonly id: string;
  readonly topic: string;
  readonly payload: unknown;
}

/** Committed outbox messages not yet published. */
export interface OutboxStore {
  /** Oldest first, by insert order. */
  unpublished(limit: number): Promise<PendingOutboxMessage[]>;
  markPublished(ids: readonly string[]): Promise<void>;
}

/** What a live client may see: enough to know what to refetch, nothing about the customer or the money. */
export interface LiveEvent {
  readonly type: string;
  readonly status?: string;
}

export interface OutboxRelay {
  /** Publishes one batch and returns how many messages it held. */
  drainOnce(): Promise<number>;
}

/**
 * Publishes committed outbox messages to the hub, then marks them published: at least once, so a
 * crash in between publishes them again, which refetching clients absorb. Only committed rows are
 * visible to it, so nothing reaches a client before its change commits. With more than one
 * instance each would mark rows the others never published; fan-out then moves to LISTEN/NOTIFY.
 */
export function createOutboxRelay(store: OutboxStore, hub: Pick<SseHub, 'publish'>): OutboxRelay {
  return {
    async drainOnce() {
      const batch = await store.unpublished(RELAY_BATCH);
      if (batch.length === 0) return 0;
      for (const message of batch) hub.publish(message.topic, liveEvent(message.payload));
      await store.markPublished(batch.map((message) => message.id));
      return batch.length;
    },
  };
}

const UNKNOWN_EVENT = 'changed';

function liveEvent(payload: unknown): LiveEvent {
  const fields = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  const type = typeof fields.type === 'string' ? fields.type : UNKNOWN_EVENT;
  return typeof fields.status === 'string' ? { type, status: fields.status } : { type };
}
