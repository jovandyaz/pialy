import { describe, expect, it, vi } from 'vitest';
import {
  RailUnavailableError,
  applyProviderPayment,
  money,
  receiveWebhook,
  type PaymentAttempt,
  type PaymentFinder,
  type PaymentIntent,
  type ProviderPayment,
} from '../src/index.js';
import { inMemoryStore, type InMemoryStore } from './support/in-memory.js';

const PAID_AT = new Date('2026-11-14T18:02:30.000Z');
const EXPIRES_AT = new Date('2026-11-14T18:06:00.000Z');
const RAW = { body: 'as delivered' };

function anIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'pi_1',
    reference: 'R-1001',
    amount: money(1),
    status: 'processing',
    succeededAt: null,
    ...overrides,
  };
}

function anAttempt(overrides: Partial<PaymentAttempt> = {}): PaymentAttempt {
  return {
    id: 'att1',
    intentId: 'pi_1',
    mode: 'push',
    status: 'awaiting',
    expiresAt: EXPIRES_AT,
    provider: { transactionId: 'tx1' },
    ...overrides,
  };
}

function aPayment(overrides: Partial<ProviderPayment> = {}): ProviderPayment {
  return {
    providerTxId: 'tx1',
    amount: money(1),
    paidAt: PAID_AT,
    trackingKey: 'TRK1',
    ref: { transactionId: 'tx1' },
    ...overrides,
  };
}

function seeded(
  intents: readonly PaymentIntent[] = [anIntent()],
  attempts: readonly PaymentAttempt[] = [anAttempt()],
  reaction?: Parameters<typeof inMemoryStore>[0],
): InMemoryStore {
  const store = inMemoryStore(reaction);
  for (const intent of intents) store.state.intents.set(intent.id, intent);
  for (const attempt of attempts) store.state.attempts.set(attempt.id, attempt);
  return store;
}

function railReturning(...payments: ProviderPayment[]): PaymentFinder & { findPayments: ReturnType<typeof vi.fn> } {
  return { findPayments: vi.fn<PaymentFinder['findPayments']>(() => Promise.resolve(payments)) };
}

const unusedRail: PaymentFinder = {
  findPayments: () => Promise.reject(new Error('the rail must not be called')),
};

describe('applyProviderPayment', () => {
  it('applies a matched payment once and records its money trace', async () => {
    const store = seeded();

    const outcome = await applyProviderPayment(store.uow, unusedRail, aPayment(), 'webhook', RAW);

    expect(outcome).toBe('applied');
    expect(store.state.intents.get('pi_1')).toMatchObject({ status: 'succeeded', succeededAt: PAID_AT });
    expect(store.state.attempts.get('att1')).toMatchObject({ status: 'succeeded' });
    expect(store.state.events).toStrictEqual([
      {
        providerTxId: 'tx1',
        intentId: 'pi_1',
        attemptId: 'att1',
        amount: money(1),
        trackingKey: 'TRK1',
        late: false,
        raw: RAW,
      },
    ]);
    expect(store.state.reactions.map((e) => e.type)).toStrictEqual(['PaymentSucceeded']);
  });

  it('reports a second delivery of the same bank payment as duplicate and records nothing new', async () => {
    const store = seeded();
    await applyProviderPayment(store.uow, unusedRail, aPayment(), 'webhook', RAW);

    const outcome = await applyProviderPayment(store.uow, unusedRail, aPayment(), 'reconcile', RAW);

    expect(outcome).toBe('duplicate');
    expect(store.state.events).toHaveLength(1);
    expect(store.state.reactions).toHaveLength(1);
  });

  it('matches by our attempt id when the rail transaction id is not stored yet', async () => {
    const store = seeded([anIntent()], [anAttempt({ provider: {} })]);
    const payment = aPayment({ ref: { transactionId: 'tx1', attemptId: 'att1' } });

    const outcome = await applyProviderPayment(store.uow, unusedRail, payment, 'webhook', RAW);

    expect(outcome).toBe('applied');
    expect(store.state.attempts.get('att1')).toMatchObject({
      status: 'succeeded',
      provider: { transactionId: 'tx1' },
    });
    expect(store.state.events[0]).toMatchObject({ attemptId: 'att1' });
  });

  it('prefers the rail transaction id, then the QR id, over our attempt id', async () => {
    const intents = [anIntent(), anIntent({ id: 'pi_2', reference: 'R-1002' })];
    const pushAttempt = anAttempt({ id: 'att_push', provider: { transactionId: 'tx1' } });
    const qrAttempt = anAttempt({ id: 'att_qr', intentId: 'pi_2', mode: 'qr', provider: { qrId: 'qr9' } });
    const other = anAttempt({ id: 'att_other', intentId: 'pi_2', provider: {} });
    const store = seeded(intents, [pushAttempt, qrAttempt, other]);

    await applyProviderPayment(
      store.uow,
      unusedRail,
      aPayment({ ref: { transactionId: 'tx1', qrId: 'qr9', attemptId: 'att_other' } }),
      'webhook',
      RAW,
    );
    await applyProviderPayment(
      store.uow,
      unusedRail,
      aPayment({ providerTxId: 'tx2', ref: { transactionId: 'tx2', qrId: 'qr9', attemptId: 'att_other' } }),
      'webhook',
      RAW,
    );

    expect(store.state.events.map((e) => e.attemptId)).toStrictEqual(['att_push', 'att_qr']);
    expect(store.state.attempts.get('att_other')).toMatchObject({ status: 'awaiting' });
  });

  it('records an unmatched payment without applying it and reports it to the reaction', async () => {
    const store = seeded();
    const payment = aPayment({ providerTxId: 'tx_stray', ref: { transactionId: 'tx_stray', attemptId: 'nope' } });

    const outcome = await applyProviderPayment(store.uow, unusedRail, payment, 'webhook', RAW);

    expect(outcome).toBe('unmatched');
    expect(store.state.events).toStrictEqual([
      expect.objectContaining({ providerTxId: 'tx_stray', intentId: null, attemptId: null }),
    ]);
    expect(store.state.reactions).toStrictEqual([
      {
        type: 'UnmatchedPaymentReceived',
        providerTxId: 'tx_stray',
        amount: money(1),
        ref: { transactionId: 'tx_stray', attemptId: 'nope' },
        trackingKey: 'TRK1',
        at: PAID_AT,
      },
    ]);
    expect(store.state.intents.get('pi_1')).toMatchObject({ status: 'processing' });
  });

  it('marks a payment for an expired intent as late', async () => {
    const store = seeded([anIntent({ status: 'expired' })], [anAttempt({ status: 'expired' })]);

    const outcome = await applyProviderPayment(store.uow, unusedRail, aPayment(), 'reconcile', RAW);

    expect(outcome).toBe('applied');
    expect(store.state.events[0]).toMatchObject({ late: true });
    expect(store.state.reactions.map((e) => e.type)).toStrictEqual(['LatePaymentReceived']);
  });

  describe('when the delivered amount differs from the intent', () => {
    const feeIncluded = aPayment({ amount: money(3) });

    it('re-reads the base amount from the rail outside the transaction and applies it when it matches', async () => {
      const store = seeded();
      const rail: PaymentFinder = {
        findPayments: vi.fn(() => {
          expect(store.inTransaction()).toBe(false);
          return Promise.resolve([aPayment({ amount: money(1) })]);
        }),
      };

      const outcome = await applyProviderPayment(store.uow, rail, feeIncluded, 'webhook', RAW);

      expect(outcome).toBe('applied');
      expect(rail.findPayments).toHaveBeenCalledWith({ transactionId: 'tx1' });
      expect(store.state.events).toStrictEqual([expect.objectContaining({ amount: money(1), attemptId: 'att1' })]);
      expect(store.state.intents.get('pi_1')).toMatchObject({ status: 'succeeded' });
    });

    it('keeps the money trace and reports the mismatch when the rail confirms a wrong amount', async () => {
      const store = seeded();
      const rail = railReturning(aPayment({ amount: money(2) }));

      const outcome = await applyProviderPayment(store.uow, rail, feeIncluded, 'webhook', RAW);

      expect(outcome).toBe('unmatched');
      expect(store.state.events).toStrictEqual([
        expect.objectContaining({ providerTxId: 'tx1', intentId: 'pi_1', attemptId: 'att1', amount: money(2) }),
      ]);
      expect(store.state.reactions).toStrictEqual([
        {
          type: 'PaymentAmountMismatched',
          intentId: 'pi_1',
          reference: 'R-1001',
          attemptId: 'att1',
          providerTxId: 'tx1',
          expected: money(1),
          received: money(2),
          amountCheck: 'rail_lookup',
          at: PAID_AT,
        },
      ]);
      expect(store.state.intents.get('pi_1')).toMatchObject({ status: 'processing' });
      expect(store.state.attempts.get('att1')).toMatchObject({ status: 'awaiting' });
    });

    it('reports the mismatch with the delivered amount when the rail cannot be asked', async () => {
      const store = seeded();
      const rail: PaymentFinder = {
        findPayments: () => Promise.reject(new RailUnavailableError('pey GET /transaction/tx1 failed: request timed out')),
      };

      const outcome = await applyProviderPayment(store.uow, rail, feeIncluded, 'webhook', RAW);

      expect(outcome).toBe('unmatched');
      expect(store.state.events).toStrictEqual([expect.objectContaining({ amount: money(3), attemptId: 'att1' })]);
      expect(store.state.reactions).toStrictEqual([
        expect.objectContaining({
          type: 'PaymentAmountMismatched',
          received: money(3),
          amountCheck: 'rail_lookup_failed',
          lookupError: 'RailUnavailableError: pey GET /transaction/tx1 failed: request timed out',
        }),
      ]);
    });

    it('reports the mismatch when the rail has no paid transaction with that id', async () => {
      const store = seeded();

      const outcome = await applyProviderPayment(store.uow, railReturning(), feeIncluded, 'webhook', RAW);

      expect(outcome).toBe('unmatched');
      expect(store.state.reactions).toStrictEqual([
        expect.objectContaining({ amountCheck: 'rail_lookup_failed', received: money(3) }),
      ]);
    });

    it('does not ask the rail again for a reconciled payment, which already carries its base amount', async () => {
      const store = seeded();

      const outcome = await applyProviderPayment(store.uow, unusedRail, feeIncluded, 'reconcile', RAW);

      expect(outcome).toBe('unmatched');
      expect(store.state.reactions).toStrictEqual([expect.objectContaining({ amountCheck: 'none' })]);
    });

    it('fails loudly and records nothing on an unexpected rail error', async () => {
      const store = seeded();
      const rail: PaymentFinder = { findPayments: () => Promise.reject(new TypeError('bug')) };

      await expect(applyProviderPayment(store.uow, rail, feeIncluded, 'webhook', RAW)).rejects.toThrow('bug');
      expect(store.state.events).toHaveLength(0);
    });
  });
});

describe('receiveWebhook', () => {
  const webhook = { webhookId: 'msg_1', eventType: 'codi.pn.payment_received', payment: aPayment() };

  it('logs the delivery and applies its payment in one unit of work', async () => {
    const store = seeded();

    const outcome = await receiveWebhook(store.uow, unusedRail, webhook, RAW);

    expect(outcome).toBe('applied');
    expect(store.state.inbox.get('msg_1')).toStrictEqual({
      eventType: 'codi.pn.payment_received',
      outcome: 'applied',
    });
    expect(store.state.events).toHaveLength(1);
  });

  it('skips a delivery it has already processed', async () => {
    const store = seeded();
    await receiveWebhook(store.uow, unusedRail, webhook, RAW);

    const outcome = await receiveWebhook(store.uow, unusedRail, webhook, RAW);

    expect(outcome).toBe('duplicate');
    expect(store.state.events).toHaveLength(1);
    expect(store.state.reactions).toHaveLength(1);
    expect(store.state.inbox.get('msg_1')?.outcome).toBe('applied');
  });

  it('logs a delivery that reports no payment as ignored', async () => {
    const store = seeded();

    const outcome = await receiveWebhook(
      store.uow,
      unusedRail,
      { webhookId: 'msg_2', eventType: 'bank_account.updated', payment: null },
      RAW,
    );

    expect(outcome).toBe('ignored');
    expect(store.state.inbox.get('msg_2')).toStrictEqual({ eventType: 'bank_account.updated', outcome: 'ignored' });
    expect(store.state.events).toHaveLength(0);
  });

  it('leaves no trace when applying fails, so the rail can redeliver', async () => {
    let failing = true;
    const store = seeded(undefined, undefined, () =>
      failing ? Promise.reject(new Error('reaction crashed')) : Promise.resolve(),
    );

    await expect(receiveWebhook(store.uow, unusedRail, webhook, RAW)).rejects.toThrow('reaction crashed');
    expect(store.state.inbox.size).toBe(0);
    expect(store.state.events).toHaveLength(0);
    expect(store.state.intents.get('pi_1')).toMatchObject({ status: 'processing' });

    failing = false;
    expect(await receiveWebhook(store.uow, unusedRail, webhook, RAW)).toBe('applied');
  });

  it('logs the delivery after the amount is re-read from the rail', async () => {
    const store = seeded();
    const rail = railReturning(aPayment({ amount: money(1) }));

    const outcome = await receiveWebhook(
      store.uow,
      rail,
      { ...webhook, payment: aPayment({ amount: money(3) }) },
      RAW,
    );

    expect(outcome).toBe('applied');
    expect(store.state.inbox.get('msg_1')?.outcome).toBe('applied');
  });
});
