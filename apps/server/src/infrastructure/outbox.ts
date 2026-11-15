import { asc, inArray, isNull, sql } from 'drizzle-orm';
import type { OutboxStore } from '../modules/realtime/outbox-relay.js';
import type { Db, DbTx } from './db/client.js';
import { sanitized } from './db/errors.js';
import { outbox } from './db/schema.js';

export const BOARD_TOPIC = 'board';

export function bookingTopic(token: string): string {
  return `booking:${token}`;
}

export interface OutboxMessage {
  readonly topic: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Written in the caller's transaction, so a message exists exactly when its change commits. */
export async function enqueueOutbox(tx: DbTx, messages: readonly OutboxMessage[]): Promise<void> {
  if (messages.length === 0) return;
  await tx.insert(outbox).values(messages.map(({ topic, payload }) => ({ topic, payload })));
}

/**
 * Reads by `published_at IS NULL`, not by a position: a row whose transaction commits after a
 * later row was relayed is still found.
 */
export function createDrizzleOutboxStore(db: Db): OutboxStore {
  return {
    unpublished(limit) {
      return sanitized(() =>
        db
          .select({ id: outbox.id, topic: outbox.topic, payload: outbox.payload })
          .from(outbox)
          .where(isNull(outbox.publishedAt))
          .orderBy(asc(outbox.seq))
          .limit(limit),
      );
    },

    async markPublished(ids) {
      if (ids.length === 0) return;
      await sanitized(() => db.update(outbox).set({ publishedAt: sql`now()` }).where(inArray(outbox.id, [...ids])));
    },
  };
}
