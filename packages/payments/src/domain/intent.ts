import { AttemptStatus, type AttemptMode, type PaymentAttempt } from './attempt.js';
import {
  AmountMismatchError,
  AttemptIntentMismatchError,
  IntentNotPayableError,
} from './errors.js';
import type {
  PaymentDomainEvent,
  PaymentReceivedEvent,
  PaymentReceivedEventType,
} from './events.js';
import { isSameMoney, type Money } from './money.js';

export const IntentStatus = {
  RequiresPayment: 'requires_payment',
  Processing: 'processing',
  Succeeded: 'succeeded',
  Expired: 'expired',
  Canceled: 'canceled',
} as const;
export type IntentStatus = (typeof IntentStatus)[keyof typeof IntentStatus];

/** One intent per thing being paid; it owns N attempts (Stripe PaymentIntent model). */
export interface PaymentIntent {
  readonly id: string;
  readonly reference: string;
  readonly amount: Money;
  readonly status: IntentStatus;
  readonly succeededAt: Date | null;
}

export type ReceivedPayment = {
  readonly providerTxId: string;
  readonly amount: Money;
  readonly at: Date;
  readonly trackingKey?: string;
  readonly payerBankCode?: string;
};

export type StartedAttempt = {
  readonly intent: PaymentIntent;
  readonly attempt: PaymentAttempt;
};

export type AttemptTransition = {
  readonly intent: PaymentIntent;
  readonly attempt: PaymentAttempt;
  readonly events: readonly PaymentDomainEvent[];
};

export function startAttempt(
  intent: PaymentIntent,
  mode: AttemptMode,
  id: string,
  expiresAt: Date,
): StartedAttempt {
  if (!isOpen(intent.status)) {
    throw new IntentNotPayableError(intent.id, intent.status);
  }
  return {
    intent: { ...intent, status: IntentStatus.Processing },
    attempt: {
      id,
      intentId: intent.id,
      mode,
      status: AttemptStatus.Awaiting,
      expiresAt,
      provider: {},
    },
  };
}

/**
 * Applies money that arrived on an attempt. Money is always recorded: a late or
 * duplicate payment is reported through its event type, never dropped.
 */
export function recordPayment(
  intent: PaymentIntent,
  attempt: PaymentAttempt,
  payment: ReceivedPayment,
): AttemptTransition {
  assertAttemptOf(intent, attempt);
  if (!isSameMoney(payment.amount, intent.amount)) {
    throw new AmountMismatchError(intent.id, intent.amount, payment.amount);
  }
  return {
    intent:
      intent.status === IntentStatus.Succeeded
        ? intent
        : { ...intent, status: IntentStatus.Succeeded, succeededAt: payment.at },
    attempt: {
      ...attempt,
      status: AttemptStatus.Succeeded,
      provider: {
        ...attempt.provider,
        // Push attempts already hold the rail's transaction id from creation: never overwrite it.
        transactionId: attempt.provider.transactionId ?? payment.providerTxId,
      },
    },
    events: [paymentReceivedEvent(receivedEventType(intent.status), intent, attempt, payment)],
  };
}

/** Expires an awaiting attempt; the intent expires only if no other attempt is awaiting. */
export function expireAttempt(
  intent: PaymentIntent,
  attempt: PaymentAttempt,
  now: Date,
  hasOtherAwaiting: boolean,
): AttemptTransition {
  assertAttemptOf(intent, attempt);
  if (attempt.status !== AttemptStatus.Awaiting) {
    return { intent, attempt, events: [] };
  }
  const intentExpires = !hasOtherAwaiting && isOpen(intent.status);
  return {
    intent: intentExpires ? { ...intent, status: IntentStatus.Expired } : intent,
    attempt: { ...attempt, status: AttemptStatus.Expired },
    events: [
      {
        type: 'AttemptExpired',
        intentId: intent.id,
        reference: intent.reference,
        attemptId: attempt.id,
        at: now,
      },
    ],
  };
}

/**
 * Fails an awaiting attempt whose rail call did not produce a charge we can rely on. The attempt
 * keeps its id so a payment that still arrives can be matched to it and handled as late. The
 * intent expires only if no other attempt is awaiting.
 */
export function failAttempt(
  intent: PaymentIntent,
  attempt: PaymentAttempt,
  hasOtherAwaiting: boolean,
): Omit<AttemptTransition, 'events'> {
  assertAttemptOf(intent, attempt);
  if (attempt.status !== AttemptStatus.Awaiting) return { intent, attempt };
  const intentExpires = !hasOtherAwaiting && isOpen(intent.status);
  return {
    intent: intentExpires ? { ...intent, status: IntentStatus.Expired } : intent,
    attempt: { ...attempt, status: AttemptStatus.Failed },
  };
}

function isOpen(status: IntentStatus): boolean {
  return status === IntentStatus.RequiresPayment || status === IntentStatus.Processing;
}

function assertAttemptOf(intent: PaymentIntent, attempt: PaymentAttempt): void {
  if (attempt.intentId !== intent.id) {
    throw new AttemptIntentMismatchError(attempt.id, intent.id);
  }
}

function receivedEventType(status: IntentStatus): PaymentReceivedEventType {
  switch (status) {
    case IntentStatus.RequiresPayment:
    case IntentStatus.Processing:
      return 'PaymentSucceeded';
    case IntentStatus.Expired:
    case IntentStatus.Canceled:
      return 'LatePaymentReceived';
    case IntentStatus.Succeeded:
      return 'DuplicatePaymentReceived';
  }
}

function paymentReceivedEvent(
  type: PaymentReceivedEventType,
  intent: PaymentIntent,
  attempt: PaymentAttempt,
  payment: ReceivedPayment,
): PaymentReceivedEvent {
  return {
    type,
    intentId: intent.id,
    reference: intent.reference,
    attemptId: attempt.id,
    providerTxId: payment.providerTxId,
    amount: payment.amount,
    ...(payment.trackingKey === undefined ? {} : { trackingKey: payment.trackingKey }),
    ...(payment.payerBankCode === undefined ? {} : { payerBankCode: payment.payerBankCode }),
    at: payment.at,
  };
}
