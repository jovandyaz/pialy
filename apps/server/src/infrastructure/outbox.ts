import type { DbTx } from './db/client.js';
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
