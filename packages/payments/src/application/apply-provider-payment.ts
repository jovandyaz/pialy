import { AmountMismatchError } from '../domain/errors.js';
import { recordPayment, type AttemptTransition } from '../domain/intent.js';
import { isSameMoney, type Money } from '../domain/money.js';
import {
  AmountCheck,
  ApplyOutcome,
  WebhookOutcome,
  type PaymentAmountMismatched,
  type UnmatchedPaymentReceived,
} from './events.js';
import {
  RailRejectedError,
  RailUnavailableError,
  type ParsedWebhook,
  type ProviderPayment,
  type RailConnector,
} from './ports.js';
import {
  InsertResult,
  type AttemptLookup,
  type AttemptMatch,
  type PaymentRepository,
  type UnitOfWork,
  type UnitOfWorkContext,
  type WebhookDelivery,
} from './repository.js';

export const PaymentSource = { Webhook: 'webhook', Reconcile: 'reconcile' } as const;
export type PaymentSource = (typeof PaymentSource)[keyof typeof PaymentSource];

/** The only rail call the use case makes. */
export type PaymentFinder = Pick<RailConnector, 'findPayments'>;

interface Delivered {
  readonly payment: ProviderPayment;
  readonly raw: unknown;
  /** Present for webhooks: logged in the inbox in the same transaction as the payment. */
  readonly delivery: WebhookDelivery | undefined;
}

/**
 * Retry later: a webhook amount differs from the intent and the rail could not confirm the base
 * amount (lookup failed or the transaction is not PAID yet). Nothing was recorded, so a redelivery
 * or the reconcile sweep can still apply the payment.
 */
export class AmountUnverifiedError extends Error {
  override readonly name = 'AmountUnverifiedError';
  readonly providerTxId: string;

  constructor(providerTxId: string, reason: string, options: { cause?: unknown } = {}) {
    super(`amount of payment ${providerTxId} could not be confirmed with the rail: ${reason}`, options);
    this.providerTxId = providerTxId;
  }
}

/** A matched payment with a different amount stops before any write so the rail can be asked. */
const DEFER_MISMATCH = Symbol('defer-mismatch');
const AMOUNT_UNVERIFIED = Symbol('amount-unverified');

/**
 * Applies one settled payment exactly once: the money trace is always kept, the attempt and
 * intent move only when the amount matches, and every event reaches `bookingEvents` in the same
 * transaction. A webhook amount that does not match is re-read from the rail first, outside any
 * transaction, because the webhook may report the total with payer fees instead of the base; when
 * the rail cannot confirm it, {@link AmountUnverifiedError} is thrown and nothing is recorded.
 */
export function applyProviderPayment(
  uow: UnitOfWork,
  rail: PaymentFinder,
  payment: ProviderPayment,
  source: PaymentSource,
  raw: unknown,
): Promise<ApplyOutcome> {
  return apply(uow, rail, source, { payment, raw, delivery: undefined });
}

/** Logs a verified delivery in the inbox and applies its payment in the same transaction. */
export async function receiveWebhook(
  uow: UnitOfWork,
  rail: PaymentFinder,
  webhook: ParsedWebhook,
  raw: unknown,
): Promise<WebhookOutcome> {
  const delivery: WebhookDelivery = { webhookId: webhook.webhookId, eventType: webhook.eventType };
  if (webhook.payment !== null) {
    return apply(uow, rail, PaymentSource.Webhook, { payment: webhook.payment, raw, delivery });
  }
  return uow.run(async (tx) => {
    if ((await tx.inbox.insert(delivery)) === InsertResult.Duplicate) return WebhookOutcome.Duplicate;
    await tx.inbox.markProcessed(delivery.webhookId, WebhookOutcome.Ignored);
    return WebhookOutcome.Ignored;
  });
}

async function apply(
  uow: UnitOfWork,
  rail: PaymentFinder,
  source: PaymentSource,
  delivered: Delivered,
): Promise<ApplyOutcome> {
  const transactionId = source === PaymentSource.Webhook ? delivered.payment.ref.transactionId : undefined;
  if (transactionId === undefined) {
    return uow.run((tx) => applyInTransaction(tx, delivered, AmountCheck.None));
  }
  const first = await uow.run((tx) => applyInTransaction(tx, delivered, DEFER_MISMATCH));
  if (first !== AMOUNT_UNVERIFIED) return first;

  const amount = await readBaseAmountFromRail(rail, transactionId, delivered.payment.providerTxId);
  const payment = { ...delivered.payment, amount };
  return uow.run((tx) => applyInTransaction(tx, { ...delivered, payment }, AmountCheck.RailLookup));
}

function applyInTransaction(
  tx: UnitOfWorkContext,
  delivered: Delivered,
  amountCheck: AmountCheck,
): Promise<ApplyOutcome>;
function applyInTransaction(
  tx: UnitOfWorkContext,
  delivered: Delivered,
  amountCheck: typeof DEFER_MISMATCH,
): Promise<ApplyOutcome | typeof AMOUNT_UNVERIFIED>;
async function applyInTransaction(
  tx: UnitOfWorkContext,
  delivered: Delivered,
  amountCheck: AmountCheck | typeof DEFER_MISMATCH,
): Promise<ApplyOutcome | typeof AMOUNT_UNVERIFIED> {
  const { payment, delivery } = delivered;
  const match = await findAttempt(tx.payments, payment.ref);
  if (amountCheck === DEFER_MISMATCH && match !== null && !isSameMoney(payment.amount, match.intent.amount)) {
    return AMOUNT_UNVERIFIED;
  }
  if (delivery !== undefined && (await tx.inbox.insert(delivery)) === InsertResult.Duplicate) {
    return ApplyOutcome.Duplicate;
  }
  const settled = amountCheck === DEFER_MISMATCH ? AmountCheck.None : amountCheck;
  const transition = match === null ? null : transitionFor(match, payment);
  const outcome = await record(tx, delivered, match, transition, settled);
  if (delivery !== undefined) await tx.inbox.markProcessed(delivery.webhookId, outcome);
  return outcome;
}

/** `transition` is null when the amount does not match the intent. */
async function record(
  tx: UnitOfWorkContext,
  { payment, raw }: Delivered,
  match: AttemptMatch | null,
  transition: AttemptTransition | null,
  amountCheck: AmountCheck,
): Promise<ApplyOutcome> {
  const inserted = await tx.payments.insertPaymentEvent({
    providerTxId: payment.providerTxId,
    intentId: match?.intent.id ?? null,
    attemptId: match?.attempt.id ?? null,
    amount: payment.amount,
    ...(payment.trackingKey === undefined ? {} : { trackingKey: payment.trackingKey }),
    late: transition?.events.some((e) => e.type === 'LatePaymentReceived') ?? false,
    raw,
  });
  if (inserted === InsertResult.Duplicate) return ApplyOutcome.Duplicate;

  if (match === null) {
    await tx.bookingEvents(unmatchedEvent(payment));
    return ApplyOutcome.Unmatched;
  }
  if (transition === null) {
    await tx.bookingEvents(mismatchEvent(match, payment, amountCheck));
    return ApplyOutcome.Unmatched;
  }
  await tx.payments.saveIntent(transition.intent);
  await tx.payments.saveAttempt(transition.attempt);
  for (const event of transition.events) await tx.bookingEvents(event);
  return ApplyOutcome.Applied;
}

function transitionFor(match: AttemptMatch, payment: ProviderPayment): AttemptTransition | null {
  try {
    return recordPayment(match.intent, match.attempt, {
      providerTxId: payment.providerTxId,
      amount: payment.amount,
      at: payment.paidAt,
      ...(payment.trackingKey === undefined ? {} : { trackingKey: payment.trackingKey }),
      ...(payment.payerBankCode === undefined ? {} : { payerBankCode: payment.payerBankCode }),
    });
  } catch (error) {
    if (error instanceof AmountMismatchError) return null;
    throw error;
  }
}

/** pey may notify before we stored its transaction id, so our own attempt id is the last resort. */
async function findAttempt(payments: PaymentRepository, ref: ProviderPayment['ref']): Promise<AttemptMatch | null> {
  const lookups: AttemptLookup[] = [];
  if (ref.transactionId !== undefined) lookups.push({ transactionId: ref.transactionId });
  if (ref.qrId !== undefined) lookups.push({ qrId: ref.qrId });
  if (ref.attemptId !== undefined) lookups.push({ attemptId: ref.attemptId });
  for (const lookup of lookups) {
    const match = await payments.findAttemptByRef(lookup);
    if (match !== null) return match;
  }
  return null;
}

async function readBaseAmountFromRail(
  rail: PaymentFinder,
  transactionId: string,
  providerTxId: string,
): Promise<Money> {
  let payments: ProviderPayment[];
  try {
    payments = await rail.findPayments({ transactionId });
  } catch (error) {
    if (error instanceof RailUnavailableError || error instanceof RailRejectedError) {
      throw new AmountUnverifiedError(providerTxId, error.message, { cause: error });
    }
    throw error;
  }
  const paid = payments.find((p) => p.providerTxId === providerTxId);
  if (paid === undefined) throw new AmountUnverifiedError(providerTxId, 'the rail reports no paid transaction with this id');
  return paid.amount;
}

function unmatchedEvent(payment: ProviderPayment): UnmatchedPaymentReceived {
  return {
    type: 'UnmatchedPaymentReceived',
    providerTxId: payment.providerTxId,
    amount: payment.amount,
    ref: payment.ref,
    ...(payment.trackingKey === undefined ? {} : { trackingKey: payment.trackingKey }),
    at: payment.paidAt,
  };
}

function mismatchEvent(
  { intent, attempt }: AttemptMatch,
  payment: ProviderPayment,
  amountCheck: AmountCheck,
): PaymentAmountMismatched {
  return {
    type: 'PaymentAmountMismatched',
    intentId: intent.id,
    reference: intent.reference,
    attemptId: attempt.id,
    providerTxId: payment.providerTxId,
    expected: intent.amount,
    received: payment.amount,
    amountCheck,
    at: payment.paidAt,
  };
}
