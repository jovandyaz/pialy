import { createHmac, randomUUID } from 'node:crypto';
import {
  RailRejectedError,
  RailUnavailableError,
  applyProviderPayment,
  money,
  type ProviderPayment,
  type PushChargeInput,
  type RailConnector,
} from '@pialy/payments';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBusiness } from '../src/infrastructure/booking/booking-read-model.js';
import { createDrizzleHoldRepository } from '../src/infrastructure/booking/drizzle-booking-repository.js';
import {
  bookings,
  flags,
  idempotencyKeys,
  outbox,
  paymentAttempts,
  paymentEvents,
  paymentIntents,
} from '../src/infrastructure/db/schema.js';
import { seedDemo } from '../src/infrastructure/db/seed.js';
import { createDrizzleUnitOfWork } from '../src/infrastructure/payments/drizzle-unit-of-work.js';
import { paymentReaction } from '../src/infrastructure/payments/payment-reaction.js';
import {
  IdempotencyKeyInFlightError,
  IdempotencyKeyReusedError,
  PUSH_FAILED_DETAIL,
  holdSlotAndCharge,
  type HoldResponse,
  type HoldSlotDeps,
  type HoldSlotInput,
} from '../src/modules/booking/application/hold-slot.js';
import {
  ActiveHoldExistsError,
  SlotTakenError,
  TooManyHoldsForPhoneError,
} from '../src/modules/booking/domain/booking.js';
import { cleanDb, openTestDb } from './support.js';

const handle = openTestDb();
const { db } = handle;
afterAll(() => handle.close());
beforeEach(async () => {
  await cleanDb(handle);
  log.warn.mockClear();
  log.error.mockClear();
});

const NOW = new Date('2026-11-14T18:00:00.000Z');
const HOLD_EXPIRES_AT = '2026-11-14T18:06:00.000Z';
const SLOT = new Date('2026-11-15T15:00:00.000Z');
const PHONE = '55 1234 5678';
const PHONE10 = '5512345678';
const SALT = 'test-phone-hash-salt';
const TX = '01J5KXYZ1234567890ABCD';
const CODI = '12345678901234567890';

type PushCharge = RailConnector['createPushCharge'];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function okPush(): ReturnType<typeof vi.fn<PushCharge>> {
  return vi.fn<PushCharge>(() => Promise.resolve({ transactionId: TX, codiId: CODI }));
}

const log = { warn: vi.fn(), error: vi.fn() };

async function deps(push: PushCharge, overrides: Partial<HoldSlotDeps> = {}): Promise<HoldSlotDeps> {
  await seedDemo(db);
  return {
    holds: createDrizzleHoldRepository(db),
    rail: { createPushCharge: push },
    clock: { now: () => NOW },
    business: await loadBusiness(db),
    deposit: money(1),
    phoneHashSalt: SALT,
    log,
    ...overrides,
  };
}

function phoneFor(n: number): string {
  return String(5_500_000_000 + n);
}

function input(overrides: Partial<HoldSlotInput> = {}): HoldSlotInput {
  return { slotStart: SLOT, phone: PHONE, customerName: 'Ana', idempotencyKey: randomUUID(), ...overrides };
}

function held(response: HoldResponse): { token: string; holdExpiresAt: string } {
  if (response.status !== 201) throw new Error(`expected 201, got ${response.status}`);
  return response.body;
}

async function onlyBooking() {
  const rows = await db.select().from(bookings);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const uow = () => createDrizzleUnitOfWork(db, paymentReaction);
const MINUTE_MS = 60_000;

async function waitForLockWaiters(count: number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const [row] = (await db.execute(
      sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    )) as unknown as [{ n: number }];
    if (row.n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`never saw ${count} transactions waiting on a lock`);
}

/**
 * Parks every request on its idempotency key behind an uncommitted insert of the same keys, then
 * rolls it back so all of them run their hold transaction at the same instant.
 */
async function releasedTogether<T>(keys: readonly string[], start: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let parked!: () => void;
  const keysTaken = new Promise<void>((resolve) => (parked = resolve));
  const blocker = db
    .transaction(async (tx) => {
      await tx.insert(idempotencyKeys).values(keys.map((key) => ({ key, scope: 'hold', requestHash: 'gate' })));
      parked();
      await gate;
      tx.rollback();
    })
    .catch(() => undefined);
  await keysTaken;
  const started = start();
  try {
    await waitForLockWaiters(keys.length);
  } finally {
    release();
    await blocker;
  }
  return started;
}
const noRail = { findPayments: () => Promise.resolve([]) };

function paymentFor(attemptId: string, providerTxId = TX): ProviderPayment {
  return {
    providerTxId,
    amount: money(1),
    paidAt: new Date('2026-11-14T18:02:00.000Z'),
    trackingKey: '0192191042',
    ref: { attemptId },
  };
}

describe('holdSlotAndCharge', () => {
  it('holds the slot, sends one CoDi push and stores only the last 4 digits and a hash of the phone', async () => {
    const push = okPush();
    const d = await deps(push);

    const response = await holdSlotAndCharge(d, input());

    expect(response.status).toBe(201);
    const body = held(response);
    expect(body.holdExpiresAt).toBe(HOLD_EXPIRES_AT);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    const booking = await onlyBooking();
    const [attempt] = await db.select().from(paymentAttempts);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0]).toEqual<PushChargeInput>({
      amount: money(1),
      phone10: PHONE10,
      concept: 'Anticipo Estudio Demo',
      expiresInSec: 360,
      numRef: String(booking.number),
      metadata: { bookingId: booking.id, attemptId: attempt!.id },
    });
    expect(booking).toMatchObject({
      token: body.token,
      status: 'holding',
      slotStart: SLOT,
      during: { start: SLOT, end: new Date('2026-11-15T15:45:00.000Z') },
      customerName: 'Ana',
      phoneLast4: '5678',
      phoneHash: createHmac('sha256', SALT).update(PHONE10).digest('hex'),
      holdExpiresAt: new Date(HOLD_EXPIRES_AT),
      late: false,
    });
    expect(attempt).toMatchObject({
      intentId: booking.intentId,
      mode: 'push',
      status: 'awaiting',
      providerTxId: TX,
      codiId: CODI,
      expiresAt: new Date(HOLD_EXPIRES_AT),
    });
    expect(await db.select().from(paymentIntents)).toEqual([
      expect.objectContaining({ id: booking.intentId, amountMinor: 1, status: 'processing' }),
    ]);
    const [key] = await db.select().from(idempotencyKeys);
    expect(key).toMatchObject({ scope: 'hold', recoveryPoint: 'finished', responseCode: 201, lockedAt: null });
    expect(key?.responseBody).toEqual(body);
    const topics = (await db.select().from(outbox)).map((row) => row.topic).sort();
    expect(topics).toEqual(['board', `booking:${body.token}`]);

    const everything = JSON.stringify(
      await Promise.all(
        [bookings, idempotencyKeys, outbox, paymentIntents, paymentAttempts].map((t) => db.select().from(t)),
      ),
    );
    expect(everything).not.toContain(PHONE10);
  });

  it('RF1: replays the stored response for the same key: one booking, one push, identical response', async () => {
    const push = okPush();
    const d = await deps(push);
    const request = input();

    const first = await holdSlotAndCharge(d, request);
    const second = await holdSlotAndCharge(d, request);

    expect(second).toEqual(first);
    expect(push).toHaveBeenCalledTimes(1);
    await onlyBooking();
    expect(await db.select().from(paymentAttempts)).toHaveLength(1);
  });

  it('treats a differently formatted but equal phone as the same request', async () => {
    const push = okPush();
    const d = await deps(push);
    const key = randomUUID();

    const first = await holdSlotAndCharge(d, input({ idempotencyKey: key, phone: '+52 55 1234 5678' }));
    const second = await holdSlotAndCharge(d, input({ idempotencyKey: key, phone: '5512345678' }));

    expect(second).toEqual(first);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('rejects the same key with a different request and leaves the first hold alone', async () => {
    const push = okPush();
    const d = await deps(push);
    const key = randomUUID();
    await holdSlotAndCharge(d, input({ idempotencyKey: key }));

    await expect(holdSlotAndCharge(d, input({ idempotencyKey: key, phone: '33 1234 5678' }))).rejects.toThrow(
      IdempotencyKeyReusedError,
    );
    expect(push).toHaveBeenCalledTimes(1);
    expect((await onlyBooking()).status).toBe('holding');
  });

  it('RF2: two concurrent holds of one slot with different keys: one is held, the other gets SlotTakenError', async () => {
    const push = okPush();
    const d = await deps(push);
    const rounds = 4;

    for (let round = 0; round < rounds; round += 1) {
      const slotStart = new Date(SLOT.getTime() + round * d.business.slotMinutes * MINUTE_MS);
      const keys = [randomUUID(), randomUUID()] as const;
      const results = await releasedTogether(keys, () =>
        Promise.allSettled([
          holdSlotAndCharge(d, input({ slotStart, phone: phoneFor(2 * round), idempotencyKey: keys[0] })),
          holdSlotAndCharge(d, input({ slotStart, phone: phoneFor(2 * round + 1), idempotencyKey: keys[1] })),
        ]),
      );

      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(rejected.map((r) => r.reason)).toEqual([expect.any(SlotTakenError)]);
    }
    expect(push).toHaveBeenCalledTimes(rounds);
    expect(await db.select().from(bookings)).toHaveLength(rounds);
    expect(await db.select().from(idempotencyKeys)).toHaveLength(rounds);
    expect(await db.select().from(paymentIntents)).toHaveLength(rounds);
  });

  it('answers in-flight for the same key while the push is pending, then replays once it finishes', async () => {
    const pending = deferred<{ transactionId: string; codiId: string }>();
    const push = vi.fn<PushCharge>(() => pending.promise);
    const d = await deps(push);
    const request = input();

    const first = holdSlotAndCharge(d, request);
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    await expect(holdSlotAndCharge(d, request)).rejects.toThrow(IdempotencyKeyInFlightError);
    pending.resolve({ transactionId: TX, codiId: CODI });
    const firstResponse = await first;

    expect(await holdSlotAndCharge(d, request)).toEqual(firstResponse);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['RailUnavailableError', new RailUnavailableError('pey POST /codi/pn responded 503', { status: 503 })],
    [
      'RailRejectedError',
      new RailRejectedError('pey rejected POST /codi/pn (400): bad phone', { status: 400, providerMessage: 'bad phone' }),
    ],
  ])('on %s: stores a 502, expires the booking, fails the attempt and frees the slot', async (_name, error) => {
    const push = vi.fn<PushCharge>(() => Promise.reject(error));
    const d = await deps(push);
    const request = input();

    const response = await holdSlotAndCharge(d, request);

    expect(response).toEqual({
      status: 502,
      body: { type: 'urn:pialy:problem:push-failed', title: 'Bad Gateway', status: 502, detail: PUSH_FAILED_DETAIL },
    });
    expect(PUSH_FAILED_DETAIL).toBe('No pudimos enviar la solicitud. Intenta de nuevo.');
    const booking = await onlyBooking();
    expect(booking.status).toBe('expired');
    const [attempt] = await db.select().from(paymentAttempts);
    expect(attempt).toMatchObject({ intentId: booking.intentId, status: 'failed' });
    expect(await db.select().from(paymentIntents)).toEqual([expect.objectContaining({ status: 'expired' })]);
    const [key] = await db.select().from(idempotencyKeys);
    expect(key).toMatchObject({ recoveryPoint: 'finished', responseCode: 502, lockedAt: null });
    expect(log.warn).toHaveBeenCalled();
    const statuses = (await db.select().from(outbox)).map((row) => (row.payload as { status: string }).status);
    expect(statuses.sort()).toEqual(['expired', 'expired', 'holding', 'holding']);

    expect(await holdSlotAndCharge(d, request)).toEqual(response);
    expect(push).toHaveBeenCalledTimes(1);

    const again = await holdSlotAndCharge({ ...d, rail: { createPushCharge: okPush() } }, input());
    expect(again.status).toBe(201);
  });

  it('never leaves the key in flight when the connector fails unexpectedly', async () => {
    const d = await deps(vi.fn<PushCharge>(() => Promise.reject(new TypeError(`boom for ${PHONE10}`))));
    const request = input();

    const response = await holdSlotAndCharge(d, request);

    expect(response.status).toBe(502);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ failure: expect.objectContaining({ name: 'TypeError', message: 'boom for [redacted]' }) }),
      'codi push failed unexpectedly',
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(PHONE10);
    expect((await onlyBooking()).status).toBe('expired');
    expect(await holdSlotAndCharge(d, request)).toEqual(response);
  });

  it('logs a rail rejection by name, status and code only, never the provider message that may echo the phone', async () => {
    const providerMessage = `phoneNumber ${PHONE10} is not enrolled in CoDi`;
    const rejection = new RailRejectedError(`pey rejected POST /codi/pn (400): ${providerMessage}`, {
      status: 400,
      providerMessage,
      providerCode: 'INVALID_PARAMETER',
      requestId: 'req_123',
    });
    const d = await deps(vi.fn<PushCharge>(() => Promise.reject(rejection)));

    await holdSlotAndCharge(d, input());

    const logged = JSON.stringify(log.warn.mock.calls);
    expect(logged).not.toContain(PHONE10);
    expect(logged).not.toContain('not enrolled');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ rail: { name: 'RailRejectedError', status: 400, providerCode: 'INVALID_PARAMETER', requestId: 'req_123' } }),
      'codi push failed',
    );
  });

  it('limits a phone to 3 holds in 10 minutes; replays do not count and the window slides', async () => {
    const push = vi.fn<PushCharge>(() => Promise.reject(new RailUnavailableError('down')));
    const d = await deps(push);
    const keys = [randomUUID(), randomUUID(), randomUUID()];
    const responses = [];
    for (const idempotencyKey of keys) responses.push(await holdSlotAndCharge(d, input({ idempotencyKey })));

    expect(await holdSlotAndCharge(d, input({ idempotencyKey: keys[2]! }))).toEqual(responses[2]);
    await expect(holdSlotAndCharge(d, input())).rejects.toThrow(TooManyHoldsForPhoneError);
    expect(await holdSlotAndCharge(d, input({ phone: '33 1234 5678' }))).toMatchObject({ status: 502 });
    expect(push).toHaveBeenCalledTimes(4);

    const later = { now: () => new Date(NOW.getTime() + 10 * MINUTE_MS + 1000) };
    expect(await holdSlotAndCharge({ ...d, clock: later }, input())).toMatchObject({ status: 502 });
  });

  it('allows one holding booking per phone: concurrent holds of two slots give one hold and one ActiveHoldExistsError', async () => {
    const d = await deps(okPush());
    const keys = [randomUUID(), randomUUID()] as const;
    const second = new Date(SLOT.getTime() + 2 * d.business.slotMinutes * MINUTE_MS);

    const results = await releasedTogether(keys, () =>
      Promise.allSettled([
        holdSlotAndCharge(d, input({ idempotencyKey: keys[0] })),
        holdSlotAndCharge(d, input({ slotStart: second, idempotencyKey: keys[1] })),
      ]),
    );

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected.map((r) => r.reason)).toEqual([expect.any(ActiveHoldExistsError)]);
    const holding = await onlyBooking();

    await db.update(bookings).set({ status: 'expired' }).where(eq(bookings.id, holding.id));
    const third = new Date(SLOT.getTime() + 4 * d.business.slotMinutes * MINUTE_MS);
    expect(await holdSlotAndCharge(d, input({ slotStart: third }))).toMatchObject({ status: 201 });
  });

  it('answers 201 when the push call failed but its payment already confirmed the booking', async () => {
    const push = vi.fn<PushCharge>(async (charge) => {
      await applyProviderPayment(uow(), noRail, paymentFor(charge.metadata.attemptId!), 'reconcile', {});
      throw new RailUnavailableError('pey POST /codi/pn failed: request timed out');
    });
    const d = await deps(push);

    const response = await holdSlotAndCharge(d, input());

    expect(response.status).toBe(201);
    expect((await onlyBooking()).status).toBe('confirmed');
    expect(await db.select().from(paymentAttempts)).toEqual([expect.objectContaining({ status: 'succeeded' })]);
  });

  it('recovers a key whose request died after the hold: fails the hold instead of pushing again', async () => {
    const pending = deferred<{ transactionId: string; codiId: string }>();
    const push = vi.fn<PushCharge>(() => pending.promise);
    const d = await deps(push);
    const request = input();

    const stuck = holdSlotAndCharge(d, request);
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    const later = { now: () => new Date(NOW.getTime() + 61_000) };
    const recovered = await holdSlotAndCharge({ ...d, clock: later }, request);

    expect(recovered.status).toBe(502);
    expect(push).toHaveBeenCalledTimes(1);
    expect((await onlyBooking()).status).toBe('expired');

    pending.resolve({ transactionId: TX, codiId: CODI });
    expect(await stuck).toEqual(recovered);
    expect(await db.select().from(paymentAttempts)).toEqual([
      expect.objectContaining({ status: 'failed', providerTxId: TX, codiId: CODI }),
    ]);
  });
});

describe('onPaymentEvent', () => {
  async function failedHold(): Promise<{ token: string; attemptId: string; bookingId: string }> {
    const d = await deps(vi.fn<PushCharge>(() => Promise.reject(new RailUnavailableError('down'))));
    await holdSlotAndCharge(d, input());
    const booking = await onlyBooking();
    const [attempt] = await db.select().from(paymentAttempts);
    return { token: booking.token, attemptId: attempt!.id, bookingId: booking.id };
  }

  it('confirms a held booking when its payment arrives on time and notifies board and booking', async () => {
    const d = await deps(okPush());
    const { token } = held(await holdSlotAndCharge(d, input()));
    const [attempt] = await db.select().from(paymentAttempts);
    await db.delete(outbox);

    expect(await applyProviderPayment(uow(), noRail, paymentFor(attempt!.id), 'reconcile', {})).toBe('applied');

    const booking = await onlyBooking();
    expect(booking).toMatchObject({ status: 'confirmed', late: false });
    expect(booking.confirmedAt).toBeInstanceOf(Date);
    const rows = await db.select().from(outbox);
    expect(rows.map((r) => r.topic).sort()).toEqual(['board', `booking:${token}`]);
    expect(rows[0]?.payload).toMatchObject({ type: 'booking.updated', token, status: 'confirmed' });
  });

  it('confirms a late payment as late when the slot is still free', async () => {
    const { attemptId, token } = await failedHold();
    await db.delete(outbox);

    expect(await applyProviderPayment(uow(), noRail, paymentFor(attemptId), 'reconcile', {})).toBe('applied');

    expect(await onlyBooking()).toMatchObject({ status: 'confirmed', late: true });
    expect(await db.select().from(flags)).toEqual([]);
    expect((await db.select().from(outbox)).map((r) => r.topic).sort()).toEqual(['board', `booking:${token}`]);
  });

  it('flags refund_due for a late payment whose slot was taken, and still records the money', async () => {
    const { attemptId, bookingId } = await failedHold();
    const d = await deps(okPush());
    held(await holdSlotAndCharge(d, input({ phone: '33 1234 5678' })));
    await db.delete(outbox);

    expect(await applyProviderPayment(uow(), noRail, paymentFor(attemptId), 'reconcile', {})).toBe('applied');

    const [late] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(late).toMatchObject({ status: 'expired', late: false });
    const [flag] = await db.select().from(flags);
    expect(flag).toMatchObject({ kind: 'refund_due', bookingId });
    expect(flag?.payload).toMatchObject({ reason: 'slot_taken', providerTxId: TX, attemptId });
    expect(await db.select().from(paymentEvents)).toEqual([expect.objectContaining({ providerTxId: TX, late: true })]);
    expect(await db.select().from(paymentIntents).where(eq(paymentIntents.id, late!.intentId!))).toEqual([
      expect.objectContaining({ status: 'succeeded' }),
    ]);
    expect(await db.select().from(outbox)).toEqual([]);
  });

  it.each(['processing', 'canceled'])(
    'always flags refund_due for a canceled booking, even with the slot free (intent %s)',
    async (intentStatus) => {
      const d = await deps(okPush());
      held(await holdSlotAndCharge(d, input()));
      const booking = await onlyBooking();
      const [attempt] = await db.select().from(paymentAttempts);
      await db.update(bookings).set({ status: 'canceled' }).where(eq(bookings.id, booking.id));
      await db.update(paymentIntents).set({ status: intentStatus }).where(eq(paymentIntents.id, booking.intentId!));

      expect(await applyProviderPayment(uow(), noRail, paymentFor(attempt!.id), 'reconcile', {})).toBe('applied');

      expect((await onlyBooking()).status).toBe('canceled');
      const [flag] = await db.select().from(flags);
      expect(flag).toMatchObject({ kind: 'refund_due', bookingId: booking.id });
      expect(flag?.payload).toMatchObject({ reason: 'booking_canceled' });
    },
  );

  it('flags refund_due for a second payment of a confirmed booking', async () => {
    const d = await deps(okPush());
    held(await holdSlotAndCharge(d, input()));
    const [attempt] = await db.select().from(paymentAttempts);
    await applyProviderPayment(uow(), noRail, paymentFor(attempt!.id), 'reconcile', {});
    await db.delete(outbox);

    expect(await applyProviderPayment(uow(), noRail, paymentFor(attempt!.id, 'TX_SECOND'), 'reconcile', {})).toBe(
      'applied',
    );

    expect((await onlyBooking()).status).toBe('confirmed');
    const [flag] = await db.select().from(flags);
    expect(flag).toMatchObject({ kind: 'refund_due' });
    expect(flag?.payload).toMatchObject({ reason: 'duplicate_payment', providerTxId: 'TX_SECOND' });
    expect(await db.select().from(outbox)).toEqual([]);
  });

  it.each([
    ['expired', 'expired', 2],
    ['processing', 'holding', 0],
  ] as const)('on AttemptExpired with the intent %s, leaves the booking %s', async (intentStatus, bookingStatus, rows) => {
    const d = await deps(okPush());
    held(await holdSlotAndCharge(d, input()));
    const booking = await onlyBooking();
    const [attempt] = await db.select().from(paymentAttempts);
    await db.update(paymentIntents).set({ status: intentStatus }).where(eq(paymentIntents.id, booking.intentId!));
    await db.delete(outbox);

    await uow().run((tx) =>
      tx.bookingEvents({
        type: 'AttemptExpired',
        intentId: booking.intentId!,
        reference: 'ref',
        attemptId: attempt!.id,
        at: new Date('2026-11-14T18:06:15.000Z'),
      }),
    );

    expect((await onlyBooking()).status).toBe(bookingStatus);
    expect(await db.select().from(outbox)).toHaveLength(rows);
  });

  it('keeps flagging unmatched payments', async () => {
    expect(
      await applyProviderPayment(uow(), noRail, { ...paymentFor(randomUUID()), providerTxId: 'TX_NOBODY' }, 'reconcile', {}),
    ).toBe('unmatched');

    expect(await db.select().from(flags)).toEqual([expect.objectContaining({ kind: 'unmatched_payment', bookingId: null })]);
  });

  it('flags refund_due without a booking when an intent has none', async () => {
    const [intent] = await db
      .insert(paymentIntents)
      .values({ reference: `R-${randomUUID()}`, amountMinor: 1, status: 'processing' })
      .returning();
    const [attempt] = await db
      .insert(paymentAttempts)
      .values({ intentId: intent!.id, mode: 'push', status: 'awaiting', expiresAt: new Date(HOLD_EXPIRES_AT) })
      .returning();

    expect(await applyProviderPayment(uow(), noRail, paymentFor(attempt!.id), 'reconcile', {})).toBe('applied');

    expect(await db.select().from(flags)).toEqual([
      expect.objectContaining({ kind: 'refund_due', bookingId: null, payload: expect.objectContaining({ reason: 'no_booking' }) }),
    ]);
  });
});
