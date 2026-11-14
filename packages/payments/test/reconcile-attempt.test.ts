import { describe, expect, it, vi } from 'vitest';
import {
  RAIL_FAILURE_GRACE_MS,
  RailRejectedError,
  RailUnavailableError,
  applyProviderPayment,
  money,
  reconcileAttempt,
  type Clock,
  type PaymentAttempt,
  type PaymentEvent,
  type PaymentFinder,
  type PaymentIntent,
  type ProviderPayment,
} from '../src/index.js';
import { inMemoryStore, type InMemoryStore } from './support/in-memory.js';

const EXPIRES_AT = new Date('2026-11-14T18:06:00.000Z');
const PAID_AT = new Date('2026-11-14T18:05:30.000Z');
const AFTER_EXPIRY = new Date(EXPIRES_AT.getTime() + 15_000);
const BEFORE_EXPIRY = new Date(EXPIRES_AT.getTime() - 60_000);

function anIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return { id: 'pi_1', reference: 'R-1001', amount: money(1), status: 'processing', succeededAt: null, ...overrides };
}

function anAttempt(overrides: Partial<PaymentAttempt> = {}): PaymentAttempt {
  return {
    id: 'att1',
    intentId: 'pi_1',
    mode: 'push',
    status: 'awaiting',
    expiresAt: EXPIRES_AT,
    provider: { transactionId: 'tx1', codiId: 'codi1' },
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
  attempt: PaymentAttempt = anAttempt(),
  intent: PaymentIntent = anIntent(),
  reaction?: (event: PaymentEvent) => Promise<void>,
): InMemoryStore {
  const store = inMemoryStore(reaction);
  store.state.intents.set(intent.id, intent);
  store.state.attempts.set(attempt.id, attempt);
  return store;
}

function at(now: Date): Clock {
  return { now: () => now };
}

function railReturning(...payments: ProviderPayment[]) {
  return { findPayments: vi.fn<PaymentFinder['findPayments']>(() => Promise.resolve(payments)) };
}

function railFailingWith(error: Error) {
  return { findPayments: vi.fn<PaymentFinder['findPayments']>(() => Promise.reject(error)) };
}

const unusedRail: PaymentFinder = {
  findPayments: () => Promise.reject(new Error('the rail must not be called')),
};

describe('reconcileAttempt', () => {
  it('applies a payment the rail reports PAID for an awaiting attempt past expiry', async () => {
    const store = seeded();
    const rail = railReturning(aPayment());

    const result = await reconcileAttempt(store.uow, rail, 'att1', at(AFTER_EXPIRY));

    expect(result).toEqual({ outcome: 'paid', railError: null });
    expect(rail.findPayments).toHaveBeenCalledExactlyOnceWith({ transactionId: 'tx1' });
    expect(store.state.attempts.get('att1')).toMatchObject({ status: 'succeeded' });
    expect(store.state.intents.get('pi_1')).toMatchObject({ status: 'succeeded', succeededAt: PAID_AT });
    expect(store.state.reactions.map((e) => e.type)).toEqual(['PaymentSucceeded']);
    expect(store.state.events).toEqual([
      expect.objectContaining({ providerTxId: 'tx1', attemptId: 'att1', late: false }),
    ]);
  });

  it('records the reconcile source and the rail lookup as the money trace, nothing more', async () => {
    const store = seeded();

    await reconcileAttempt(store.uow, railReturning(aPayment()), 'att1', at(AFTER_EXPIRY));

    expect(store.state.events[0]?.raw).toEqual({
      source: 'reconcile',
      lookup: { transactionId: 'tx1' },
      payment: aPayment(),
    });
  });

  it('expires an unpaid attempt past expiry, saving the intent before the event reaches the reaction', async () => {
    const seen: string[] = [];
    const store: InMemoryStore = seeded(anAttempt(), anIntent(), (event) => {
      if (event.type === 'AttemptExpired') seen.push(store.state.intents.get(event.intentId)?.status ?? 'missing');
      return Promise.resolve();
    });

    const result = await reconcileAttempt(store.uow, railReturning(), 'att1', at(AFTER_EXPIRY));

    expect(result).toEqual({ outcome: 'expired', railError: null });
    expect(store.state.attempts.get('att1')).toMatchObject({ status: 'expired' });
    expect(store.state.intents.get('pi_1')).toMatchObject({ status: 'expired' });
    expect(store.state.reactions).toEqual([
      { type: 'AttemptExpired', intentId: 'pi_1', reference: 'R-1001', attemptId: 'att1', at: AFTER_EXPIRY },
    ]);
    expect(seen).toEqual(['expired']);
  });

  it('keeps the intent open when another attempt of it is still awaiting', async () => {
    const store = seeded();
    store.state.attempts.set('att2', anAttempt({ id: 'att2', mode: 'qr', provider: { qrId: 'qr2' } }));

    const result = await reconcileAttempt(store.uow, railReturning(), 'att1', at(AFTER_EXPIRY));

    expect(result.outcome).toBe('expired');
    expect(store.state.intents.get('pi_1')).toMatchObject({ status: 'processing' });
    expect(store.state.reactions.map((e) => e.type)).toEqual(['AttemptExpired']);
  });

  it('leaves an unpaid attempt awaiting before its expiry', async () => {
    const store = seeded();

    const result = await reconcileAttempt(store.uow, railReturning(), 'att1', at(BEFORE_EXPIRY));

    expect(result).toEqual({ outcome: 'still_awaiting', railError: null });
    expect(store.state.attempts.get('att1')).toMatchObject({ status: 'awaiting' });
    expect(store.state.reactions).toEqual([]);
  });

  it('expires an attempt the rail never knew (no provider ids) without calling the rail', async () => {
    const store = seeded(anAttempt({ provider: {} }));

    const result = await reconcileAttempt(store.uow, unusedRail, 'att1', at(AFTER_EXPIRY));

    expect(result).toEqual({ outcome: 'expired', railError: null });
    expect(store.state.attempts.get('att1')).toMatchObject({ status: 'expired' });
  });

  it('looks a QR attempt up by its QR id', async () => {
    const store = seeded(anAttempt({ mode: 'qr', provider: { qrId: 'qr1' } }));
    const rail = railReturning();

    await reconcileAttempt(store.uow, rail, 'att1', at(AFTER_EXPIRY));

    expect(rail.findPayments).toHaveBeenCalledExactlyOnceWith({ qrId: 'qr1' });
  });

  it.each([
    ['unavailable', new RailUnavailableError('pey is down', { status: 503 })],
    ['rejected', new RailRejectedError('not found', { status: 404, providerMessage: 'Not found' })],
  ])('does not expire while the rail is %s within the grace period: money might have arrived', async (_name, error) => {
    const store = seeded();
    const justInsideGrace = new Date(EXPIRES_AT.getTime() + RAIL_FAILURE_GRACE_MS - 1);

    const result = await reconcileAttempt(store.uow, railFailingWith(error), 'att1', at(justInsideGrace));

    expect(result).toEqual({ outcome: 'still_awaiting', railError: error });
    expect(store.state.attempts.get('att1')).toMatchObject({ status: 'awaiting' });
    expect(store.state.intents.get('pi_1')).toMatchObject({ status: 'processing' });
    expect(store.state.reactions).toEqual([]);
  });

  it('expires anyway once the rail kept failing for the grace period after expiry', async () => {
    const store = seeded();
    const error = new RailUnavailableError('pey is down', { status: 503 });
    const graceOver = new Date(EXPIRES_AT.getTime() + RAIL_FAILURE_GRACE_MS);

    const result = await reconcileAttempt(store.uow, railFailingWith(error), 'att1', at(graceOver));

    expect(result).toEqual({ outcome: 'expired', railError: error });
    expect(store.state.attempts.get('att1')).toMatchObject({ status: 'expired' });
    expect(store.state.reactions.map((e) => e.type)).toEqual(['AttemptExpired']);
  });

  it('lets an unexpected failure (a bug, not the rail) escape without touching the attempt', async () => {
    const store = seeded();

    await expect(
      reconcileAttempt(store.uow, railFailingWith(new TypeError('boom')), 'att1', at(AFTER_EXPIRY)),
    ).rejects.toThrow(TypeError);
    expect(store.state.attempts.get('att1')).toMatchObject({ status: 'awaiting' });
  });

  it('applies a late payment found for an expired attempt (late-payment watch)', async () => {
    const store = seeded(anAttempt({ status: 'expired' }), anIntent({ status: 'expired' }));

    const result = await reconcileAttempt(store.uow, railReturning(aPayment()), 'att1', at(AFTER_EXPIRY));

    expect(result).toEqual({ outcome: 'paid', railError: null });
    expect(store.state.reactions.map((e) => e.type)).toEqual(['LatePaymentReceived']);
    expect(store.state.events).toEqual([expect.objectContaining({ providerTxId: 'tx1', late: true })]);
  });

  it('reports an expired attempt with nothing paid as expired, and a rail failure without changing it', async () => {
    const store = seeded(anAttempt({ status: 'expired' }), anIntent({ status: 'expired' }));
    const error = new RailUnavailableError('timeout');

    expect(await reconcileAttempt(store.uow, railReturning(), 'att1', at(AFTER_EXPIRY))).toEqual({
      outcome: 'expired',
      railError: null,
    });
    expect(await reconcileAttempt(store.uow, railFailingWith(error), 'att1', at(AFTER_EXPIRY))).toEqual({
      outcome: 'expired',
      railError: error,
    });
    expect(store.state.reactions).toEqual([]);
  });

  it('does not ask the rail about an attempt that is already paid', async () => {
    const store = seeded(anAttempt({ status: 'succeeded' }), anIntent({ status: 'succeeded', succeededAt: PAID_AT }));

    const result = await reconcileAttempt(store.uow, unusedRail, 'att1', at(AFTER_EXPIRY));

    expect(result).toEqual({ outcome: 'paid', railError: null });
  });

  it('applies a payment once when the webhook records it while the rail is being asked', async () => {
    const store = seeded();
    const rail = {
      findPayments: vi.fn<PaymentFinder['findPayments']>(async () => {
        await applyProviderPayment(store.uow, unusedRail, aPayment(), 'webhook', { body: 'webhook' });
        return [aPayment()];
      }),
    };

    const result = await reconcileAttempt(store.uow, rail, 'att1', at(AFTER_EXPIRY));

    expect(result).toEqual({ outcome: 'paid', railError: null });
    expect(store.state.events).toEqual([expect.objectContaining({ providerTxId: 'tx1', raw: { body: 'webhook' } })]);
    expect(store.state.reactions.map((e) => e.type)).toEqual(['PaymentSucceeded']);
  });

  it('expires the hold when the money found has the wrong amount, which stays recorded and flagged', async () => {
    const store = seeded();

    const result = await reconcileAttempt(
      store.uow,
      railReturning(aPayment({ amount: money(500) })),
      'att1',
      at(AFTER_EXPIRY),
    );

    expect(result.outcome).toBe('expired');
    expect(store.state.events).toEqual([expect.objectContaining({ providerTxId: 'tx1', attemptId: 'att1' })]);
    expect(store.state.reactions.map((e) => e.type)).toEqual(['PaymentAmountMismatched', 'AttemptExpired']);
  });

  it('fails loudly for an attempt that does not exist', async () => {
    await expect(reconcileAttempt(seeded().uow, unusedRail, 'nope', at(AFTER_EXPIRY))).rejects.toThrow(/nope/);
  });

  it('never calls the rail inside a unit of work', async () => {
    const store = seeded();
    const rail = {
      findPayments: vi.fn<PaymentFinder['findPayments']>(() => {
        expect(store.inTransaction()).toBe(false);
        return Promise.resolve([]);
      }),
    };

    await reconcileAttempt(store.uow, rail, 'att1', at(AFTER_EXPIRY));

    expect(rail.findPayments).toHaveBeenCalledOnce();
  });
});
