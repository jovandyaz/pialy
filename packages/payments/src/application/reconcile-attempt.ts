import { AttemptStatus, type PaymentAttempt } from '../domain/attempt.js';
import { expireAttempt } from '../domain/intent.js';
import { PaymentSource, applyProviderPayment, type PaymentFinder } from './apply-provider-payment.js';
import {
  RailRejectedError,
  RailUnavailableError,
  type Clock,
  type PaymentLookup,
  type ProviderPayment,
} from './ports.js';
import type { AttemptMatch, UnitOfWork, UnitOfWorkContext } from './repository.js';

/**
 * How long after an attempt's expiry the rail may keep failing before the attempt expires anyway.
 * Until then the money might have arrived, so the hold is kept; afterwards a payment that turns
 * up is still applied through the late-payment policy.
 */
export const RAIL_FAILURE_GRACE_MS = 10 * 60_000;

export const ReconcileOutcome = { Paid: 'paid', Expired: 'expired', StillAwaiting: 'still_awaiting' } as const;
export type ReconcileOutcome = (typeof ReconcileOutcome)[keyof typeof ReconcileOutcome];

export type RailFailure = RailUnavailableError | RailRejectedError;

export interface ReconcileResult {
  readonly outcome: ReconcileOutcome;
  /** The rail could not be asked; the caller logs it. The outcome says what was done anyway. */
  readonly railError: RailFailure | null;
}

/**
 * Settles one attempt against the rail: every payment the rail reports PAID is applied (once,
 * whatever the webhook did), and an attempt still awaiting after its expiry is expired. The rail
 * is asked outside any unit of work. While the rail fails, an attempt is expired only once
 * {@link RAIL_FAILURE_GRACE_MS} passed after its expiry. Attempts the rail never got an id for
 * are not looked up. Errors other than the rail's own escape and leave the attempt as it was.
 */
export async function reconcileAttempt(
  uow: UnitOfWork,
  rail: PaymentFinder,
  attemptId: string,
  clock: Clock,
): Promise<ReconcileResult> {
  // An empty rail answer proves only that nothing was paid before the call, so expiry is judged at this instant.
  const checkedAt = clock.now();
  const { attempt } = await uow.run((tx) => attemptMatch(tx, attemptId));
  if (attempt.status === AttemptStatus.Succeeded) return { outcome: ReconcileOutcome.Paid, railError: null };

  const lookup = lookupOf(attempt);
  let railError: RailFailure | null = null;
  if (lookup !== null) {
    try {
      const payments = await rail.findPayments(lookup);
      for (const payment of payments) {
        await applyProviderPayment(uow, rail, payment, PaymentSource.Reconcile, reconcileTrace(lookup, payment));
      }
    } catch (error) {
      if (!(error instanceof RailUnavailableError || error instanceof RailRejectedError)) throw error;
      railError = error;
    }
  }
  const outcome = await uow.run((tx) => settle(tx, attemptId, checkedAt, railError !== null));
  return { outcome, railError };
}

async function settle(
  tx: UnitOfWorkContext,
  attemptId: string,
  now: Date,
  railFailed: boolean,
): Promise<ReconcileOutcome> {
  const { intent, attempt } = await attemptMatch(tx, attemptId);
  switch (attempt.status) {
    case AttemptStatus.Succeeded:
      return ReconcileOutcome.Paid;
    case AttemptStatus.Expired:
    case AttemptStatus.Failed:
      return ReconcileOutcome.Expired;
    case AttemptStatus.Awaiting:
      break;
  }
  const deadline = attempt.expiresAt.getTime() + (railFailed ? RAIL_FAILURE_GRACE_MS : 0);
  if (now.getTime() < deadline) return ReconcileOutcome.StillAwaiting;

  const otherAwaiting = await tx.payments.hasOtherAwaiting(intent.id, attempt.id);
  const expired = expireAttempt(intent, attempt, now, otherAwaiting);
  // The reaction decides from the persisted intent status, so the intent must be saved before the event.
  await tx.payments.saveIntent(expired.intent);
  await tx.payments.saveAttempt(expired.attempt);
  for (const event of expired.events) await tx.bookingEvents(event);
  return ReconcileOutcome.Expired;
}

/** Also locks the attempt's intent until the unit of work ends (see the repository port). */
async function attemptMatch(tx: UnitOfWorkContext, attemptId: string): Promise<AttemptMatch> {
  const match = await tx.payments.findAttemptByRef({ attemptId });
  if (match === null) throw new Error(`attempt ${attemptId} does not exist`);
  return match;
}

/** A QR collects any number of payments, so it is read by its own id; a push by its transaction. */
function lookupOf(attempt: PaymentAttempt): PaymentLookup | null {
  if (attempt.provider.qrId !== undefined) return { qrId: attempt.provider.qrId };
  if (attempt.provider.transactionId !== undefined) return { transactionId: attempt.provider.transactionId };
  return null;
}

/** The connector's normalized payment carries no CLABE or phone, unlike a webhook body. */
function reconcileTrace(lookup: PaymentLookup, payment: ProviderPayment): unknown {
  return { source: PaymentSource.Reconcile, lookup, payment };
}
