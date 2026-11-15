import type { Money } from './money.js';

export type PaymentReceivedEventType =
  | 'PaymentSucceeded'
  | 'LatePaymentReceived'
  | 'DuplicatePaymentReceived';

export type PaymentReceivedEvent = {
  readonly type: PaymentReceivedEventType;
  readonly intentId: string;
  readonly reference: string;
  readonly attemptId: string;
  readonly providerTxId: string;
  readonly amount: Money;
  readonly trackingKey?: string;
  readonly payerBankCode?: string;
  readonly at: Date;
};

export type AttemptExpiredEvent = {
  readonly type: 'AttemptExpired';
  readonly intentId: string;
  readonly reference: string;
  readonly attemptId: string;
  readonly at: Date;
};

export type PaymentDomainEvent = PaymentReceivedEvent | AttemptExpiredEvent;
