import type { Clock } from '@pialy/payments';

/**
 * Moves a `confirmed` booking to `checked_in` atomically and returns the instant. Throws
 * `BookingNotFoundError`, `BookingNotConfirmedError`, or `AlreadyCheckedInError` (first check-in time).
 */
export interface CheckInStore {
  checkIn(token: string, at: Date): Promise<Date>;
}

export function checkIn(deps: { readonly store: CheckInStore; readonly clock: Clock }, token: string): Promise<Date> {
  return deps.store.checkIn(token, deps.clock.now());
}
