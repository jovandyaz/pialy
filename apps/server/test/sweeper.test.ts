import { randomUUID } from 'node:crypto';
import { createPeyConnector } from '@pialy/connector-pey';
import {
  RailUnavailableError,
  money,
  receiveWebhook,
  type PaymentFinder,
  type ProviderPayment,
} from '@pialy/payments';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBusiness, createDrizzleActiveBookingsReader } from '../src/infrastructure/booking/booking-read-model.js';
import { createDrizzleHoldRepository } from '../src/infrastructure/booking/drizzle-booking-repository.js';
import { createAdvisoryClusterLock } from '../src/infrastructure/db/cluster-lock.js';
import { bookings, flags, outbox, paymentAttempts, paymentEvents, paymentIntents } from '../src/infrastructure/db/schema.js';
import { seedDemo } from '../src/infrastructure/db/seed.js';
import { createDrizzleUnitOfWork } from '../src/infrastructure/payments/drizzle-unit-of-work.js';
import { paymentReaction } from '../src/infrastructure/payments/payment-reaction.js';
import {
  LATE_WATCH_EVERY_TICKS,
  SWEEP_LOCK_KEY,
  isLateWatchTick,
  runSweep,
  type SweepDeps,
} from '../src/jobs/sweeper.js';
import { startRepeating } from '../src/jobs/repeat.js';
import { holdSlotAndCharge, type HoldResponse } from '../src/modules/booking/application/hold-slot.js';
import { cleanDb, openTestDb } from './support.js';

const handle = openTestDb();
const { db } = handle;
afterAll(() => handle.close());
beforeEach(async () => {
  await cleanDb(handle);
  vi.clearAllMocks();
});

const NOW = new Date('2026-11-14T18:00:00.000Z');
const EXPIRES_AT = new Date('2026-11-14T18:06:00.000Z');
const NEXT_TICK = new Date('2026-11-14T18:06:15.000Z');
const SLOT = new Date('2026-11-15T15:00:00.000Z');
const OTHER_SLOT = new Date('2026-11-15T16:30:00.000Z');
const PHONE = '55 1234 5678';
const PHONE10 = '5512345678';
const OTHER_PHONE = '55 8765 4321';
const SALT = 'test-phone-hash-salt';
const TX = '01M7E2CQ901RDPP1863FW43YP8';
const OTHER_TX = '01M7E2CQ901RDPP1863FW43ZZ9';
const CLABE = '012180001234567890';
const MINUTE_MS = 60_000;

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const holdLog = { warn: vi.fn(), error: vi.fn() };

const fetchMock = vi.fn<typeof fetch>();
afterEach(() => fetchMock.mockReset());
const pey = createPeyConnector({
  apiKey: 'pey_test_key',
  baseUrl: 'https://api.pey.test',
  webhookSecret: `whsec_${Buffer.from('pialy-sweeper-test-secret').toString('base64')}`,
  fetch: fetchMock,
  sleep: () => Promise.resolve(),
});

function peyAnswers(status: number, body: unknown): void {
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    ),
  );
}

function pendingAtPey(id = TX): Record<string, unknown> {
  return { id, status: 'PENDING', amount: 0.01, currency: 'MXN', dateCreated: Math.floor(NOW.getTime() / 1000) };
}

function paidAtPey(id = TX, paidAt = new Date('2026-11-14T18:05:50.000Z')): Record<string, unknown> {
  return {
    id,
    status: 'PAID',
    amount: 0.01,
    amountBreakdown: { base: 0.01, tip: 0, fee: 0 },
    currency: 'MXN',
    datePaid: Math.floor(paidAt.getTime() / 1000),
    metadata: { clabe: CLABE, bankCode: 40012, trackingKey: '0192191042' },
  };
}

function paid(transactionId = TX): ProviderPayment {
  return {
    providerTxId: transactionId,
    amount: money(1),
    paidAt: new Date('2026-11-14T18:05:50.000Z'),
    trackingKey: '0192191042',
    ref: { transactionId },
  };
}

interface Held {
  readonly token: string;
  readonly bookingId: string;
  readonly attemptId: string;
}

async function hold(options: { phone?: string; slot?: Date; tx?: string; at?: Date } = {}): Promise<Held> {
  await seedDemo(db);
  const response: HoldResponse = await holdSlotAndCharge(
    {
      holds: createDrizzleHoldRepository(db),
      rail: { createPushCharge: () => Promise.resolve({ transactionId: options.tx ?? TX, codiId: '12345678901234567890' }) },
      clock: { now: () => options.at ?? NOW },
      business: await loadBusiness(db),
      deposit: money(1),
      phoneHashSalt: SALT,
      log: holdLog,
    },
    { slotStart: options.slot ?? SLOT, phone: options.phone ?? PHONE, idempotencyKey: randomUUID() },
  );
  if (response.status !== 201) throw new Error(`hold failed with ${response.status}`);
  const [row] = await db
    .select({ bookingId: bookings.id, attemptId: paymentAttempts.id })
    .from(bookings)
    .innerJoin(paymentAttempts, eq(paymentAttempts.intentId, bookings.intentId))
    .where(eq(bookings.token, response.body.token));
  if (row === undefined) throw new Error('hold has no attempt');
  return { token: response.body.token, ...row };
}

function deps(rail: PaymentFinder, now: Date): SweepDeps {
  return {
    db,
    lock: createAdvisoryClusterLock(handle.client, SWEEP_LOCK_KEY),
    uow: createDrizzleUnitOfWork(db, paymentReaction),
    rail,
    clock: { now: () => now },
    log,
  };
}

function railReturning(...payments: ProviderPayment[]) {
  return { findPayments: vi.fn<PaymentFinder['findPayments']>(() => Promise.resolve(payments)) };
}

async function bookingOf(held: Held) {
  const [row] = await db.select().from(bookings).where(eq(bookings.id, held.bookingId));
  if (row === undefined) throw new Error('booking vanished');
  return row;
}

async function attemptOf(held: Held) {
  const [row] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, held.attemptId));
  if (row === undefined) throw new Error('attempt vanished');
  return row;
}

function logged(): string {
  return JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
}

describe('runSweep: awaiting attempts past expiry', () => {
  it('confirms a hold the rail reports PAID, and the webhook arriving later changes nothing', async () => {
    const held = await hold();
    peyAnswers(200, paidAtPey());

    const result = await runSweep(deps(pey, NEXT_TICK));

    expect(result).toEqual({ checked: 1 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.pey.test/transaction/${TX}`);
    expect(await bookingOf(held)).toMatchObject({ status: 'confirmed', late: false });
    expect(await attemptOf(held)).toMatchObject({ status: 'succeeded' });
    expect(await db.select().from(paymentIntents)).toEqual([expect.objectContaining({ status: 'succeeded' })]);
    const [event] = await db.select().from(paymentEvents);
    expect(event).toMatchObject({ providerTxId: TX, attemptId: held.attemptId, amountMinor: 1, late: false });
    expect(JSON.stringify(event?.raw)).not.toContain(CLABE);

    const outcome = await receiveWebhook(
      createDrizzleUnitOfWork(db, paymentReaction),
      pey,
      { webhookId: 'msg_after_reconcile', eventType: 'codi.pn.payment_received', payment: paid() },
      { body: 'webhook' },
    );

    expect(outcome).toBe('duplicate');
    expect(await db.select().from(paymentEvents)).toHaveLength(1);
    expect(await db.select().from(flags)).toEqual([]);
    expect(await bookingOf(held)).toMatchObject({ status: 'confirmed', late: false });
  });

  it('bounds a hold: PENDING at the rail after expiry → expired, slot free, the same phone can hold again', async () => {
    const held = await hold();
    peyAnswers(200, pendingAtPey());

    expect(await runSweep(deps(pey, NEXT_TICK))).toEqual({ checked: 1 });

    expect(await bookingOf(held)).toMatchObject({ status: 'expired' });
    expect(await attemptOf(held)).toMatchObject({ status: 'expired' });
    expect(await db.select().from(paymentIntents)).toEqual([expect.objectContaining({ status: 'expired' })]);
    const business = await loadBusiness(db);
    const active = await createDrizzleActiveBookingsReader(db).activeBookings(business.resourceId, {
      start: SLOT,
      end: new Date(SLOT.getTime() + 45 * MINUTE_MS),
    });
    expect(active).toEqual([]);
    const expiredNotices = (await db.select().from(outbox))
      .filter((row) => (row.payload as { status: string }).status === 'expired')
      .map((row) => row.topic)
      .sort();
    expect(expiredNotices).toEqual(['board', `booking:${held.token}`]);

    const again = await hold({ at: NEXT_TICK, tx: OTHER_TX });

    expect(await bookingOf(again)).toMatchObject({ status: 'holding', slotStart: SLOT });
  });

  it('leaves a hold alone before it expires', async () => {
    const held = await hold();
    const rail = railReturning();

    expect(await runSweep(deps(rail, new Date(EXPIRES_AT.getTime() - 1)))).toEqual({ checked: 0 });

    expect(rail.findPayments).not.toHaveBeenCalled();
    expect(await bookingOf(held)).toMatchObject({ status: 'holding' });
  });

  it('keeps the hold while the rail fails for 10 minutes after expiry, then expires it anyway', async () => {
    const held = await hold();
    const rail = {
      findPayments: vi.fn<PaymentFinder['findPayments']>(() =>
        Promise.reject(new RailUnavailableError(`pey said 5512345678 is down`, { status: 503 })),
      ),
    };

    await runSweep(deps(rail, NEXT_TICK));
    await runSweep(deps(rail, new Date(EXPIRES_AT.getTime() + 10 * MINUTE_MS - 1)));

    expect(await bookingOf(held)).toMatchObject({ status: 'holding' });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: held.attemptId, rail: { name: 'RailUnavailableError', status: 503 } }),
      expect.any(String),
    );

    await runSweep(deps(rail, new Date(EXPIRES_AT.getTime() + 10 * MINUTE_MS)));

    expect(await bookingOf(held)).toMatchObject({ status: 'expired' });
    expect(logged()).not.toContain(PHONE10);
  });

  it('expires a hold whose push never reached the rail (no provider ids) without calling the rail', async () => {
    const held = await hold();
    await db.update(paymentAttempts).set({ providerTxId: null, codiId: null }).where(eq(paymentAttempts.id, held.attemptId));
    const rail = railReturning();

    expect(await runSweep(deps(rail, NEXT_TICK))).toEqual({ checked: 1 });

    expect(rail.findPayments).not.toHaveBeenCalled();
    expect(await bookingOf(held)).toMatchObject({ status: 'expired' });
  });

  it('keeps sweeping the other holds when one of them fails', async () => {
    const broken = await hold({ tx: TX });
    const fine = await hold({ tx: OTHER_TX, phone: OTHER_PHONE, slot: OTHER_SLOT });
    const rail = {
      findPayments: vi.fn<PaymentFinder['findPayments']>((ref) =>
        'transactionId' in ref && ref.transactionId === TX ? Promise.reject(new TypeError('bug')) : Promise.resolve([]),
      ),
    };

    expect(await runSweep(deps(rail, NEXT_TICK))).toEqual({ checked: 2 });

    expect(await bookingOf(broken)).toMatchObject({ status: 'holding' });
    expect(await bookingOf(fine)).toMatchObject({ status: 'expired' });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: broken.attemptId, err: expect.objectContaining({ name: 'TypeError' }) }),
      expect.any(String),
    );
  });

  it('expires a stale hold whose expiry passed hours ago on the first tick, even if the rail answers 404', async () => {
    const held = await hold({ at: new Date('2026-11-14T22:14:00.000Z'), slot: new Date('2026-11-16T15:00:00.000Z') });
    peyAnswers(404, { error: { message: 'Transaction not found', type: 'NOT_FOUND', requestId: 'req_1' } });

    expect(await runSweep(deps(pey, new Date('2026-11-15T02:00:00.000Z')))).toEqual({ checked: 1 });

    expect(await bookingOf(held)).toMatchObject({ status: 'expired' });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: held.attemptId, outcome: 'expired', rail: { name: 'RailRejectedError', status: 404 } }),
      expect.any(String),
    );
  });

  it('skips the sweep while another instance holds the cluster lock', async () => {
    const held = await hold();
    const rail = railReturning();
    const other = await handle.client.reserve();
    try {
      await other`select pg_advisory_lock(${SWEEP_LOCK_KEY}::bigint)`;

      expect(await runSweep(deps(rail, NEXT_TICK))).toEqual({ checked: 0 });
      expect(await bookingOf(held)).toMatchObject({ status: 'holding' });

      await other`select pg_advisory_unlock(${SWEEP_LOCK_KEY}::bigint)`;
    } finally {
      other.release();
    }

    expect(await runSweep(deps(rail, NEXT_TICK))).toEqual({ checked: 1 });
    expect(await bookingOf(held)).toMatchObject({ status: 'expired' });
  });

  it('releases the cluster lock after a sweep, so it is not left on a pooled connection', async () => {
    await hold();
    await runSweep(deps(railReturning(), NEXT_TICK));

    const [row] = (await db.execute(
      sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = ${SWEEP_LOCK_KEY}`,
    )) as unknown as [{ n: number }];
    expect(row.n).toBe(0);
  });

  it('stops between attempts once asked to', async () => {
    await hold({ tx: TX });
    await hold({ tx: OTHER_TX, phone: OTHER_PHONE, slot: OTHER_SLOT });
    const controller = new AbortController();
    const rail = {
      findPayments: vi.fn<PaymentFinder['findPayments']>(() => {
        controller.abort();
        return Promise.resolve([]);
      }),
    };

    expect(await runSweep(deps(rail, NEXT_TICK), { signal: controller.signal })).toEqual({ checked: 1 });
    expect(rail.findPayments).toHaveBeenCalledOnce();
  });
});

describe('runSweep: late-payment watch', () => {
  async function expiredHold(options: Parameters<typeof hold>[0] = {}): Promise<Held> {
    const held = await hold(options);
    await runSweep(deps(railReturning(), NEXT_TICK));
    expect(await bookingOf(held)).toMatchObject({ status: 'expired' });
    return held;
  }

  it('only looks at expired attempts when asked (every 4th tick)', async () => {
    await expiredHold();
    const rail = railReturning(paid());

    expect(await runSweep(deps(rail, new Date(NEXT_TICK.getTime() + MINUTE_MS)))).toEqual({ checked: 0 });
    expect(rail.findPayments).not.toHaveBeenCalled();
  });

  it('confirms the booking as late when money arrived after expiry and the slot is still free', async () => {
    const held = await expiredHold();

    const result = await runSweep(deps(railReturning(paid()), new Date(NEXT_TICK.getTime() + MINUTE_MS)), {
      lateWatch: true,
    });

    expect(result).toEqual({ checked: 1 });
    expect(await bookingOf(held)).toMatchObject({ status: 'confirmed', late: true });
    expect(await db.select().from(paymentEvents)).toEqual([expect.objectContaining({ providerTxId: TX, late: true })]);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: held.attemptId, outcome: 'paid' }),
      expect.any(String),
    );
  });

  it('flags the money as refund due when another booking took the slot meanwhile', async () => {
    const held = await expiredHold();
    const taker = await hold({ phone: OTHER_PHONE, tx: OTHER_TX, at: NEXT_TICK });

    await runSweep(deps(railReturning(paid()), new Date(NEXT_TICK.getTime() + MINUTE_MS)), { lateWatch: true });

    expect(await bookingOf(held)).toMatchObject({ status: 'expired' });
    expect(await bookingOf(taker)).toMatchObject({ status: 'holding' });
    expect(await db.select().from(flags)).toEqual([
      expect.objectContaining({ kind: 'refund_due', bookingId: held.bookingId }),
    ]);
  });

  it('stops watching an attempt 30 minutes after it expired', async () => {
    await expiredHold();
    const rail = railReturning(paid());

    await runSweep(deps(rail, new Date(EXPIRES_AT.getTime() + 30 * MINUTE_MS)), { lateWatch: true });

    expect(rail.findPayments).not.toHaveBeenCalled();
  });

  it('does not log the unchanged expired attempts it re-checks', async () => {
    await expiredHold();
    log.info.mockClear();

    await runSweep(deps(railReturning(), new Date(NEXT_TICK.getTime() + MINUTE_MS)), { lateWatch: true });

    expect(log.info).not.toHaveBeenCalled();
  });
});

describe('sweeper schedule', () => {
  it('runs the late-payment watch on the first tick and on every 4th tick after it', () => {
    const ticks = Array.from({ length: 9 }, (_, tick) => isLateWatchTick(tick));

    expect(LATE_WATCH_EVERY_TICKS).toBe(4);
    expect(ticks).toEqual([true, false, false, false, true, false, false, false, true]);
  });
});

describe('startRepeating', () => {
  afterEach(() => vi.useRealTimers());

  it('runs at once, then an interval after each run ends; a failed run is logged and the next still runs', async () => {
    vi.useFakeTimers();
    const errors = { error: vi.fn() };
    let runs = 0;
    const job = startRepeating(
      'job',
      () => {
        runs += 1;
        return runs === 2 ? Promise.reject(new Error('boom')) : Promise.resolve();
      },
      1000,
      errors,
    );

    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(3);
    expect(errors.error).toHaveBeenCalledWith(
      expect.objectContaining({ job: 'job', err: expect.objectContaining({ name: 'Error', message: 'boom' }) }),
      expect.any(String),
    );

    await job.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toBe(3);
  });

  it('never overlaps runs and waits for the one in progress when stopped', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let signal!: AbortSignal;
    let runs = 0;
    const job = startRepeating(
      'job',
      (s) => {
        runs += 1;
        signal = s;
        return new Promise<void>((resolve) => (finish = resolve));
      },
      1000,
      { error: vi.fn() },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs).toBe(1);

    let stopped = false;
    const stopping = job.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(signal.aborted).toBe(true);
    expect(stopped).toBe(false);

    finish();
    await stopping;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs).toBe(1);
  });
});
