import type { Clock } from '@pialy/payments';
import { BookingStatus } from '../domain/booking.js';
import { assertIsoDate, generateSlots, localDateOf, type Slot } from '../domain/slots.js';
import type { BookableBusiness } from './business.js';

export type SlotState = 'free' | 'held' | 'taken';

export interface SlotView extends Slot {
  readonly state: SlotState;
}

/** A booking that occupies its range: `holding`, `confirmed` or `checked_in`. */
export interface ActiveBooking {
  readonly during: Slot;
  readonly status: BookingStatus;
}

export interface ActiveBookingsReader {
  activeBookings(resourceId: string, range: Slot): Promise<ActiveBooking[]>;
}

export class PastDateError extends Error {
  override readonly name = 'PastDateError';

  constructor() {
    super('date is before today in the business time zone');
  }
}

export interface GetSlotsDeps {
  readonly bookings: ActiveBookingsReader;
  readonly clock: Clock;
  readonly business: BookableBusiness;
}

/**
 * The slots of a local day that have not started yet, each with whether a booking holds or takes
 * it. Throws {@link InvalidDateError} or {@link PastDateError}.
 */
export async function getSlots(deps: GetSlotsDeps, date: string): Promise<SlotView[]> {
  const { business, clock } = deps;
  assertIsoDate(date);
  const now = clock.now();
  if (date < localDateOf(now, business.timezone)) throw new PastDateError();

  const slots = generateSlots(date, business, business.timezone).filter((slot) => slot.start > now);
  const first = slots[0];
  const last = slots.at(-1);
  if (first === undefined || last === undefined) return [];
  const active = await deps.bookings.activeBookings(business.resourceId, { start: first.start, end: last.end });
  return slots.map((slot) => ({ ...slot, state: stateOf(slot, active) }));
}

function stateOf(slot: Slot, active: readonly ActiveBooking[]): SlotState {
  const overlapping = active.filter((booking) => overlaps(slot, booking.during));
  if (overlapping.some((b) => b.status === BookingStatus.Confirmed || b.status === BookingStatus.CheckedIn)) {
    return 'taken';
  }
  return overlapping.some((b) => b.status === BookingStatus.Holding) ? 'held' : 'free';
}

function overlaps(a: Slot, b: Slot): boolean {
  return a.start < b.end && b.start < a.end;
}
