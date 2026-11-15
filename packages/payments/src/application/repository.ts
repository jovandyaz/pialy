import type { PaymentAttempt } from '../domain/attempt.js';
import type { PaymentIntent } from '../domain/intent.js';
import type { Money } from '../domain/money.js';
import type { PaymentEvent, WebhookOutcome } from './events.js';
import type { PaymentLookup } from './ports.js';

/** One key that identifies an attempt: an id the rail gave us, or our own attempt id. */
export type AttemptLookup = PaymentLookup | { readonly attemptId: string };

export interface AttemptMatch {
  readonly intent: PaymentIntent;
  readonly attempt: PaymentAttempt;
}

/** The money trace of one bank payment, kept whether or not it could be applied. */
export interface NewPaymentEvent {
  readonly providerTxId: string;
  readonly intentId: string | null;
  readonly attemptId: string | null;
  readonly amount: Money;
  readonly trackingKey?: string;
  /** Arrived after its intent expired or was canceled. */
  readonly late: boolean;
  readonly raw: unknown;
}

export const InsertResult = { Inserted: 'inserted', Duplicate: 'duplicate' } as const;
export type InsertResult = (typeof InsertResult)[keyof typeof InsertResult];

export interface PaymentRepository {
  /**
   * Also locks the attempt's intent until the unit of work ends, so two deliveries of one
   * payment are applied one after the other.
   */
  findAttemptByRef(lookup: AttemptLookup): Promise<AttemptMatch | null>;
  hasOtherAwaiting(intentId: string, exceptAttemptId: string): Promise<boolean>;
  /** `duplicate` when a payment with the same provider transaction id is already recorded. */
  insertPaymentEvent(event: NewPaymentEvent): Promise<InsertResult>;
  saveIntent(intent: PaymentIntent): Promise<void>;
  saveAttempt(attempt: PaymentAttempt): Promise<void>;
}

export interface WebhookDelivery {
  readonly webhookId: string;
  readonly eventType: string;
}

/** Idempotent-consumer log of webhook deliveries. */
export interface Inbox {
  /** `duplicate` when this delivery id is already recorded. */
  insert(delivery: WebhookDelivery): Promise<InsertResult>;
  markProcessed(webhookId: string, outcome: WebhookOutcome): Promise<void>;
}

export interface UnitOfWorkContext {
  readonly payments: PaymentRepository;
  readonly inbox: Inbox;
  /** Reacts to each payment event inside the same transaction. */
  readonly bookingEvents: (event: PaymentEvent) => Promise<void>;
}

export interface UnitOfWork {
  /** Commits when `fn` resolves and rolls back when it throws. */
  run<T>(fn: (tx: UnitOfWorkContext) => Promise<T>): Promise<T>;
}
