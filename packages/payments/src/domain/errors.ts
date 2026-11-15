import type { IntentStatus } from './intent.js';
import type { Money } from './money.js';

export class InvalidMoneyError extends Error {
  override readonly name = 'InvalidMoneyError';
  readonly amountMinor: number;

  constructor(amountMinor: number) {
    super(`Money must be a non-negative safe integer of minor units, got ${amountMinor}`);
    this.amountMinor = amountMinor;
  }
}

export class AmountMismatchError extends Error {
  override readonly name = 'AmountMismatchError';
  readonly intentId: string;
  readonly expected: Money;
  readonly received: Money;

  constructor(intentId: string, expected: Money, received: Money) {
    super(
      `Payment for intent ${intentId} is ${received.amountMinor} ${received.currency}, ` +
        `expected ${expected.amountMinor} ${expected.currency}`,
    );
    this.intentId = intentId;
    this.expected = expected;
    this.received = received;
  }
}

export class IntentNotPayableError extends Error {
  override readonly name = 'IntentNotPayableError';
  readonly intentId: string;
  readonly status: IntentStatus;

  constructor(intentId: string, status: IntentStatus) {
    super(`Intent ${intentId} is ${status} and cannot take a new attempt`);
    this.intentId = intentId;
    this.status = status;
  }
}

export class AttemptIntentMismatchError extends Error {
  override readonly name = 'AttemptIntentMismatchError';
  readonly attemptId: string;
  readonly intentId: string;

  constructor(attemptId: string, intentId: string) {
    super(`Attempt ${attemptId} does not belong to intent ${intentId}`);
    this.attemptId = attemptId;
    this.intentId = intentId;
  }
}
