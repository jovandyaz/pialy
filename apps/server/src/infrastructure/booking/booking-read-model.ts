import { AttemptMode, AttemptStatus } from '@pialy/payments';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { BookableBusiness } from '../../modules/booking/application/business.js';
import type { ActiveBookingsReader } from '../../modules/booking/application/get-slots.js';
import { BookingStatus } from '../../modules/booking/domain/booking.js';
import type { Slot } from '../../modules/booking/domain/slots.js';
import type { Db } from '../db/client.js';
import { sanitized } from '../db/errors.js';
import { bookings, business, paymentAttempts, paymentEvents, resources } from '../db/schema.js';
import { oneOf } from '../payments/drizzle-payment-repository.js';

const ACTIVE_STATUSES = [BookingStatus.Holding, BookingStatus.Confirmed, BookingStatus.CheckedIn];
const PAID_STATUSES: ReadonlySet<string> = new Set([BookingStatus.Confirmed, BookingStatus.CheckedIn]);

const hoursSchema = z.object({ open: z.string(), close: z.string() });

/** What the customer's booking page shows. Never carries the phone hash. */
export interface BookingView {
  readonly token: string;
  readonly status: BookingStatus;
  readonly late: boolean;
  readonly slot: Slot;
  readonly holdExpiresAt: Date | null;
  readonly attempts: readonly { readonly mode: AttemptMode; readonly status: AttemptStatus }[];
  /** Present once the booking is paid. */
  readonly pass?: { readonly time: Date; readonly phoneLast4: string; readonly trackingKey?: string };
}

/** The single business that takes bookings (seeded), with its first resource. */
export function loadBusiness(db: Db): Promise<BookableBusiness> {
  return sanitized(async () => {
    const [row] = await db
      .select({
        businessId: business.id,
        resourceId: resources.id,
        slotMinutes: business.slotMinutes,
        serviceMinutes: business.serviceMinutes,
        timezone: business.timezone,
        hours: business.hours,
      })
      .from(business)
      .innerJoin(resources, eq(resources.businessId, business.id))
      .orderBy(asc(business.createdAt), asc(resources.createdAt))
      .limit(1);
    if (row === undefined) throw new Error('no business with a resource is configured; run the seed');
    return { ...row, hours: hoursSchema.parse(row.hours) };
  });
}

export function createDrizzleActiveBookingsReader(db: Db): ActiveBookingsReader {
  return {
    activeBookings(resourceId, range) {
      return sanitized(async () => {
        const rows = await db
          .select({ during: bookings.during, status: bookings.status })
          .from(bookings)
          .where(
            and(
              eq(bookings.resourceId, resourceId),
              inArray(bookings.status, ACTIVE_STATUSES),
              sql`${bookings.during} && tstzrange(${range.start.toISOString()}::timestamptz, ${range.end.toISOString()}::timestamptz, '[)')`,
            ),
          );
        return rows.map((row) => ({ during: row.during, status: oneOf(BookingStatus, row.status, 'booking status') }));
      });
    },
  };
}

export function findBookingView(db: Db, token: string): Promise<BookingView | null> {
  return sanitized(async () => {
    const [booking] = await db.select().from(bookings).where(eq(bookings.token, token)).limit(1);
    if (booking === undefined) return null;
    const status = oneOf(BookingStatus, booking.status, 'booking status');
    const intentId = booking.intentId;
    const attempts =
      intentId === null
        ? []
        : await db
            .select({ mode: paymentAttempts.mode, status: paymentAttempts.status })
            .from(paymentAttempts)
            .where(eq(paymentAttempts.intentId, intentId))
            .orderBy(asc(paymentAttempts.createdAt), asc(paymentAttempts.id));
    const view: BookingView = {
      token: booking.token,
      status,
      late: booking.late,
      slot: booking.during,
      holdExpiresAt: booking.holdExpiresAt,
      attempts: attempts.map((a) => ({
        mode: oneOf(AttemptMode, a.mode, 'attempt mode'),
        status: oneOf(AttemptStatus, a.status, 'attempt status'),
      })),
    };
    if (!PAID_STATUSES.has(status)) return view;
    const trackingKey = intentId === null ? undefined : await firstTrackingKey(db, intentId);
    return {
      ...view,
      pass: {
        time: booking.slotStart,
        phoneLast4: booking.phoneLast4,
        ...(trackingKey === undefined ? {} : { trackingKey }),
      },
    };
  });
}

async function firstTrackingKey(db: Db, intentId: string): Promise<string | undefined> {
  const [event] = await db
    .select({ trackingKey: paymentEvents.trackingKey })
    .from(paymentEvents)
    .where(eq(paymentEvents.intentId, intentId))
    .orderBy(asc(paymentEvents.createdAt))
    .limit(1);
  return event?.trackingKey ?? undefined;
}
