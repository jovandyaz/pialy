import type { UnitOfWork } from '@pialy/payments';
import { DrizzleQueryError } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { createWebhookInbox } from '../webhook-inbox.js';
import { createDrizzlePaymentRepository } from './drizzle-payment-repository.js';
import type { PaymentReaction } from './payment-reaction.js';

/**
 * A failed query without its parameters. Drizzle's own error repeats every parameter in its
 * message, stack and fields, and those hold raw provider payloads with the payer's CLABE.
 */
export class DatabaseQueryError extends Error {
  override readonly name = 'DatabaseQueryError';
  /** Postgres SQLSTATE. */
  readonly code: string | undefined;

  constructor(query: string, cause: unknown) {
    super(`Failed query: ${query}`, { cause });
    this.code = sqlState(cause);
  }
}

export function createDrizzleUnitOfWork(db: Db, reaction: PaymentReaction): UnitOfWork {
  return {
    async run(fn) {
      try {
        return await db.transaction((tx) =>
          fn({
            payments: createDrizzlePaymentRepository(tx),
            inbox: createWebhookInbox(tx),
            bookingEvents: (event) => reaction(tx, event),
          }),
        );
      } catch (error) {
        throw withoutQueryParameters(error);
      }
    },
  };
}

function withoutQueryParameters(error: unknown): unknown {
  return error instanceof DrizzleQueryError ? new DatabaseQueryError(error.query, error.cause) : error;
}

function sqlState(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
  return typeof cause.code === 'string' ? cause.code : undefined;
}
