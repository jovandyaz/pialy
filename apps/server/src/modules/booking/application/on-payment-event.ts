import type {
  AttemptExpiredEvent,
  IntentStatus,
  PaymentAmountMismatched,
  PaymentEvent,
  PaymentReceivedEvent,
  UnmatchedPaymentReceived,
} from '@pialy/payments';
import { BookingStatus, RefundReason, decideOnPayment } from '../domain/booking.js';

export interface BookingOfIntent {
  readonly id: string;
  readonly status: BookingStatus;
}

export const FlagKind = {
  UnmatchedPayment: 'unmatched_payment',
  RefundDue: 'refund_due',
  AmountMismatch: 'amount_mismatch',
} as const;
export type FlagKind = (typeof FlagKind)[keyof typeof FlagKind];

/**
 * Booking writes for the reaction, inside the transaction that applied the payment. Every status
 * change also notifies the board and the booking's own page.
 */
export interface BookingPaymentStore {
  /** Locks the intent row and returns its status. Called before any booking row is touched. */
  lockIntent(intentId: string): Promise<IntentStatus | null>;
  /** Locks and returns the booking the intent pays for. */
  bookingOfIntent(intentId: string): Promise<BookingOfIntent | null>;
  confirm(bookingId: string, at: Date, late: boolean): Promise<void>;
  /** Confirms an expired booking as late; `false` when another booking took its slot meanwhile. */
  confirmLateIfFree(bookingId: string, at: Date): Promise<boolean>;
  expire(bookingId: string): Promise<void>;
  flag(kind: FlagKind, bookingId: string | null, payload: Readonly<Record<string, unknown>>): Promise<void>;
}

/** Reacts to a payment event in the transaction that produced it: money confirms or is flagged. */
export async function onPaymentEvent(store: BookingPaymentStore, event: PaymentEvent): Promise<void> {
  switch (event.type) {
    case 'PaymentSucceeded':
    case 'LatePaymentReceived':
    case 'DuplicatePaymentReceived':
      return onPaymentReceived(store, event);
    case 'AttemptExpired':
      return onAttemptExpired(store, event);
    case 'UnmatchedPaymentReceived':
      return store.flag(FlagKind.UnmatchedPayment, null, unmatchedPayload(event));
    case 'PaymentAmountMismatched':
      return onAmountMismatched(store, event);
  }
}

async function onPaymentReceived(store: BookingPaymentStore, event: PaymentReceivedEvent): Promise<void> {
  await store.lockIntent(event.intentId);
  const booking = await store.bookingOfIntent(event.intentId);
  if (booking === null) return refundDue(store, null, event, RefundReason.NoBooking);

  const decision = decideOnPayment(booking.status, event.type);
  switch (decision.action) {
    case 'confirm':
      return store.confirm(booking.id, event.at, decision.late);
    case 'confirm_if_free':
      if (await store.confirmLateIfFree(booking.id, event.at)) return;
      return refundDue(store, booking.id, event, RefundReason.SlotTaken);
    case 'refund_due':
      return refundDue(store, booking.id, event, decision.reason);
  }
}

/** Other attempts of the intent may still be awaiting; only an expired intent ends the hold. */
async function onAttemptExpired(store: BookingPaymentStore, event: AttemptExpiredEvent): Promise<void> {
  const intentStatus = await store.lockIntent(event.intentId);
  if (intentStatus !== 'expired') return;
  const booking = await store.bookingOfIntent(event.intentId);
  if (booking?.status === BookingStatus.Holding) await store.expire(booking.id);
}

async function onAmountMismatched(store: BookingPaymentStore, event: PaymentAmountMismatched): Promise<void> {
  await store.lockIntent(event.intentId);
  const booking = await store.bookingOfIntent(event.intentId);
  await store.flag(FlagKind.AmountMismatch, booking?.id ?? null, {
    providerTxId: event.providerTxId,
    intentId: event.intentId,
    attemptId: event.attemptId,
    expected: event.expected,
    received: event.received,
    amountCheck: event.amountCheck,
    paidAt: event.at.toISOString(),
  });
}

function refundDue(
  store: BookingPaymentStore,
  bookingId: string | null,
  event: PaymentReceivedEvent,
  reason: RefundReason,
): Promise<void> {
  return store.flag(FlagKind.RefundDue, bookingId, {
    reason,
    eventType: event.type,
    providerTxId: event.providerTxId,
    intentId: event.intentId,
    attemptId: event.attemptId,
    amount: event.amount,
    trackingKey: event.trackingKey ?? null,
    paidAt: event.at.toISOString(),
  });
}

function unmatchedPayload(event: UnmatchedPaymentReceived): Record<string, unknown> {
  return {
    providerTxId: event.providerTxId,
    amount: event.amount,
    ref: event.ref,
    trackingKey: event.trackingKey ?? null,
    paidAt: event.at.toISOString(),
  };
}
