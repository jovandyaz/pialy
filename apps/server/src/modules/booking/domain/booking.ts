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

/** Each hold sends a real CoDi push to the number typed, so one phone gets few of them. */
export const PHONE_HOLD_LIMIT = { maxHolds: 3, windowMinutes: 10 } as const;

/** Another active booking already covers the slot. */
export class SlotTakenError extends Error {
  override readonly name = 'SlotTakenError';

  constructor() {
    super('the slot is already held or booked');
  }
}

/** The phone already started {@link PHONE_HOLD_LIMIT} holds inside the window. */
export class TooManyHoldsForPhoneError extends Error {
  override readonly name = 'TooManyHoldsForPhoneError';

  constructor() {
    super('too many holds for this phone in the current window');
  }
}

/** The phone already has a booking in `holding`; it must be paid or expire first. */
export class ActiveHoldExistsError extends Error {
  override readonly name = 'ActiveHoldExistsError';

  constructor() {
    super('this phone already has a hold in progress');
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
