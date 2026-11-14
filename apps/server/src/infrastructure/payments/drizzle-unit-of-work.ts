import type { UnitOfWork } from '@pialy/payments';
import type { Db } from '../db/client.js';
import { sanitized } from '../db/errors.js';
import { createWebhookInbox } from '../webhook-inbox.js';
import { createDrizzlePaymentRepository } from './drizzle-payment-repository.js';
import type { PaymentReaction } from './payment-reaction.js';

export function createDrizzleUnitOfWork(db: Db, reaction: PaymentReaction): UnitOfWork {
  return {
    run(fn) {
      return sanitized(() =>
        db.transaction((tx) =>
          fn({
            payments: createDrizzlePaymentRepository(tx),
            inbox: createWebhookInbox(tx),
            bookingEvents: (event) => reaction(tx, event),
          }),
        ),
      );
    },
  };
}
