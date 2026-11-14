import type { PaymentReceivedEventType } from '@pialy/payments';

export const BookingStatus = {
  Holding: 'holding',
  Confirmed: 'confirmed',
  CheckedIn: 'checked_in',
  Expired: 'expired',
  Canceled: 'canceled',
} as const;
export type BookingStatus = (typeof BookingStatus)[keyof typeof BookingStatus];

/** How long a slot is held while the customer approves the CoDi push; pey's minimum expiration. */
export const HOLD_SECONDS = 360;

/** Another active booking already covers the slot. */
export class SlotTakenError extends Error {
  override readonly name = 'SlotTakenError';

  constructor() {
    super('the slot is already held or booked');
  }
}

export const RefundReason = {
  DuplicatePayment: 'duplicate_payment',
  AlreadyPaid: 'already_paid',
  BookingCanceled: 'booking_canceled',
  SlotTaken: 'slot_taken',
  NoBooking: 'no_booking',
} as const;
export type RefundReason = (typeof RefundReason)[keyof typeof RefundReason];

/**
 * - `confirm`: the booking still holds its slot;
 * - `confirm_if_free`: the hold lapsed, so confirm as late only if no other booking took the slot,
 *   otherwise the money is due back (`slot_taken`);
 * - `refund_due`: keep the booking as it is and flag the money for a manual refund.
 */
export type PaymentDecision =
  | { readonly action: 'confirm'; readonly late: boolean }
  | { readonly action: 'confirm_if_free' }
  | { readonly action: 'refund_due'; readonly reason: RefundReason };

/** What money arriving for a booking does to it. Money never vanishes: it confirms or is flagged. */
export function decideOnPayment(status: BookingStatus, event: PaymentReceivedEventType): PaymentDecision {
  if (event === 'DuplicatePaymentReceived') return refundDue(RefundReason.DuplicatePayment);
  switch (status) {
    case BookingStatus.Holding:
      return { action: 'confirm', late: event === 'LatePaymentReceived' };
    case BookingStatus.Expired:
      return { action: 'confirm_if_free' };
    case BookingStatus.Canceled:
      return refundDue(RefundReason.BookingCanceled);
    case BookingStatus.Confirmed:
    case BookingStatus.CheckedIn:
      return refundDue(RefundReason.AlreadyPaid);
  }
}

function refundDue(reason: RefundReason): PaymentDecision {
  return { action: 'refund_due', reason };
}
