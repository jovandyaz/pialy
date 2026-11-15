import { randomUUID } from 'node:crypto';
import { createPeyConnector } from '@pialy/connector-pey';
import {
  RailRejectedError,
  RailUnavailableError,
  applyProviderPayment,
  money,
  reconcileAttempt,
  type PaymentLookup,
  type ProviderPayment,
  type QrChargeInput,
  type RailConnector,
} from '@pialy/payments';
import { asc, eq, sql } from 'drizzle-orm';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type AppDeps } from '../src/app.js';
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
import { cleanDb, fakeConnector, openTestDb, testDeps } from './support.js';

const handle = openTestDb();
const { db } = handle;
afterAll(() => handle.close());

const HELD_AT = new Date('2026-11-14T12:00:00.000Z');
const QR_AT = new Date('2026-11-14T12:01:00.000Z');
const HOLD_EXPIRES_AT = '2026-11-14T12:06:00.000Z';
const QR_EXPIRES_AT = '2026-11-14T12:07:00.000Z';
const SLOT = '2026-11-15T15:00:00.000Z';
const OTHER_SLOT = '2026-11-15T16:30:00.000Z';
const PHONE10 = '5512345678';
const PROBLEM = 'application/problem+json';
const PUSH_TX = '01M7PUSHTX0000000000000000';
const QR_ID = '35a13c183a';
const QR_STRING = '{"TYP":20,"v":{"DEV":"00000000000000/0"},"ic":{"IDC":"35a13c183a"}}';
const NOT_HOLDING = {
  type: 'urn:pialy:problem:booking-not-holding',
  title: 'Conflict',
  status: 409,
  detail: 'Esta reserva ya no está esperando el pago',
};

let now = HELD_AT;
const clock = { now: () => now };

beforeEach(async () => {
  await cleanDb(handle);
  await seedDemo(db);
  now = HELD_AT;
});

type PushCharge = RailConnector['createPushCharge'];
type QrCharge = RailConnector['createQrCharge'];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function okPush() {
  return vi.fn<PushCharge>(() => Promise.resolve({ transactionId: PUSH_TX, codiId: '12345678901234567890' }));
}

function okQr() {
  let n = 0;
  return vi.fn<QrCharge>(() => {
    n += 1;
    return Promise.resolve(
      n === 1 ? { qrId: QR_ID, qrString: QR_STRING } : { qrId: `${QR_ID}-${n}`, qrString: `${QR_STRING}#${n}` },
    );
  });
}

function appWith(rail: Partial<RailConnector> = {}, overrides: Partial<AppDeps> = {}) {
  return buildApp(
    testDeps(handle, { connector: { ...fakeConnector, createPushCharge: okPush(), ...rail }, clock, ...overrides }),
  );
}

type App = ReturnType<typeof appWith>;

async function hold(app: App, phone = PHONE10, slotStart = SLOT): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/bookings',
    headers: { 'idempotency-key': randomUUID() },
    payload: { slotStart, phone },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ token: string }>().token;
}

function postQr(app: App, token: string, key: string | null = randomUUID()) {
  return app.inject({
    method: 'POST',
    url: `/api/bookings/${token}/qr`,
    headers: key === null ? {} : { 'idempotency-key': key },
  });
}

async function bookingOf(token: string) {
  const [row] = await db.select().from(bookings).where(eq(bookings.token, token));
  if (row === undefined) throw new Error(`no booking ${token}`);
  return row;
}

async function attemptsOf(token: string) {
  const booking = await bookingOf(token);
  return db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.intentId, booking.intentId!))
    .orderBy(asc(paymentAttempts.createdAt), asc(paymentAttempts.mode));
}

async function qrAttemptOf(token: string) {
  const qr = (await attemptsOf(token)).filter((a) => a.mode === 'qr');
  expect(qr).toHaveLength(1);
  return qr[0]!;
}

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

async function releasedTogetherOnIntent<T>(intentId: string, waiters: number, start: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const lockTaken = new Promise<void>((resolve) => (locked = resolve));
  const blocker = db.transaction(async (tx) => {
    await tx.select().from(paymentIntents).where(eq(paymentIntents.id, intentId)).for('update');
    locked();
    await gate;
  });
  await lockTaken;
  const started = start();
  try {
    await waitForLockWaiters(waiters);
  } finally {
    release();
    await blocker;
  }
  return started;
}

describe('POST /api/bookings/:token/qr', () => {
  it('creates a CoDi QR attempt next to the awaiting push and extends the hold to its expiry', async () => {
    const qr = okQr();
    const app = appWith({ createQrCharge: qr });
    const token = await hold(app);
    await db.delete(outbox);
    now = QR_AT;

    const res = await postQr(app, token);
    const view = await app.inject({ method: 'GET', url: `/api/bookings/${token}` });
    await app.close();

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ qrString: QR_STRING, expiresAt: QR_EXPIRES_AT });
    const booking = await bookingOf(token);
    expect(booking).toMatchObject({ status: 'holding', holdExpiresAt: new Date(QR_EXPIRES_AT) });
    const [push, qrAttempt] = await attemptsOf(token);
    expect(push).toMatchObject({ mode: 'push', status: 'awaiting', expiresAt: new Date(HOLD_EXPIRES_AT) });
    expect(qrAttempt).toMatchObject({
      mode: 'qr',
      status: 'awaiting',
      providerQrId: QR_ID,
      providerTxId: null,
      expiresAt: new Date(QR_EXPIRES_AT),
    });
    expect(qr).toHaveBeenCalledTimes(1);
    expect(qr.mock.calls[0]?.[0]).toEqual<QrChargeInput>({
      amount: money(1),
      concept: 'Anticipo Estudio Demo',
      expiresInSec: 360,
      numRef: String(booking.number),
      metadata: { bookingId: booking.id, attemptId: qrAttempt!.id },
    });
    expect(await db.select().from(paymentIntents)).toEqual([expect.objectContaining({ status: 'processing' })]);
    const notices = await db.select().from(outbox);
    expect(notices.map((row) => row.topic).sort()).toEqual(['board', `booking:${token}`]);
    expect(notices[0]?.payload).toEqual({ type: 'booking.updated', token, status: 'holding', late: false });
    expect(view.json()).toMatchObject({
      status: 'holding',
      holdExpiresAt: QR_EXPIRES_AT,
      attempts: [
        { mode: 'push', status: 'awaiting' },
        { mode: 'qr', status: 'awaiting' },
      ],
    });
  });

  it('replays the same response for the same Idempotency-Key: one QR, one rail call', async () => {
    const qr = okQr();
    const app = appWith({ createQrCharge: qr });
    const token = await hold(app);
    const key = randomUUID();

    const first = await postQr(app, token, key);
    now = new Date(QR_AT.getTime() + 30_000);
    const second = await postQr(app, token, key);
    await app.close();

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body).toBe(first.body);
    expect(qr).toHaveBeenCalledTimes(1);
    expect(await attemptsOf(token)).toHaveLength(2);
    const keys = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.scope, 'qr'));
    expect(keys).toEqual([expect.objectContaining({ recoveryPoint: 'finished', responseCode: 201, lockedAt: null })]);
  });

  it('answers 422 when the key was already used for another booking', async () => {
    const app = appWith({ createQrCharge: okQr() });
    const first = await hold(app);
    const other = await hold(app, '33 1234 5678', OTHER_SLOT);
    const key = randomUUID();

    expect((await postQr(app, first, key)).statusCode).toBe(201);
    const res = await postQr(app, other, key);
    await app.close();

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ type: 'urn:pialy:problem:idempotency-key-reused' });
    expect(await attemptsOf(other)).toHaveLength(1);
  });

  it.each(['confirmed', 'expired', 'checked_in', 'canceled'])(
    'answers 409 for a booking that is %s, without calling the rail',
    async (status) => {
      const qr = okQr();
      const app = appWith({ createQrCharge: qr });
      const token = await hold(app);
      await db.update(bookings).set({ status }).where(eq(bookings.token, token));

      const res = await postQr(app, token);
      await app.close();

      expect(res.statusCode).toBe(409);
      expect(res.headers['content-type']).toContain(PROBLEM);
      expect(res.json()).toEqual(NOT_HOLDING);
      expect(qr).not.toHaveBeenCalled();
      expect(await attemptsOf(token)).toHaveLength(1);
      expect(await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.scope, 'qr'))).toEqual([]);
    },
  );

  it.each(['nope', 'A'.repeat(22)])('answers 404 for the unknown token %s', async (token) => {
    const qr = okQr();
    const app = appWith({ createQrCharge: qr });

    const res = await postQr(app, token);
    await app.close();

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain(PROBLEM);
    expect(qr).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['too short', 'abc'],
  ])('answers 400 when the Idempotency-Key is %s', async (_why, key) => {
    const qr = okQr();
    const app = appWith({ createQrCharge: qr });
    const token = await hold(app);

    const res = await postQr(app, token, key);
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain(PROBLEM);
    expect(qr).not.toHaveBeenCalled();
  });

  it('answers 429 "Alcanzaste el máximo de intentos" to the 4th attempt of a booking; failed attempts count', async () => {
    const qr = vi
      .fn<QrCharge>()
      .mockResolvedValueOnce({ qrId: QR_ID, qrString: QR_STRING })
      .mockRejectedValueOnce(new RailUnavailableError('pey POST /codi/qr responded 503', { status: 503 }));
    const app = appWith({ createQrCharge: qr });
    const token = await hold(app);
    const firstKey = randomUUID();

    const first = await postQr(app, token, firstKey);
    const second = await postQr(app, token);
    const fourth = await postQr(app, token);
    const replay = await postQr(app, token, firstKey);
    await app.close();

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(502);
    expect(fourth.statusCode).toBe(429);
    expect(fourth.headers['content-type']).toContain(PROBLEM);
    expect(fourth.json()).toMatchObject({
      type: 'urn:pialy:problem:attempts-exhausted',
      status: 429,
      detail: 'Alcanzaste el máximo de intentos',
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.body).toBe(first.body);
    expect(qr).toHaveBeenCalledTimes(2);
    expect(await attemptsOf(token)).toHaveLength(3);
  });

  it('lets only one of two concurrent requests take the last attempt', async () => {
    const qr = okQr();
    const app = appWith({ createQrCharge: qr });
    const token = await hold(app);
    expect((await postQr(app, token)).statusCode).toBe(201);
    const { intentId } = await bookingOf(token);

    const responses = await releasedTogetherOnIntent(intentId!, 2, () =>
      Promise.all([postQr(app, token), postQr(app, token)]),
    );
    await app.close();

    expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 429]);
    expect(await attemptsOf(token)).toHaveLength(3);
    expect(qr).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['RailUnavailableError', new RailUnavailableError('pey POST /codi/qr responded 503', { status: 503 })],
    [
      'RailRejectedError',
      new RailRejectedError('pey rejected POST /codi/qr (400): bad', { status: 400, providerMessage: 'bad' }),
    ],
  ])('on %s: stores a 502, fails the QR attempt and keeps the push hold as it was', async (_name, error) => {
    const qr = vi.fn<QrCharge>(() => Promise.reject(error));
    const app = appWith({ createQrCharge: qr });
    const token = await hold(app);
    await db.delete(outbox);
    now = QR_AT;
    const key = randomUUID();

    const res = await postQr(app, token, key);
    const replay = await postQr(app, token, key);
    await app.close();

    expect(res.statusCode).toBe(502);
    expect(res.headers['content-type']).toContain(PROBLEM);
    expect(res.json()).toEqual({
      type: 'urn:pialy:problem:qr-failed',
      title: 'Bad Gateway',
      status: 502,
      detail: 'No pudimos generar el código QR. Intenta de nuevo.',
    });
    expect(replay.statusCode).toBe(502);
    expect(replay.body).toBe(res.body);
    expect(qr).toHaveBeenCalledTimes(1);
    expect(await bookingOf(token)).toMatchObject({ status: 'holding', holdExpiresAt: new Date(HOLD_EXPIRES_AT) });
    expect((await attemptsOf(token)).map((a) => [a.mode, a.status])).toEqual([
      ['push', 'awaiting'],
      ['qr', 'failed'],
    ]);
    expect(await db.select().from(paymentIntents)).toEqual([expect.objectContaining({ status: 'processing' })]);
    expect(await db.select().from(outbox)).toEqual([]);
  });

  it('expires the booking when the failed QR was the last awaiting attempt', async () => {
    const pending = deferred<{ qrId: string; qrString: string }>();
    const qr = vi.fn<QrCharge>(() => pending.promise);
    const app = appWith({ createQrCharge: qr });
    const token = await hold(app);
    await db.delete(outbox);

    const res = postQr(app, token);
    await vi.waitFor(() => expect(qr).toHaveBeenCalledTimes(1));
    await db.update(paymentAttempts).set({ status: 'expired' }).where(eq(paymentAttempts.mode, 'push'));
    pending.reject(new RailUnavailableError('pey POST /codi/qr failed: request timed out'));
    const response = await res;
    await app.close();

    expect(response.statusCode).toBe(502);
    expect((await bookingOf(token)).status).toBe('expired');
    expect(await db.select().from(paymentIntents)).toEqual([expect.objectContaining({ status: 'expired' })]);
    const notices = await db.select().from(outbox);
    expect(notices.map((row) => (row.payload as { status: string }).status)).toEqual(['expired', 'expired']);
  });

  it('withholds the QR with the 409 problem when the push is paid during the QR call, and keeps its id', async () => {
    const pending = deferred<{ qrId: string; qrString: string }>();
    const qr = vi.fn<QrCharge>(() => pending.promise);
    const app = appWith({ createQrCharge: qr });
    const token = await hold(app);
    now = QR_AT;
    const key = randomUUID();

    const res = postQr(app, token, key);
    await vi.waitFor(() => expect(qr).toHaveBeenCalledTimes(1));
    const pushPayment: ProviderPayment = {
      providerTxId: PUSH_TX,
      amount: money(1),
      paidAt: new Date('2026-11-14T12:01:10.000Z'),
      ref: { transactionId: PUSH_TX },
    };
    const unpaid = { findPayments: () => Promise.resolve([]) };
    await applyProviderPayment(createDrizzleUnitOfWork(db, paymentReaction), unpaid, pushPayment, 'reconcile', {});
    expect((await bookingOf(token)).status).toBe('confirmed');
    await db.delete(outbox);
    pending.resolve({ qrId: QR_ID, qrString: QR_STRING });
    const response = await res;
    const replay = await postQr(app, token, key);
    await app.close();

    expect(response.statusCode).toBe(409);
    expect(response.headers['content-type']).toContain(PROBLEM);
    expect(response.json()).toEqual(NOT_HOLDING);
    expect(response.body).not.toContain('qrString');
    expect(response.body).not.toContain(QR_ID);
    expect(replay.statusCode).toBe(409);
    expect(replay.body).toBe(response.body);
    expect(qr).toHaveBeenCalledTimes(1);
    expect(await qrAttemptOf(token)).toMatchObject({ status: 'awaiting', providerQrId: QR_ID });
    expect(await bookingOf(token)).toMatchObject({ status: 'confirmed', holdExpiresAt: new Date(HOLD_EXPIRES_AT) });
    expect(await db.select().from(outbox)).toEqual([]);
    const [stored] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.scope, 'qr'));
    expect(stored).toMatchObject({ recoveryPoint: 'finished', responseCode: 409, lockedAt: null });
  });

  it('answers 409 "Solicitud en proceso" while the same key is in flight', async () => {
    const pending = deferred<{ qrId: string; qrString: string }>();
    const qr = vi.fn<QrCharge>(() => pending.promise);
    const app = appWith({ createQrCharge: qr });
    const token = await hold(app);
    const key = randomUUID();

    const first = postQr(app, token, key);
    await vi.waitFor(() => expect(qr).toHaveBeenCalledTimes(1));
    const second = await postQr(app, token, key);
    pending.resolve({ qrId: QR_ID, qrString: QR_STRING });
    const firstResponse = await first;
    const third = await postQr(app, token, key);
    await app.close();

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ type: 'urn:pialy:problem:request-in-progress' });
    expect(firstResponse.statusCode).toBe(201);
    expect(third.body).toBe(firstResponse.body);
    expect(qr).toHaveBeenCalledTimes(1);
  });

  it('recovers a key whose request died after creating the attempt: fails that attempt instead of creating a second QR', async () => {
    const pending = deferred<{ qrId: string; qrString: string }>();
    const qr = vi.fn<QrCharge>(() => pending.promise);
    const app = appWith({ createQrCharge: qr });
    const token = await hold(app);
    const key = randomUUID();
    now = QR_AT;

    const stuck = postQr(app, token, key);
    await vi.waitFor(() => expect(qr).toHaveBeenCalledTimes(1));
    now = new Date(QR_AT.getTime() + 61_000);
    const recovered = await postQr(app, token, key);

    expect(recovered.statusCode).toBe(502);
    expect(recovered.json()).toMatchObject({ type: 'urn:pialy:problem:qr-failed' });
    expect(qr).toHaveBeenCalledTimes(1);
    expect((await bookingOf(token)).status).toBe('holding');

    pending.resolve({ qrId: QR_ID, qrString: QR_STRING });
    const late = await stuck;
    await app.close();

    expect(late.statusCode).toBe(502);
    expect(late.body).toBe(recovered.body);
    expect(await qrAttemptOf(token)).toMatchObject({ status: 'failed', providerQrId: QR_ID });
    expect((await bookingOf(token)).holdExpiresAt).toEqual(new Date(HOLD_EXPIRES_AT));
  });

  it('keeps the slot held past the push expiry while the QR awaits, and frees it when the QR expires unpaid', async () => {
    const app = appWith({ createQrCharge: okQr() });
    const token = await hold(app);
    now = QR_AT;
    expect((await postQr(app, token)).statusCode).toBe(201);
    await app.close();
    const [push, qrAttempt] = await attemptsOf(token);
    const uow = createDrizzleUnitOfWork(db, paymentReaction);
    const unpaid = { findPayments: () => Promise.resolve([]) };

    const pushResult = await reconcileAttempt(uow, unpaid, push!.id, { now: () => new Date('2026-11-14T12:06:01.000Z') });

    expect(pushResult.outcome).toBe('expired');
    expect(await bookingOf(token)).toMatchObject({ status: 'holding', holdExpiresAt: new Date(QR_EXPIRES_AT) });
    expect(await db.select().from(paymentIntents)).toEqual([expect.objectContaining({ status: 'processing' })]);

    const qrResult = await reconcileAttempt(uow, unpaid, qrAttempt!.id, { now: () => new Date('2026-11-14T12:07:01.000Z') });

    expect(qrResult.outcome).toBe('expired');
    expect((await bookingOf(token)).status).toBe('expired');
    expect(await db.select().from(paymentIntents)).toEqual([expect.objectContaining({ status: 'expired' })]);
  });

  it('lets the sweeper reconcile a QR attempt by its QR id', async () => {
    const app = appWith({ createQrCharge: okQr() });
    const token = await hold(app);
    now = QR_AT;
    expect((await postQr(app, token)).statusCode).toBe(201);
    await app.close();
    const qrAttempt = await qrAttemptOf(token);
    const paid: ProviderPayment = {
      providerTxId: '01M7QRPAIDTX00000000000000',
      amount: money(1),
      paidAt: new Date('2026-11-14T12:03:00.000Z'),
      trackingKey: '0192191043',
      ref: { transactionId: '01M7QRPAIDTX00000000000000', qrId: QR_ID },
    };
    const findPayments = vi.fn((lookup: PaymentLookup) =>
      Promise.resolve('qrId' in lookup && lookup.qrId === QR_ID ? [paid] : []),
    );

    const result = await reconcileAttempt(
      createDrizzleUnitOfWork(db, paymentReaction),
      { findPayments },
      qrAttempt.id,
      { now: () => new Date('2026-11-14T12:03:30.000Z') },
    );

    expect(result).toEqual({ outcome: 'paid', railError: null });
    expect(findPayments).toHaveBeenCalledWith({ qrId: QR_ID });
    expect((await bookingOf(token)).status).toBe('confirmed');
    expect(await qrAttemptOf(token)).toMatchObject({ status: 'succeeded', providerTxId: '01M7QRPAIDTX00000000000000' });
  });
});

describe('QR payments through the pey webhook', () => {
  const WEBHOOK_SECRET = `whsec_${Buffer.from('pialy-qr-attempt-test-secret').toString('base64')}`;
  const QR_TX = '01M7QRPAYTX000000000000000';
  const CLABE = '012180001234567890';
  const PAID_AT_SECONDS = Math.floor(Date.parse('2026-11-14T12:02:30Z') / 1000);

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  const fetchMock = vi.fn<typeof fetch>((input) => {
    const url = String(input);
    if (url.endsWith('/codi/pn')) return Promise.resolve(json(201, { transactionId: PUSH_TX, codiId: '1234567890' }));
    if (url.endsWith('/codi/qr')) return Promise.resolve(json(201, { id: QR_ID, qrString: QR_STRING, qrImage: null }));
    return Promise.reject(new Error(`unexpected pey call ${url}`));
  });

  const pey = createPeyConnector({
    apiKey: 'pey_test_key',
    baseUrl: 'https://api.pey.test',
    webhookSecret: WEBHOOK_SECRET,
    fetch: fetchMock,
    sleep: () => Promise.resolve(),
  });

  function peyApp() {
    return buildApp(testDeps(handle, { connector: pey, clock }));
  }

  function paymentBody(kind: 'push' | 'qr'): string {
    const common = {
      amount: 0.01,
      apiKeyId: '01M3QMMR6X9CBVDY1SF3G8QWNW',
      concept: 'Anticipo Estudio Demo',
      datePaid: PAID_AT_SECONDS,
      metadata: {
        clabe: CLABE,
        bankCode: 40012,
        accountType: 40,
        description: 'Anticipo Estudio Demo',
        trackingKey: kind === 'push' ? '0192191042' : '0192191043',
        externalMetadata: {},
      },
      numRef: '1',
    };
    return JSON.stringify(
      kind === 'push'
        ? { ...common, transactionId: PUSH_TX, type: 'codi.pn.payment_received' }
        : {
            ...common,
            bankAccountId: '01JBAVWE4NS5TGXHWGMX3KH23Q',
            codiQrId: QR_ID,
            transactionId: QR_TX,
            type: 'codi.qr.payment_received',
          },
    );
  }

  function deliver(app: App, body: string) {
    const webhookId = `msg_${randomUUID()}`;
    const at = new Date();
    return app.inject({
      method: 'POST',
      url: '/api/webhooks/pey',
      headers: {
        'content-type': 'application/json',
        'webhook-id': webhookId,
        'webhook-timestamp': String(Math.floor(at.getTime() / 1000)),
        'webhook-signature': new Webhook(WEBHOOK_SECRET).sign(webhookId, at, body),
      },
      payload: body,
    });
  }

  async function holdWithQr(app: App): Promise<string> {
    const token = await hold(app);
    now = QR_AT;
    const res = await postQr(app, token);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ qrString: QR_STRING, expiresAt: QR_EXPIRES_AT });
    return token;
  }

  it('confirms the booking from a codi.qr.payment_received webhook matched by codiQrId alone', async () => {
    const app = peyApp();
    const token = await holdWithQr(app);
    await db.delete(outbox);

    const res = await deliver(app, paymentBody('qr'));
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'applied' });
    expect(await bookingOf(token)).toMatchObject({ status: 'confirmed', late: false });
    expect(await qrAttemptOf(token)).toMatchObject({ status: 'succeeded', providerQrId: QR_ID, providerTxId: QR_TX });
    expect(await db.select().from(paymentEvents)).toEqual([
      expect.objectContaining({ providerTxId: QR_TX, trackingKey: '0192191043', late: false }),
    ]);
    expect(await db.select().from(flags)).toEqual([]);
    expect((await db.select().from(outbox)).map((row) => row.topic).sort()).toEqual(['board', `booking:${token}`]);
  });

  it.each([
    ['push', 'qr', QR_TX],
    ['qr', 'push', PUSH_TX],
  ] as const)(
    'when %s and then %s are both paid, the second payment is recorded and flagged refund_due',
    async (firstKind, secondKind, secondTx) => {
      const app = peyApp();
      const token = await holdWithQr(app);

      const first = await deliver(app, paymentBody(firstKind));
      const second = await deliver(app, paymentBody(secondKind));
      await app.close();

      expect(first.json()).toEqual({ status: 'applied' });
      expect(second.json()).toEqual({ status: 'applied' });
      const booking = await bookingOf(token);
      expect(booking.status).toBe('confirmed');
      const [flag] = await db.select().from(flags);
      expect(flag).toMatchObject({ kind: 'refund_due', bookingId: booking.id });
      expect(flag?.payload).toMatchObject({ reason: 'duplicate_payment', providerTxId: secondTx });
      expect((await db.select().from(paymentEvents)).map((e) => e.providerTxId).sort()).toEqual(
        [PUSH_TX, QR_TX].sort(),
      );
      expect((await attemptsOf(token)).map((a) => a.status)).toEqual(['succeeded', 'succeeded']);
    },
  );
});
