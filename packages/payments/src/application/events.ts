import type { PaymentDomainEvent } from '../domain/events.js';
import type { Money } from '../domain/money.js';
import type { ProviderPayment } from './ports.js';

/** Money arrived that no attempt claims. It is recorded, never applied, and needs a person. */
export type UnmatchedPaymentReceived = {
  readonly type: 'UnmatchedPaymentReceived';
  readonly providerTxId: string;
  readonly amount: Money;
  readonly ref: ProviderPayment['ref'];
  readonly trackingKey?: string;
  readonly at: Date;
};

/**
 * How the received amount was established before it was found not to match:
 * - `none`: used as delivered (reconcile reads the rail already; a webhook without a transaction id);
 * - `rail_lookup`: re-read from the rail's own record of the transaction;
 * - `rail_lookup_failed`: the rail could not be asked, so the delivered amount stands.
 */
export const AmountCheck = {
  None: 'none',
  RailLookup: 'rail_lookup',
  RailLookupFailed: 'rail_lookup_failed',
} as const;
export type AmountCheck = (typeof AmountCheck)[keyof typeof AmountCheck];

/** Money arrived for an attempt but not for the intent's amount. It is recorded, never applied. */
export type PaymentAmountMismatched = {
  readonly type: 'PaymentAmountMismatched';
  readonly intentId: string;
  readonly reference: string;
  readonly attemptId: string;
  readonly providerTxId: string;
  readonly expected: Money;
  readonly received: Money;
  readonly amountCheck: AmountCheck;
  readonly lookupError?: string;
  readonly at: Date;
};

/** Everything applying a payment can report to the reaction running in the same transaction. */
export type PaymentEvent = PaymentDomainEvent | UnmatchedPaymentReceived | PaymentAmountMismatched;

/**
 * - `applied`: the payment moved its attempt and intent (on time, late or as a second payment);
 * - `duplicate`: this bank payment or this delivery was already processed;
 * - `unmatched`: recorded but not applied (no attempt claims it, or the amount is wrong).
 */
export const ApplyOutcome = {
  Applied: 'applied',
  Duplicate: 'duplicate',
  Unmatched: 'unmatched',
} as const;
export type ApplyOutcome = (typeof ApplyOutcome)[keyof typeof ApplyOutcome];

/** `ignored`: a verified delivery that reports no payment. */
export const WebhookOutcome = { ...ApplyOutcome, Ignored: 'ignored' } as const;
export type WebhookOutcome = (typeof WebhookOutcome)[keyof typeof WebhookOutcome];
