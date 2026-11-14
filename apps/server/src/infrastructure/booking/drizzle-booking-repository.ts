import { AttemptStatus, IntentStatus, failAttempt, type AttemptMatch, type PaymentRepository } from '@pialy/payments';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  HOLD_SCOPE,
  HoldStatus,
  IdempotencyKeyInFlightError,
  IdempotencyKeyReusedError,
  type BeganHold,
  type HoldRef,
  type HoldRepository,
  type HoldResponse,
  type NewHold,
} from '../../modules/booking/application/hold-slot.js';
import type { BookingOfIntent, BookingPaymentStore } from '../../modules/booking/application/on-payment-event.js';
import { BookingStatus, SlotTakenError } from '../../modules/booking/domain/booking.js';
import type { Db, DbTx } from '../db/client.js';
import { SqlState, sanitized, violates, withoutQueryParameters } from '../db/errors.js';
import { bookings, flags, paymentAttempts, paymentIntents } from '../db/schema.js';
import { claimKey, finishKey, lockKey, reachRecoveryPoint, type KeyRef, type StoredResponse } from '../idempotency.js';
import { BOARD_TOPIC, bookingTopic, enqueueOutbox, type OutboxMessage } from '../outbox.js';
import { createDrizzlePaymentRepository, oneOf } from '../payments/drizzle-payment-repository.js';

const NO_OVERLAP_CONSTRAINT = 'bookings_no_overlap';
const HOLD_CREATED = 'hold_created';
const BOOKING_UPDATED = 'booking.updated';
/** Fetching two rows is enough to tell a unique match from an ambiguous one. */
const AMBIGUITY_PROBE = 2;

const heldBodySchema = z.object({ token: z.string().min(1), holdExpiresAt: z.string().min(1) });
const pushFailedSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.literal(HoldStatus.PushFailed),
  detail: z.string(),
});

/**
 * Lock order everywhere: idempotency key, then payment intent, then booking, then the resource's
 * slot lock. Webhooks lock the intent first and never a key, so the two paths cannot deadlock.
 */
export function createDrizzleHoldRepository(db: Db): HoldRepository {
  return {
    async begin(hold) {
      try {
        return await db.transaction((tx) => begin(tx, hold));
      } catch (error) {
        if (violates(error, SqlState.ExclusionViolation, NO_OVERLAP_CONSTRAINT)) throw new SlotTakenError();
        throw withoutQueryParameters(error);
      }
    },

    recordPush(hold, charge) {
      return sanitized(() =>
        db.transaction(async (tx) => {
          const ref = keyOf(hold);
          const key = await lockKey(tx, ref);
          const payments = createDrizzlePaymentRepository(tx);
          const { attempt } = await attemptOf(payments, hold);
          // A webhook matched by attemptId may have stored the transaction id first; both name one transaction.
          await payments.saveAttempt({
            ...attempt,
            provider: {
              ...attempt.provider,
              transactionId: attempt.provider.transactionId ?? charge.transactionId,
              codiId: charge.codiId,
            },
          });
          if (key.response !== null) return toHoldResponse(key.response);
          return finish(tx, ref, stagedResponse(key.staged));
        }),
      );
    },

    failPush(hold, failed) {
      return sanitized(() =>
        db.transaction(async (tx) => {
          const ref = keyOf(hold);
          const key = await lockKey(tx, ref);
          if (key.response !== null) return toHoldResponse(key.response);
          const payments = createDrizzlePaymentRepository(tx);
          const match = await attemptOf(payments, hold);
          const otherAwaiting = await payments.hasOtherAwaiting(match.intent.id, match.attempt.id);
          const { intent, attempt } = failAttempt(match.intent, match.attempt, otherAwaiting);
          await payments.saveIntent(intent);
          await payments.saveAttempt(attempt);
          if (match.attempt.status === AttemptStatus.Awaiting) {
            await changeBooking(tx, bookingIn(hold.bookingId, BookingStatus.Holding), { status: BookingStatus.Expired });
          }
          const paid = match.attempt.status === AttemptStatus.Succeeded;
          return finish(tx, ref, paid ? stagedResponse(key.staged) : failed);
        }),
      );
    },
  };
}

/** The reaction's writes; runs inside the payments unit of work, which sanitizes its errors. */
export function createDrizzleBookingPaymentStore(tx: DbTx): BookingPaymentStore {
  return {
    async lockIntent(intentId) {
      const [row] = await tx
        .select({ status: paymentIntents.status })
        .from(paymentIntents)
        .where(eq(paymentIntents.id, intentId))
        .for('update');
      return row === undefined ? null : oneOf(IntentStatus, row.status, 'intent status');
    },

    async bookingOfIntent(intentId) {
      const rows = await tx
        .select({ id: bookings.id, status: bookings.status })
        .from(bookings)
        .where(eq(bookings.intentId, intentId))
        .limit(AMBIGUITY_PROBE)
        .for('update');
      if (rows.length > 1) throw new Error(`more than one booking is paid by intent ${intentId}`);
      const [row] = rows;
      return row === undefined
        ? null
        : ({ id: row.id, status: oneOf(BookingStatus, row.status, 'booking status') } satisfies BookingOfIntent);
    },

    async confirm(bookingId, at, late) {
      await lockSlotsOfBooking(tx, bookingId);
      await changeOneBooking(tx, bookingIn(bookingId, BookingStatus.Holding), {
        status: BookingStatus.Confirmed,
        confirmedAt: at,
        late,
      });
    },

    async confirmLateIfFree(bookingId, at) {
      await lockSlotsOfBooking(tx, bookingId);
      try {
        // A savepoint: an exclusion violation must undo only this update, so the payment still commits.
        await tx.transaction((savepoint) =>
          changeOneBooking(savepoint, bookingIn(bookingId, BookingStatus.Expired), {
            status: BookingStatus.Confirmed,
            confirmedAt: at,
            late: true,
          }),
        );
        return true;
      } catch (error) {
        if (violates(error, SqlState.ExclusionViolation, NO_OVERLAP_CONSTRAINT)) return false;
        throw error;
      }
    },

    async expire(bookingId) {
      await changeOneBooking(tx, bookingIn(bookingId, BookingStatus.Holding), { status: BookingStatus.Expired });
    },

    async flag(kind, bookingId, payload) {
      await tx.insert(flags).values({ kind, bookingId, payload });
    },
  };
}

async function begin(tx: DbTx, hold: NewHold): Promise<BeganHold> {
  const ref: KeyRef = { key: hold.idempotencyKey, scope: HOLD_SCOPE };
  const claim = await claimKey(tx, ref, hold.requestHash, hold.now, hold.staleBefore);
  switch (claim.kind) {
    case 'mismatch':
      throw new IdempotencyKeyReusedError();
    case 'in_flight':
      throw new IdempotencyKeyInFlightError();
    case 'finished':
      return { kind: 'replay', response: toHoldResponse(claim.response) };
    case 'abandoned':
      return { kind: 'abandoned', hold: await abandonedHold(tx, hold.idempotencyKey, claim.recoveryPoint, claim.staged) };
    case 'claimed':
      return createHold(tx, ref, hold);
  }
}

async function createHold(tx: DbTx, ref: KeyRef, hold: NewHold): Promise<BeganHold> {
  const { intent, attempt, booking, slot, business } = hold;
  await lockSlotsOfResource(tx, business.resourceId);
  await tx.insert(paymentIntents).values({
    id: intent.id,
    reference: intent.reference,
    amountMinor: intent.amount.amountMinor,
    currency: intent.amount.currency,
    status: intent.status,
  });
  const [created] = await tx
    .insert(bookings)
    .values({
      id: booking.id,
      token: booking.token,
      businessId: business.businessId,
      resourceId: business.resourceId,
      intentId: intent.id,
      slotStart: slot.start,
      during: slot,
      status: BookingStatus.Holding,
      customerName: booking.customerName,
      phoneLast4: booking.phoneLast4,
      phoneHash: booking.phoneHash,
      holdExpiresAt: booking.holdExpiresAt,
    })
    .returning({ number: bookings.number, token: bookings.token, status: bookings.status, late: bookings.late });
  if (created === undefined) throw new Error('booking insert returned no row');
  await tx.insert(paymentAttempts).values({
    id: attempt.id,
    intentId: attempt.intentId,
    mode: attempt.mode,
    status: attempt.status,
    expiresAt: attempt.expiresAt,
  });
  await enqueueOutbox(tx, bookingUpdated(created));
  await reachRecoveryPoint(tx, ref, HOLD_CREATED, hold.response.body);
  return {
    kind: 'started',
    hold: { idempotencyKey: hold.idempotencyKey, bookingId: booking.id, attemptId: attempt.id },
    bookingNumber: created.number,
  };
}

async function abandonedHold(tx: DbTx, idempotencyKey: string, recoveryPoint: string | null, staged: unknown): Promise<HoldRef> {
  if (recoveryPoint !== HOLD_CREATED) throw new Error(`cannot resume a hold from recovery point ${recoveryPoint}`);
  const { token } = heldBodySchema.parse(staged);
  const [row] = await tx
    .select({ bookingId: bookings.id, attemptId: paymentAttempts.id })
    .from(bookings)
    .innerJoin(paymentAttempts, eq(paymentAttempts.intentId, bookings.intentId))
    .where(eq(bookings.token, token))
    .orderBy(asc(paymentAttempts.createdAt))
    .limit(1);
  if (row === undefined) throw new Error('an abandoned hold has no booking with an attempt');
  return { idempotencyKey, ...row };
}

async function attemptOf(payments: PaymentRepository, hold: HoldRef): Promise<AttemptMatch> {
  const match = await payments.findAttemptByRef({ attemptId: hold.attemptId });
  if (match === null) throw new Error(`attempt ${hold.attemptId} of a hold does not exist`);
  return match;
}

async function finish(tx: DbTx, ref: KeyRef, response: HoldResponse): Promise<HoldResponse> {
  const normalized = toHoldResponse(response);
  await finishKey(tx, ref, normalized);
  return normalized;
}

function keyOf(hold: HoldRef): KeyRef {
  return { key: hold.idempotencyKey, scope: HOLD_SCOPE };
}

function stagedResponse(staged: unknown): HoldResponse {
  return { status: HoldStatus.Held, body: heldBodySchema.parse(staged) };
}

/** Parses through one schema so a first answer and its replay serialize identically. */
function toHoldResponse(stored: StoredResponse): HoldResponse {
  if (stored.status === HoldStatus.Held) return stagedResponse(stored.body);
  if (stored.status === HoldStatus.PushFailed) {
    return { status: HoldStatus.PushFailed, body: pushFailedSchema.parse(stored.body) };
  }
  throw new Error(`unexpected stored hold response status ${stored.status}`);
}

/**
 * Serializes writes that make a booking occupy its range on one resource. Two such writes that
 * overlap would otherwise each wait on the other's uncommitted row in the exclusion constraint and
 * one would die as a deadlock (40P01) instead of an exclusion violation (23P01).
 */
async function lockSlotsOfResource(tx: DbTx, resourceId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${slotLockKey(sql`${resourceId}::uuid`)})`);
}

async function lockSlotsOfBooking(tx: DbTx, bookingId: string): Promise<void> {
  const locked = await tx.execute(
    sql`select pg_advisory_xact_lock(${slotLockKey(bookings.resourceId)}) from ${bookings} where ${bookings.id} = ${bookingId}`,
  );
  if (locked.length !== 1) throw new Error(`booking ${bookingId} does not exist`);
}

function slotLockKey(resourceId: SQL | typeof bookings.resourceId): SQL {
  return sql`hashtextextended('booking-slots:' || ${resourceId}::text, 0)`;
}

function bookingIn(bookingId: string, status: BookingStatus): SQL | undefined {
  return and(eq(bookings.id, bookingId), eq(bookings.status, status));
}

type BookingChange = Pick<typeof bookings.$inferInsert, 'status' | 'confirmedAt' | 'late'>;

/** Every booking status change is announced to the board and to the booking's page in the same transaction. */
async function changeBooking(tx: DbTx, where: SQL | undefined, change: BookingChange): Promise<number> {
  const changed = await tx
    .update(bookings)
    .set(change)
    .where(where)
    .returning({ token: bookings.token, status: bookings.status, late: bookings.late });
  await enqueueOutbox(tx, changed.flatMap(bookingUpdated));
  return changed.length;
}

async function changeOneBooking(tx: DbTx, where: SQL | undefined, change: BookingChange): Promise<void> {
  const count = await changeBooking(tx, where, change);
  if (count !== 1) throw new Error(`expected to change one booking, changed ${count}`);
}

function bookingUpdated(booking: { token: string; status: string; late: boolean }): OutboxMessage[] {
  const payload = { type: BOOKING_UPDATED, token: booking.token, status: booking.status, late: booking.late };
  return [
    { topic: BOARD_TOPIC, payload },
    { topic: bookingTopic(booking.token), payload },
  ];
}
