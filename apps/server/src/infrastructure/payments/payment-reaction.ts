import type { PaymentEvent, PaymentReceivedEvent } from '@pialy/payments';
import { and, eq } from 'drizzle-orm';
import type { DbTx } from '../db/client.js';
import { bookings, flags } from '../db/schema.js';
import { BOARD_TOPIC, bookingTopic, enqueueOutbox } from '../outbox.js';

/** Runs inside the unit of work that applied the payment. */
export type PaymentReaction = (tx: DbTx, event: PaymentEvent) => Promise<void>;

const BOOKING_UPDATED = 'booking.updated';

/**
 * Interim booking policy: only an on-time payment confirms a held booking. Late and duplicate
 * payments are already recorded in `payment_events`; deciding confirm vs refund is not wired yet.
 */
export const paymentReaction: PaymentReaction = async (tx, event) => {
  switch (event.type) {
    case 'PaymentSucceeded':
      return confirmHeldBooking(tx, event);
    case 'UnmatchedPaymentReceived':
      await tx.insert(flags).values({
        kind: 'unmatched_payment',
        payload: {
          providerTxId: event.providerTxId,
          amount: event.amount,
          ref: event.ref,
          trackingKey: event.trackingKey ?? null,
          paidAt: event.at.toISOString(),
        },
      });
      return;
    case 'PaymentAmountMismatched':
      await tx.insert(flags).values({
        kind: 'amount_mismatch',
        bookingId: await bookingIdOfIntent(tx, event.intentId),
        payload: {
          providerTxId: event.providerTxId,
          intentId: event.intentId,
          attemptId: event.attemptId,
          expected: event.expected,
          received: event.received,
          amountCheck: event.amountCheck,
          paidAt: event.at.toISOString(),
        },
      });
      return;
    case 'LatePaymentReceived':
    case 'DuplicatePaymentReceived':
    case 'AttemptExpired':
      return;
  }
};

async function confirmHeldBooking(tx: DbTx, event: PaymentReceivedEvent): Promise<void> {
  const confirmed = await tx
    .update(bookings)
    .set({ status: 'confirmed', confirmedAt: event.at })
    .where(and(eq(bookings.intentId, event.intentId), eq(bookings.status, 'holding')))
    .returning({ token: bookings.token, status: bookings.status });
  await enqueueOutbox(
    tx,
    confirmed.flatMap(({ token, status }) => {
      const payload = { type: BOOKING_UPDATED, token, status };
      return [
        { topic: BOARD_TOPIC, payload },
        { topic: bookingTopic(token), payload },
      ];
    }),
  );
}

async function bookingIdOfIntent(tx: DbTx, intentId: string): Promise<string | null> {
  const [booking] = await tx.select({ id: bookings.id }).from(bookings).where(eq(bookings.intentId, intentId)).limit(1);
  return booking?.id ?? null;
}
