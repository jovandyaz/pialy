import {
  AttemptMode,
  IntentStatus,
  failAttempt,
  startAttempt,
  type AttemptMatch,
  type PaymentRepository,
} from '@pialy/payments';
import { and, count, eq, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { IdempotencyKeyInFlightError, IdempotencyKeyReusedError } from '../../modules/booking/application/hold-slot.js';
import {
  QR_SCOPE,
  QrStatus,
  type BeganQrAttempt,
  type NewQrAttempt,
  type QrAttemptRef,
  type QrAttemptRepository,
  type QrResponse,
} from '../../modules/booking/application/start-qr-attempt.js';
import {
  BookingNotFoundError,
  BookingNotHoldingError,
  BookingStatus,
  TooManyAttemptsError,
} from '../../modules/booking/domain/booking.js';
import type { Db, DbTx } from '../db/client.js';
import { sanitized } from '../db/errors.js';
import { bookings, paymentAttempts } from '../db/schema.js';
import { claimKey, finishKey, lockKey, reachRecoveryPoint, type KeyRef, type StoredResponse } from '../idempotency.js';
import { enqueueOutbox } from '../outbox.js';
import { createDrizzlePaymentRepository, lockIntent } from '../payments/drizzle-payment-repository.js';
import { bookingIn, bookingUpdated, changeBooking } from './drizzle-booking-repository.js';

const QR_CREATED = 'qr_created';

const stagedSchema = z.object({ bookingId: z.uuid(), attemptId: z.uuid() });
const createdSchema = z.object({ qrString: z.string().min(1), expiresAt: z.string().min(1) });
const problemSchema = <Status extends number>(status: Status) =>
  z.object({ type: z.string(), title: z.string(), status: z.literal(status), detail: z.string() });
const notHoldingSchema = problemSchema(QrStatus.NotHolding);
const qrFailedSchema = problemSchema(QrStatus.QrFailed);

/**
 * Lock order: idempotency key, payment intent, then the booking, as for holds and webhooks. No path
 * here takes a slot lock, since none of them makes a booking occupy a range.
 */
export function createDrizzleQrAttemptRepository(db: Db): QrAttemptRepository {
  return {
    begin(attempt) {
      return sanitized(() => db.transaction((tx) => begin(tx, attempt)));
    },

    recordQr(attempt, qrId, outcomes) {
      return sanitized(() =>
        db.transaction(async (tx) => {
          const ref = keyOf(attempt);
          const key = await lockKey(tx, ref);
          const payments = createDrizzlePaymentRepository(tx);
          const match = await attemptOf(payments, attempt);
          await payments.saveAttempt({ ...match.attempt, provider: { ...match.attempt.provider, qrId } });
          if (key.response !== null) return toQrResponse(key.response);
          if ((await lockedBookingStatus(tx, attempt.bookingId)) !== BookingStatus.Holding) {
            return finish(tx, ref, outcomes.notHolding);
          }
          await extendHold(tx, attempt.bookingId, match.attempt.expiresAt);
          return finish(tx, ref, outcomes.created);
        }),
      );
    },

    failQr(attempt, failed) {
      return sanitized(() =>
        db.transaction(async (tx) => {
          const ref = keyOf(attempt);
          const key = await lockKey(tx, ref);
          if (key.response !== null) return toQrResponse(key.response);
          const payments = createDrizzlePaymentRepository(tx);
          const match = await attemptOf(payments, attempt);
          const otherAwaiting = await payments.hasOtherAwaiting(match.intent.id, match.attempt.id);
          const { intent, attempt: failedAttempt } = failAttempt(match.intent, match.attempt, otherAwaiting);
          await payments.saveIntent(intent);
          await payments.saveAttempt(failedAttempt);
          if (intent.status === IntentStatus.Expired && match.intent.status !== IntentStatus.Expired) {
            await changeBooking(tx, bookingIn(attempt.bookingId, BookingStatus.Holding), {
              status: BookingStatus.Expired,
            });
          }
          return finish(tx, ref, failed);
        }),
      );
    },
  };
}

async function begin(tx: DbTx, attempt: NewQrAttempt): Promise<BeganQrAttempt> {
  const ref: KeyRef = { key: attempt.idempotencyKey, scope: QR_SCOPE };
  const claim = await claimKey(tx, ref, attempt.requestHash, attempt.now, attempt.staleBefore);
  switch (claim.kind) {
    case 'mismatch':
      throw new IdempotencyKeyReusedError();
    case 'in_flight':
      throw new IdempotencyKeyInFlightError();
    case 'finished':
      return { kind: 'replay', response: toQrResponse(claim.response) };
    case 'abandoned':
      return { kind: 'abandoned', attempt: abandonedAttempt(attempt.idempotencyKey, claim.recoveryPoint, claim.staged) };
    case 'claimed':
      return createAttempt(tx, ref, attempt);
  }
}

async function createAttempt(tx: DbTx, ref: KeyRef, input: NewQrAttempt): Promise<BeganQrAttempt> {
  const [found] = await tx
    .select({ id: bookings.id, intentId: bookings.intentId })
    .from(bookings)
    .where(eq(bookings.token, input.token))
    .limit(1);
  if (found === undefined) throw new BookingNotFoundError();
  if (found.intentId === null) throw new BookingNotHoldingError();
  const intent = await lockIntent(tx, found.intentId);
  if (intent === null) throw new Error(`intent ${found.intentId} of booking ${found.id} does not exist`);
  const [booking] = await tx
    .select({ number: bookings.number, status: bookings.status })
    .from(bookings)
    .where(eq(bookings.id, found.id))
    .for('update');
  if (booking?.status !== BookingStatus.Holding) throw new BookingNotHoldingError();
  if ((await attemptsOfIntent(tx, intent.id)) >= input.maxAttempts) throw new TooManyAttemptsError();

  const started = startAttempt(intent, AttemptMode.Qr, input.attemptId, input.expiresAt);
  await createDrizzlePaymentRepository(tx).saveIntent(started.intent);
  await tx.insert(paymentAttempts).values({
    id: started.attempt.id,
    intentId: started.attempt.intentId,
    mode: started.attempt.mode,
    status: started.attempt.status,
    expiresAt: started.attempt.expiresAt,
  });
  const attempt: QrAttemptRef = { idempotencyKey: input.idempotencyKey, bookingId: found.id, attemptId: started.attempt.id };
  await reachRecoveryPoint(tx, ref, QR_CREATED, { bookingId: attempt.bookingId, attemptId: attempt.attemptId });
  return { kind: 'started', attempt, bookingNumber: booking.number };
}

async function lockedBookingStatus(tx: DbTx, bookingId: string): Promise<string> {
  const [row] = await tx.select({ status: bookings.status }).from(bookings).where(eq(bookings.id, bookingId)).for('update');
  if (row === undefined) throw new Error(`booking ${bookingId} of a qr attempt does not exist`);
  return row.status;
}

async function attemptsOfIntent(tx: DbTx, intentId: string): Promise<number> {
  const [row] = await tx.select({ attempts: count() }).from(paymentAttempts).where(eq(paymentAttempts.intentId, intentId));
  return row?.attempts ?? 0;
}

/** Only ever moves the expiry later, so a slower request for an older attempt cannot shorten the hold. */
async function extendHold(tx: DbTx, bookingId: string, until: Date): Promise<void> {
  const changed = await tx
    .update(bookings)
    .set({ holdExpiresAt: until })
    .where(
      and(
        bookingIn(bookingId, BookingStatus.Holding),
        or(isNull(bookings.holdExpiresAt), lt(bookings.holdExpiresAt, until)),
      ),
    )
    .returning({ token: bookings.token, status: bookings.status, late: bookings.late });
  await enqueueOutbox(tx, changed.flatMap(bookingUpdated));
}

function abandonedAttempt(idempotencyKey: string, recoveryPoint: string | null, staged: unknown): QrAttemptRef {
  if (recoveryPoint !== QR_CREATED) throw new Error(`cannot resume a qr attempt from recovery point ${recoveryPoint}`);
  return { idempotencyKey, ...stagedSchema.parse(staged) };
}

async function attemptOf(payments: PaymentRepository, attempt: QrAttemptRef): Promise<AttemptMatch> {
  const match = await payments.findAttemptByRef({ attemptId: attempt.attemptId });
  if (match === null) throw new Error(`qr attempt ${attempt.attemptId} does not exist`);
  if (match.attempt.mode !== AttemptMode.Qr) throw new Error(`attempt ${attempt.attemptId} is not a qr attempt`);
  return match;
}

async function finish(tx: DbTx, ref: KeyRef, response: QrResponse): Promise<QrResponse> {
  const normalized = toQrResponse(response);
  await finishKey(tx, ref, normalized);
  return normalized;
}

function keyOf(attempt: QrAttemptRef): KeyRef {
  return { key: attempt.idempotencyKey, scope: QR_SCOPE };
}

/** Parses through one schema so a first answer and its replay serialize identically. */
function toQrResponse(stored: StoredResponse): QrResponse {
  if (stored.status === QrStatus.Created) return { status: QrStatus.Created, body: createdSchema.parse(stored.body) };
  if (stored.status === QrStatus.NotHolding) {
    return { status: QrStatus.NotHolding, body: notHoldingSchema.parse(stored.body) };
  }
  if (stored.status === QrStatus.QrFailed) return { status: QrStatus.QrFailed, body: qrFailedSchema.parse(stored.body) };
  throw new Error(`unexpected stored qr response status ${stored.status}`);
}
