import type { Clock } from '@pialy/payments';
import { localDayOf } from '../domain/slots.js';

/**
 * Moves a `confirmed` booking whose slot starts within `day` to `checked_in` atomically and returns
 * the instant. Throws `BookingNotFoundError`, `AlreadyCheckedInError` (first check-in time),
 * `PassNotForTodayError` (confirmed, other day) or `BookingNotConfirmedError`.
 */
export interface CheckInStore {
  checkIn(token: string, at: Date, day: { readonly start: Date; readonly end: Date }): Promise<Date>;
}

/** A pass is valid only on its appointment's local calendar day in the business time zone. */
export function checkIn(
  deps: { readonly store: CheckInStore; readonly clock: Clock },
  token: string,
  timeZone: string,
): Promise<Date> {
  const at = deps.clock.now();
  return deps.store.checkIn(token, at, localDayOf(at, timeZone));
}
