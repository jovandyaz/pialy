import { createHash, randomUUID } from 'node:crypto';
import type { Clock, Money, RailConnector } from '@pialy/payments';
import { HOLD_SECONDS, MAX_ATTEMPTS_PER_BOOKING } from '../domain/booking.js';
import { DEPOSIT_CONCEPT, IN_FLIGHT_TIMEOUT_MS, logRailFailure, type HoldLogger } from './hold-slot.js';

export const QR_SCOPE = 'qr';
export const QR_FAILED_DETAIL = 'No pudimos generar el código QR. Intenta de nuevo.';
export const QR_FAILED_TYPE = 'urn:pialy:problem:qr-failed';
export const NOT_HOLDING_DETAIL = 'Esta reserva ya no está esperando el pago';
export const NOT_HOLDING_TYPE = 'urn:pialy:problem:booking-not-holding';

const MS_PER_SECOND = 1000;

/** HTTP statuses a QR attempt answers with once its key is finished. */
export const QrStatus = { Created: 201, NotHolding: 409, QrFailed: 502 } as const;

export interface QrCreatedBody {
  /** The CoDi payload pey returns; the page draws it as a QR code. */
  readonly qrString: string;
  readonly expiresAt: string;
}

export interface QrProblem<Status extends number> {
  readonly type: string;
  readonly title: string;
  readonly status: Status;
  readonly detail: string;
}

/** What `POST /api/bookings/:token/qr` answers; stored on the idempotency key and replayed as is. */
export type QrResponse =
  | { readonly status: typeof QrStatus.Created; readonly body: QrCreatedBody }
  | { readonly status: typeof QrStatus.NotHolding; readonly body: QrProblem<typeof QrStatus.NotHolding> }
  | { readonly status: typeof QrStatus.QrFailed; readonly body: QrProblem<typeof QrStatus.QrFailed> };

export const QR_FAILED: QrResponse = {
  status: QrStatus.QrFailed,
  body: { type: QR_FAILED_TYPE, title: 'Bad Gateway', status: QrStatus.QrFailed, detail: QR_FAILED_DETAIL },
};

/** The booking stopped holding while its QR was being created; the same problem the route sends up front. */
export const QR_NOT_HOLDING: QrResponse = {
  status: QrStatus.NotHolding,
  body: { type: NOT_HOLDING_TYPE, title: 'Conflict', status: QrStatus.NotHolding, detail: NOT_HOLDING_DETAIL },
};

export interface QrOutcomes {
  /** For a booking still `holding`. */
  readonly created: QrResponse;
  /** For a booking paid, canceled or expired during the rail call: its QR is withheld. */
  readonly notHolding: QrResponse;
}

export interface NewQrAttempt {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly now: Date;
  /** A key locked before this instant belongs to a request that died. */
  readonly staleBefore: Date;
  readonly token: string;
  readonly attemptId: string;
  readonly expiresAt: Date;
  readonly maxAttempts: number;
}

export interface QrAttemptRef {
  readonly idempotencyKey: string;
  readonly bookingId: string;
  readonly attemptId: string;
}

export type BeganQrAttempt =
  | { readonly kind: 'started'; readonly attempt: QrAttemptRef; readonly bookingNumber: number }
  | { readonly kind: 'replay'; readonly response: QrResponse }
  /** The request that created this attempt died before it finished; its QR never reached the customer. */
  | { readonly kind: 'abandoned'; readonly attempt: QrAttemptRef };

/** The atomic phases around the rail call, as for a hold; each method is one transaction. */
export interface QrAttemptRepository {
  /**
   * Claims the key and, for a new key, locks the booking's intent then the booking, and creates
   * attempt `qr` `awaiting` next to any attempt still awaiting. Throws {@link BookingNotFoundError},
   * {@link BookingNotHoldingError}, {@link TooManyAttemptsError}, {@link IdempotencyKeyReusedError}
   * or {@link IdempotencyKeyInFlightError}; none of them keeps the key.
   */
  begin(attempt: NewQrAttempt): Promise<BeganQrAttempt>;
  /**
   * Stores the QR id on the attempt, so reconcile and the late watch can find it whatever the
   * answer. A booking still `holding` gets its hold extended to the attempt's expiry (notifying
   * board and booking) and the key finishes with `created`; any other booking finishes it with
   * `notHolding`.
   */
  recordQr(attempt: QrAttemptRef, qrId: string, outcomes: QrOutcomes): Promise<QrResponse>;
  /** Fails the attempt; the booking expires only when no other attempt is left awaiting. */
  failQr(attempt: QrAttemptRef, failed: QrResponse): Promise<QrResponse>;
}

export interface StartQrAttemptDeps {
  readonly attempts: QrAttemptRepository;
  readonly rail: Pick<RailConnector, 'createQrCharge'>;
  readonly clock: Clock;
  /** Fixed server side; no request carries an amount. */
  readonly deposit: Money;
  readonly log: HoldLogger;
}

export interface StartQrAttemptInput {
  readonly token: string;
  readonly idempotencyKey: string;
}

/**
 * Starts a CoDi QR attempt for a held booking, in parallel with any push still awaiting, and keeps
 * the slot held until the QR expires ({@link HOLD_SECONDS}). The same key for the same booking
 * answers the stored response without a second QR. Throws the errors of
 * {@link QrAttemptRepository.begin}.
 */
export async function startQrAttempt(deps: StartQrAttemptDeps, input: StartQrAttemptInput): Promise<QrResponse> {
  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + HOLD_SECONDS * MS_PER_SECOND);
  const begun = await deps.attempts.begin({
    idempotencyKey: input.idempotencyKey,
    requestHash: createHash('sha256').update(input.token).digest('hex'),
    now,
    staleBefore: new Date(now.getTime() - IN_FLIGHT_TIMEOUT_MS),
    token: input.token,
    attemptId: randomUUID(),
    expiresAt,
    maxAttempts: MAX_ATTEMPTS_PER_BOOKING,
  });
  switch (begun.kind) {
    case 'replay':
      return begun.response;
    case 'abandoned':
      deps.log.warn(idsOf(begun.attempt), 'ending an abandoned qr attempt');
      return deps.attempts.failQr(begun.attempt, QR_FAILED);
    case 'started':
      return createQr(deps, begun.attempt, begun.bookingNumber, expiresAt);
  }
}

async function createQr(
  deps: StartQrAttemptDeps,
  attempt: QrAttemptRef,
  bookingNumber: number,
  expiresAt: Date,
): Promise<QrResponse> {
  let charge: { qrId: string; qrString: string };
  try {
    charge = await deps.rail.createQrCharge({
      amount: deps.deposit,
      concept: DEPOSIT_CONCEPT,
      expiresInSec: HOLD_SECONDS,
      numRef: String(bookingNumber),
      metadata: idsOf(attempt),
    });
  } catch (error) {
    logRailFailure(deps.log, idsOf(attempt), error, 'codi qr');
    return deps.attempts.failQr(attempt, QR_FAILED);
  }
  return deps.attempts.recordQr(attempt, charge.qrId, {
    created: { status: QrStatus.Created, body: { qrString: charge.qrString, expiresAt: expiresAt.toISOString() } },
    notHolding: QR_NOT_HOLDING,
  });
}

function idsOf(attempt: QrAttemptRef): { bookingId: string; attemptId: string } {
  return { bookingId: attempt.bookingId, attemptId: attempt.attemptId };
}
