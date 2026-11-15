import { and, asc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { CheckInStore } from '../../modules/booking/application/check-in.js';
import type { ResolveFlagStore } from '../../modules/booking/application/resolve-flag.js';
import { bankNameOf } from '../../modules/booking/domain/banks.js';
import {
  AlreadyCheckedInError,
  BookingNotConfirmedError,
  BookingNotFoundError,
  BookingStatus,
  FlagNotFoundError,
} from '../../modules/booking/domain/booking.js';
import type { Slot } from '../../modules/booking/domain/slots.js';
import type { Db } from '../db/client.js';
import { sanitized } from '../db/errors.js';
import { bookings, flags } from '../db/schema.js';
import { BOARD_TOPIC, enqueueOutbox } from '../outbox.js';
import { oneOf } from '../payments/drizzle-payment-repository.js';
import { changeBooking } from './drizzle-booking-repository.js';

const ON_BOARD = [BookingStatus.Holding, BookingStatus.Confirmed, BookingStatus.CheckedIn];
const FLAG_RESOLVED = 'flag.resolved';

/**
 * The payer's `bankCode` from the first payment event of the booking's intent, as pey sent it in
 * `metadata.bankCode`. The outer column is written out because Drizzle drops the table qualifier of
 * a single-table select, which would make the subquery compare `pe.intent_id` with itself. Only the code is read; the rest of the raw payload (CLABE) stays in the table.
 */
const payerBankCode = sql<string | null>`(
  select pe.raw #>> '{metadata,bankCode}' from payment_events pe
  where pe.intent_id = bookings.intent_id order by pe.created_at asc, pe.id asc limit 1
)`;

const BOOKING_COLUMNS = {
  token: bookings.token,
  status: bookings.status,
  late: bookings.late,
  slotStart: bookings.slotStart,
  customerName: bookings.customerName,
  phoneLast4: bookings.phoneLast4,
  checkedInAt: bookings.checkedInAt,
  bankCode: payerBankCode,
};

/** What staff may see of a booking: never the full phone, the hash or the CLABE. */
export interface BoardBooking {
  readonly token: string;
  readonly status: BookingStatus;
  readonly late: boolean;
  readonly slotStart: Date;
  readonly customerName: string | null;
  readonly phoneLast4: string;
  readonly bankName: string | null;
  readonly checkedInAt: Date | null;
}

export interface BoardFlag {
  readonly id: string;
  readonly kind: string;
  readonly createdAt: Date;
  readonly reason: string | null;
  readonly paidAt: string | null;
  readonly amount: { readonly amountMinor: number; readonly currency: string } | null;
  readonly expected: { readonly amountMinor: number; readonly currency: string } | null;
  readonly received: { readonly amountMinor: number; readonly currency: string } | null;
  readonly booking: { readonly token: string; readonly customerName: string | null; readonly phoneLast4: string; readonly slotStart: Date } | null;
}

const moneySchema = z.object({ amountMinor: z.number(), currency: z.string() });
/** The slice of a flag payload that is safe and useful on the board. */
const flagPayloadSchema = z.looseObject({
  reason: z.string().nullish(),
  paidAt: z.string().nullish(),
  amount: moneySchema.nullish(),
  expected: moneySchema.nullish(),
  received: moneySchema.nullish(),
});

export interface BoardReader {
  bookingsStartingIn(range: Slot): Promise<BoardBooking[]>;
  openFlags(): Promise<BoardFlag[]>;
  findBooking(token: string): Promise<BoardBooking | null>;
}

export function createDrizzleBoardReader(db: Db): BoardReader {
  return {
    bookingsStartingIn(range) {
      return sanitized(async () => {
        const rows = await db
          .select(BOOKING_COLUMNS)
          .from(bookings)
          .where(and(inArray(bookings.status, ON_BOARD), gte(bookings.slotStart, range.start), lt(bookings.slotStart, range.end)))
          .orderBy(asc(bookings.slotStart));
        return rows.map(toBoardBooking);
      });
    },

    openFlags() {
      return sanitized(async () => {
        const rows = await db
          .select({
            id: flags.id,
            kind: flags.kind,
            createdAt: flags.createdAt,
            payload: flags.payload,
            bookingToken: bookings.token,
            customerName: bookings.customerName,
            phoneLast4: bookings.phoneLast4,
            slotStart: bookings.slotStart,
          })
          .from(flags)
          .leftJoin(bookings, eq(bookings.id, flags.bookingId))
          .where(isNull(flags.resolvedAt))
          .orderBy(asc(flags.createdAt), asc(flags.id));
        return rows.map((row): BoardFlag => {
          const payload = flagPayloadSchema.parse(row.payload);
          return {
            id: row.id,
            kind: row.kind,
            createdAt: row.createdAt,
            reason: payload.reason ?? null,
            paidAt: payload.paidAt ?? null,
            amount: payload.amount ?? null,
            expected: payload.expected ?? null,
            received: payload.received ?? null,
            booking:
              row.bookingToken === null || row.phoneLast4 === null || row.slotStart === null
                ? null
                : { token: row.bookingToken, customerName: row.customerName, phoneLast4: row.phoneLast4, slotStart: row.slotStart },
          };
        });
      });
    },

    findBooking(token) {
      return sanitized(async () => {
        const [row] = await db.select(BOOKING_COLUMNS).from(bookings).where(eq(bookings.token, token)).limit(1);
        return row === undefined ? null : toBoardBooking(row);
      });
    },
  };
}

function toBoardBooking(row: {
  token: string;
  status: string;
  late: boolean;
  slotStart: Date;
  customerName: string | null;
  phoneLast4: string;
  checkedInAt: Date | null;
  bankCode: string | null;
}): BoardBooking {
  return {
    token: row.token,
    status: oneOf(BookingStatus, row.status, 'booking status'),
    late: row.late,
    slotStart: row.slotStart,
    customerName: row.customerName,
    phoneLast4: row.phoneLast4,
    bankName: bankNameOf(row.bankCode),
    checkedInAt: row.checkedInAt,
  };
}

export function createDrizzleCheckInStore(db: Db): CheckInStore {
  return {
    checkIn(token, at) {
      return sanitized(() =>
        db.transaction(async (tx) => {
          // One conditional UPDATE decides the race: only one caller sees the row still `confirmed`.
          const claimed = await changeBooking(
            tx,
            and(eq(bookings.token, token), eq(bookings.status, BookingStatus.Confirmed)),
            { status: BookingStatus.CheckedIn, checkedInAt: at },
          );
          if (claimed === 1) return at;
          const [existing] = await tx
            .select({ status: bookings.status, checkedInAt: bookings.checkedInAt })
            .from(bookings)
            .where(eq(bookings.token, token))
            .limit(1);
          if (existing === undefined) throw new BookingNotFoundError();
          if (existing.status === BookingStatus.CheckedIn && existing.checkedInAt !== null) {
            throw new AlreadyCheckedInError(existing.checkedInAt);
          }
          throw new BookingNotConfirmedError();
        }),
      );
    },
  };
}

export function createDrizzleResolveFlagStore(db: Db): ResolveFlagStore {
  return {
    resolve(flagId, note, at) {
      return sanitized(() =>
        db.transaction(async (tx) => {
          const resolved = await tx
            .update(flags)
            .set({ resolvedAt: at, note })
            .where(and(eq(flags.id, flagId), isNull(flags.resolvedAt)))
            .returning({ id: flags.id });
          if (resolved.length === 0) throw new FlagNotFoundError();
          await enqueueOutbox(tx, [{ topic: BOARD_TOPIC, payload: { type: FLAG_RESOLVED } }]);
        }),
      );
    },
  };
}
