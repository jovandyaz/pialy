import { describe, expect, it } from 'vitest';
import {
  AmountMismatchError,
  AttemptIntentMismatchError,
  IntentNotPayableError,
  InvalidMoneyError,
  expireAttempt,
  failAttempt,
  money,
  recordPayment,
  startAttempt,
  toProviderAmount,
  type AttemptStatus,
  type IntentStatus,
  type PaymentAttempt,
  type PaymentIntent,
} from '../src/index.js';

const STARTED_AT = new Date('2026-11-14T18:00:00.000Z');
const EXPIRES_AT = new Date('2026-11-14T18:06:00.000Z');
const PAID_AT = new Date('2026-11-14T18:02:30.000Z');
const SWEPT_AT = new Date('2026-11-14T18:06:15.000Z');

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (typeof nested === 'object' && nested !== null && !Object.isFrozen(nested)) {
      deepFreeze(nested);
    }
  }
  return Object.freeze(value);
}

function anIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return deepFreeze({
    id: 'pi_1',
    reference: 'R-1001',
    amount: money(1),
    status: 'processing',
    succeededAt: null,
    ...overrides,
  });
}

function anAttempt(overrides: Partial<PaymentAttempt> = {}): PaymentAttempt {
  return deepFreeze({
    id: 'att_1',
    intentId: 'pi_1',
    mode: 'push',
    status: 'awaiting',
    expiresAt: EXPIRES_AT,
    provider: {},
    ...overrides,
  });
}

const payment = { providerTxId: 'tx_42', amount: money(1), at: PAID_AT };

describe('money', () => {
  it('builds MXN money from integer minor units', () => {
    expect(money(1)).toEqual({ amountMinor: 1, currency: 'MXN' });
    expect(money(0)).toEqual({ amountMinor: 0, currency: 'MXN' });
  });

  it.each([1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %s',
    (amountMinor) => {
      expect(() => money(amountMinor)).toThrow(InvalidMoneyError);
    },
  );

  it('converts minor units to the provider decimal amount', () => {
    expect(toProviderAmount(money(1))).toBe(0.01);
    expect(toProviderAmount(money(12345))).toBe(123.45);
  });
});

describe('startAttempt', () => {
  it('opens an awaiting attempt and moves a new intent to processing', () => {
    const intent = anIntent({ status: 'requires_payment' });

    const result = startAttempt(intent, 'push', 'att_1', EXPIRES_AT);

    expect(result.intent).toEqual({ ...intent, status: 'processing' });
    expect(result.attempt).toEqual({
      id: 'att_1',
      intentId: 'pi_1',
      mode: 'push',
      status: 'awaiting',
      expiresAt: EXPIRES_AT,
      provider: {},
    });
    expect(intent.status).toBe('requires_payment');
  });

  it('allows another attempt while the intent is processing', () => {
    const intent = anIntent({ status: 'processing' });

    const result = startAttempt(intent, 'qr', 'att_2', EXPIRES_AT);

    expect(result.intent.status).toBe('processing');
    expect(result.attempt).toMatchObject({ id: 'att_2', mode: 'qr', status: 'awaiting' });
  });

  it.each<IntentStatus>(['succeeded', 'expired', 'canceled'])(
    'throws IntentNotPayableError when the intent is %s',
    (status) => {
      const intent = anIntent({ status });

      expect(() => startAttempt(intent, 'push', 'att_9', EXPIRES_AT)).toThrow(IntentNotPayableError);
    },
  );
});

describe('recordPayment', () => {
  it('succeeds a processing intent and its attempt with one PaymentSucceeded event', () => {
    const intent = anIntent({ status: 'processing' });
    const attempt = anAttempt({ status: 'awaiting' });

    const result = recordPayment(intent, attempt, {
      ...payment,
      trackingKey: 'CK-001',
      payerBankCode: '40012',
    });

    expect(result.intent).toEqual({ ...intent, status: 'succeeded', succeededAt: PAID_AT });
    expect(result.attempt).toEqual({
      ...attempt,
      status: 'succeeded',
      provider: { transactionId: 'tx_42' },
    });
    expect(result.events).toEqual([
      {
        type: 'PaymentSucceeded',
        intentId: 'pi_1',
        reference: 'R-1001',
        attemptId: 'att_1',
        providerTxId: 'tx_42',
        amount: money(1),
        trackingKey: 'CK-001',
        payerBankCode: '40012',
        at: PAID_AT,
      },
    ]);
  });

  it('omits optional event fields that the payment does not carry', () => {
    const result = recordPayment(anIntent(), anAttempt(), payment);

    expect(result.events[0]).not.toHaveProperty('trackingKey');
    expect(result.events[0]).not.toHaveProperty('payerBankCode');
  });

  it('keeps provider ids already on the attempt', () => {
    const attempt = anAttempt({ mode: 'qr', provider: { qrId: 'qr_7', codiId: 'codi_7' } });

    const result = recordPayment(anIntent(), attempt, payment);

    expect(result.attempt.provider).toEqual({
      qrId: 'qr_7',
      codiId: 'codi_7',
      transactionId: 'tx_42',
    });
  });

  it('still emits PaymentSucceeded when the attempt expired but the intent is processing', () => {
    const intent = anIntent({ status: 'processing' });
    const attempt = anAttempt({ status: 'expired' });

    const result = recordPayment(intent, attempt, payment);

    expect(result.intent.status).toBe('succeeded');
    expect(result.attempt.status).toBe('succeeded');
    expect(result.events.map((event) => event.type)).toEqual(['PaymentSucceeded']);
  });

  it.each<IntentStatus>(['expired', 'canceled'])(
    'succeeds a %s intent with a LatePaymentReceived event',
    (status) => {
      const intent = anIntent({ status });
      const attempt = anAttempt({ status: 'expired' });

      const result = recordPayment(intent, attempt, payment);

      expect(result.intent).toEqual({ ...intent, status: 'succeeded', succeededAt: PAID_AT });
      expect(result.attempt.status).toBe('succeeded');
      expect(result.events).toEqual([
        {
          type: 'LatePaymentReceived',
          intentId: 'pi_1',
          reference: 'R-1001',
          attemptId: 'att_1',
          providerTxId: 'tx_42',
          amount: money(1),
          at: PAID_AT,
        },
      ]);
    },
  );

  it('leaves a succeeded intent unchanged and emits DuplicatePaymentReceived', () => {
    const firstPaidAt = new Date('2026-11-14T18:01:00.000Z');
    const intent = anIntent({ status: 'succeeded', succeededAt: firstPaidAt });
    const attempt = anAttempt({ status: 'succeeded', provider: { transactionId: 'tx_first' } });

    const result = recordPayment(intent, attempt, { ...payment, providerTxId: 'tx_second' });

    expect(result.intent).toEqual(intent);
    expect(result.attempt).toEqual(attempt);
    expect(result.events).toEqual([
      {
        type: 'DuplicatePaymentReceived',
        intentId: 'pi_1',
        reference: 'R-1001',
        attemptId: 'att_1',
        providerTxId: 'tx_second',
        amount: money(1),
        at: PAID_AT,
      },
    ]);
  });

  it('marks a second paid attempt succeeded on a duplicate without touching the intent', () => {
    const intent = anIntent({ status: 'succeeded', succeededAt: STARTED_AT });
    const otherAttempt = anAttempt({ id: 'att_2', mode: 'qr', status: 'awaiting' });

    const result = recordPayment(intent, otherAttempt, payment);

    expect(result.intent).toEqual(intent);
    expect(result.attempt).toEqual({
      ...otherAttempt,
      status: 'succeeded',
      provider: { transactionId: 'tx_42' },
    });
    expect(result.events.map((event) => event.type)).toEqual(['DuplicatePaymentReceived']);
  });

  it.each<IntentStatus>(['processing', 'expired', 'succeeded'])(
    'throws AmountMismatchError when the amount differs (intent %s)',
    (status) => {
      const intent = anIntent({ status, amount: money(1) });

      expect(() =>
        recordPayment(intent, anAttempt(), { ...payment, amount: money(100) }),
      ).toThrow(AmountMismatchError);
    },
  );

  it('throws AttemptIntentMismatchError when the attempt belongs to another intent', () => {
    expect(() =>
      recordPayment(anIntent(), anAttempt({ intentId: 'pi_other' }), payment),
    ).toThrow(AttemptIntentMismatchError);
  });
});

describe('expireAttempt', () => {
  it('keeps the intent processing when another attempt is still awaiting', () => {
    const intent = anIntent({ status: 'processing' });
    const attempt = anAttempt({ status: 'awaiting' });

    const result = expireAttempt(intent, attempt, SWEPT_AT, true);

    expect(result.intent).toEqual(intent);
    expect(result.attempt).toEqual({ ...attempt, status: 'expired' });
    expect(result.events).toEqual([
      {
        type: 'AttemptExpired',
        intentId: 'pi_1',
        reference: 'R-1001',
        attemptId: 'att_1',
        at: SWEPT_AT,
      },
    ]);
  });

  it('expires the intent when no other attempt is awaiting', () => {
    const intent = anIntent({ status: 'processing' });

    const result = expireAttempt(intent, anAttempt(), SWEPT_AT, false);

    expect(result.intent).toEqual({ ...intent, status: 'expired' });
    expect(result.attempt.status).toBe('expired');
    expect(result.events.map((event) => event.type)).toEqual(['AttemptExpired']);
  });

  it('never expires an intent that already succeeded', () => {
    const intent = anIntent({ status: 'succeeded', succeededAt: PAID_AT });
    const leftoverAttempt = anAttempt({ id: 'att_2', mode: 'qr', status: 'awaiting' });

    const result = expireAttempt(intent, leftoverAttempt, SWEPT_AT, false);

    expect(result.intent).toEqual(intent);
    expect(result.attempt.status).toBe('expired');
  });

  it.each<AttemptStatus>(['succeeded', 'expired', 'failed'])(
    'is a no-op for an attempt that is already %s',
    (status) => {
      const intent = anIntent({ status: 'processing' });
      const attempt = anAttempt({ status });

      const result = expireAttempt(intent, attempt, SWEPT_AT, false);

      expect(result).toEqual({ intent, attempt, events: [] });
    },
  );

  it('throws AttemptIntentMismatchError when the attempt belongs to another intent', () => {
    expect(() =>
      expireAttempt(anIntent(), anAttempt({ intentId: 'pi_other' }), SWEPT_AT, false),
    ).toThrow(AttemptIntentMismatchError);
  });
});

describe('failAttempt', () => {
  it('fails an awaiting attempt and expires the intent when no other attempt is awaiting', () => {
    const intent = anIntent({ status: 'processing' });
    const attempt = anAttempt({ status: 'awaiting', provider: { transactionId: 'tx_1' } });

    const result = failAttempt(intent, attempt, false);

    expect(result.intent).toEqual({ ...intent, status: 'expired' });
    expect(result.attempt).toEqual({ ...attempt, status: 'failed' });
  });

  it('keeps the intent processing when another attempt is still awaiting', () => {
    const intent = anIntent({ status: 'processing' });

    const result = failAttempt(intent, anAttempt(), true);

    expect(result.intent).toEqual(intent);
    expect(result.attempt.status).toBe('failed');
  });

  it.each<AttemptStatus>(['succeeded', 'expired', 'failed'])(
    'is a no-op for an attempt that is already %s',
    (status) => {
      const intent = anIntent({ status: 'succeeded', succeededAt: PAID_AT });
      const attempt = anAttempt({ status });

      expect(failAttempt(intent, attempt, false)).toEqual({ intent, attempt });
    },
  );

  it('throws AttemptIntentMismatchError when the attempt belongs to another intent', () => {
    expect(() => failAttempt(anIntent(), anAttempt({ intentId: 'pi_other' }), false)).toThrow(
      AttemptIntentMismatchError,
    );
  });
});

describe('domain errors', () => {
  it('are Error subclasses with a stable name', () => {
    const intent = anIntent({ status: 'processing', amount: money(1) });

    const thrown = (() => {
      try {
        recordPayment(intent, anAttempt(), { ...payment, amount: money(2) });
      } catch (error: unknown) {
        return error;
      }
      return undefined;
    })();

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      name: 'AmountMismatchError',
      expected: money(1),
      received: money(2),
    });
    expect(new IntentNotPayableError('pi_1', 'expired').name).toBe('IntentNotPayableError');
    expect(new InvalidMoneyError(1.5).name).toBe('InvalidMoneyError');
    expect(new AttemptIntentMismatchError('att_1', 'pi_1').name).toBe('AttemptIntentMismatchError');
  });
});
