import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { RailUnavailableError, applyProviderPayment, money, type RailConnector } from '@pialy/payments';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type AppDeps } from '../src/app.js';
import { bookings, paymentAttempts } from '../src/infrastructure/db/schema.js';
import { seedDemo } from '../src/infrastructure/db/seed.js';
import { createDrizzleUnitOfWork } from '../src/infrastructure/payments/drizzle-unit-of-work.js';
import { paymentReaction } from '../src/infrastructure/payments/payment-reaction.js';
import { cleanDb, fakeConnector, openTestDb, testDeps } from './support.js';

const handle = openTestDb();
const { db } = handle;
afterAll(() => handle.close());
beforeEach(async () => {
  await cleanDb(handle);
  await seedDemo(db);
});

const PHONE10 = '5512345678';
const SLOT = '2026-11-15T15:00:00.000Z';
const PROBLEM = 'application/problem+json';

type PushCharge = RailConnector['createPushCharge'];

function okPush() {
  return vi.fn<PushCharge>(() => Promise.resolve({ transactionId: 'TX1', codiId: '12345678901234567890' }));
}

function appWith(push: PushCharge = okPush(), overrides: Partial<AppDeps> = {}) {
  return buildApp(testDeps(handle, { connector: { ...fakeConnector, createPushCharge: push }, ...overrides }));
}

function post(app: ReturnType<typeof appWith>, body: unknown, key: string | null = randomUUID()) {
  return app.inject({
    method: 'POST',
    url: '/api/bookings',
    headers: key === null ? {} : { 'idempotency-key': key },
    payload: body as Record<string, unknown>,
  });
}

function captureLogs(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

describe('GET /api/slots', () => {
  it('lists the day with free, held and taken slots', async () => {
    const app = appWith();
    await post(app, { slotStart: SLOT, phone: PHONE10 });
    await post(app, { slotStart: '2026-11-15T15:45:00.000Z', phone: PHONE10 });
    const [, second] = await db.select().from(bookings).orderBy(bookings.number);
    await db.update(bookings).set({ status: 'confirmed' }).where(eq(bookings.id, second!.id));

    const res = await app.inject({ method: 'GET', url: '/api/slots?date=2026-11-15' });
    await app.close();

    expect(res.statusCode).toBe(200);
    const { slots } = res.json<{ slots: { start: string; end: string; state: string }[] }>();
    expect(slots).toHaveLength(14);
    expect(slots.slice(0, 3)).toEqual([
      { start: SLOT, end: '2026-11-15T15:45:00.000Z', state: 'held' },
      { start: '2026-11-15T15:45:00.000Z', end: '2026-11-15T16:30:00.000Z', state: 'taken' },
      { start: '2026-11-15T16:30:00.000Z', end: '2026-11-15T17:15:00.000Z', state: 'free' },
    ]);
  });

  it('leaves out slots that already started today', async () => {
    const app = appWith(okPush(), { clock: { now: () => new Date('2026-11-14T18:00:00.000Z') } });

    const res = await app.inject({ method: 'GET', url: '/api/slots?date=2026-11-14' });
    await app.close();

    expect(res.json<{ slots: { start: string }[] }>().slots[0]?.start).toBe('2026-11-14T18:45:00.000Z');
  });

  it.each(['/api/slots', '/api/slots?date=2026-11-13', '/api/slots?date=mañana', '/api/slots?date=2026-02-30'])(
    'answers 400 for %s',
    async (url) => {
      const app = appWith();
      const res = await app.inject({ method: 'GET', url });
      await app.close();

      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toContain(PROBLEM);
    },
  );
});

describe('POST /api/bookings', () => {
  it('holds the slot and replays the same response for the same Idempotency-Key', async () => {
    const push = okPush();
    const app = appWith(push);
    const key = randomUUID();

    const first = await post(app, { slotStart: SLOT, phone: '55 1234 5678', customerName: '  Ana  ' }, key);
    const second = await post(app, { slotStart: SLOT, phone: '55 1234 5678', customerName: 'Ana' }, key);
    await app.close();

    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ token: expect.any(String), holdExpiresAt: '2026-11-14T12:06:00.000Z' });
    expect(second.statusCode).toBe(201);
    expect(second.body).toBe(first.body);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('accepts the key as a structured-field string', async () => {
    const app = appWith();
    const res = await post(app, { slotStart: SLOT, phone: PHONE10 }, `"${randomUUID()}"`);
    await app.close();

    expect(res.statusCode).toBe(201);
  });

  it.each([
    ['missing', null],
    ['too short', 'abc'],
    ['with spaces', 'a b c d e f g h i j k l m n o p'],
    ['too long', 'a'.repeat(256)],
  ])('answers 400 when the Idempotency-Key is %s', async (_why, key) => {
    const push = okPush();
    const app = appWith(push);
    const res = await post(app, { slotStart: SLOT, phone: PHONE10 }, key);
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain(PROBLEM);
    expect(push).not.toHaveBeenCalled();
  });

  it.each([
    ['no slot', { phone: PHONE10 }],
    ['a slot that is not a date', { slotStart: 'mañana', phone: PHONE10 }],
    ['no phone', { slotStart: SLOT }],
    ['an amount', { slotStart: SLOT, phone: PHONE10, amount: 100 }],
  ])('answers 400 for a body with %s', async (_why, body) => {
    const app = appWith();
    const res = await post(app, body);
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain(PROBLEM);
  });

  it('answers 422 with the phone message for a number that is not 10 digits', async () => {
    const app = appWith();
    const res = await post(app, { slotStart: SLOT, phone: '12345' });
    await app.close();

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ type: 'urn:pialy:problem:invalid-phone', detail: 'Revisa tu número: deben ser 10 dígitos' });
  });

  it('answers 422 for a slot the business does not offer', async () => {
    const app = appWith();
    const res = await post(app, { slotStart: '2026-11-15T15:10:00.000Z', phone: PHONE10 });
    await app.close();

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ type: 'urn:pialy:problem:slot-not-offered' });
  });

  it('answers 409 SlotTaken when the slot is held by someone else', async () => {
    const app = appWith();
    await post(app, { slotStart: SLOT, phone: PHONE10 });
    const res = await post(app, { slotStart: SLOT, phone: '33 1234 5678' });
    await app.close();

    expect(res.statusCode).toBe(409);
    expect(res.headers['content-type']).toContain(PROBLEM);
    expect(res.json()).toMatchObject({ type: 'urn:pialy:problem:slot-taken', detail: 'Ese horario se acaba de ocupar' });
  });

  it('answers 422 when the key is reused with another request', async () => {
    const app = appWith();
    const key = randomUUID();
    await post(app, { slotStart: SLOT, phone: PHONE10 }, key);
    const res = await post(app, { slotStart: '2026-11-15T15:45:00.000Z', phone: PHONE10 }, key);
    await app.close();

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ type: 'urn:pialy:problem:idempotency-key-reused' });
  });

  it('answers 409 "Solicitud en proceso" while the same key is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const push = vi.fn<PushCharge>(async () => {
      await gate;
      return { transactionId: 'TX1', codiId: '1' };
    });
    const app = appWith(push);
    const key = randomUUID();

    const first = post(app, { slotStart: SLOT, phone: PHONE10 }, key);
    await vi.waitFor(() => expect(push).toHaveBeenCalled());
    const second = await post(app, { slotStart: SLOT, phone: PHONE10 }, key);
    release();
    await first;
    await app.close();

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ type: 'urn:pialy:problem:request-in-progress', detail: 'Solicitud en proceso' });
  });

  it('answers the stored 502 problem when the push cannot be sent and never logs the phone', async () => {
    const logs = captureLogs();
    const push = vi.fn<PushCharge>(() => Promise.reject(new RailUnavailableError('pey POST /codi/pn responded 503')));
    const app = appWith(push, { logStream: logs.stream });
    const key = randomUUID();

    const res = await post(app, { slotStart: SLOT, phone: '55 1234 5678' }, key);
    const replay = await post(app, { slotStart: SLOT, phone: '55 1234 5678' }, key);
    await app.close();

    expect(res.statusCode).toBe(502);
    expect(res.headers['content-type']).toContain(PROBLEM);
    expect(res.json()).toMatchObject({ detail: 'No pudimos enviar la solicitud. Intenta de nuevo o paga con QR.' });
    expect(replay.statusCode).toBe(502);
    expect(replay.body).toBe(res.body);
    const out = logs.text();
    expect(out).toContain('codi push failed');
    expect(out).not.toContain(PHONE10);
    expect(out).not.toContain('1234 5678');
  });
});

describe('GET /api/bookings/:token', () => {
  it('shows a held booking without phone data', async () => {
    const app = appWith();
    const { token } = (await post(app, { slotStart: SLOT, phone: PHONE10, customerName: 'Ana' })).json<{ token: string }>();

    const res = await app.inject({ method: 'GET', url: `/api/bookings/${token}` });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      token,
      status: 'holding',
      late: false,
      slot: { start: SLOT, end: '2026-11-15T15:45:00.000Z' },
      holdExpiresAt: '2026-11-14T12:06:00.000Z',
      attempts: [{ mode: 'push', status: 'awaiting' }],
    });
    expect(res.body).not.toContain('phoneHash');
    expect(res.body).not.toContain(PHONE10);
  });

  it('adds the pass once the payment confirmed the booking', async () => {
    const app = appWith();
    const { token } = (await post(app, { slotStart: SLOT, phone: PHONE10 })).json<{ token: string }>();
    const [attempt] = await db.select().from(paymentAttempts);
    await applyProviderPayment(
      createDrizzleUnitOfWork(db, paymentReaction),
      { findPayments: () => Promise.resolve([]) },
      {
        providerTxId: 'TX1',
        amount: money(1),
        paidAt: new Date('2026-11-14T12:02:00.000Z'),
        trackingKey: '0192191042',
        ref: { attemptId: attempt!.id },
      },
      'reconcile',
      {},
    );

    const res = await app.inject({ method: 'GET', url: `/api/bookings/${token}` });
    await app.close();

    expect(res.json()).toMatchObject({
      status: 'confirmed',
      attempts: [{ mode: 'push', status: 'succeeded' }],
      pass: { time: SLOT, phoneLast4: '5678', trackingKey: '0192191042' },
    });
  });

  it.each(['nope', 'x'.repeat(80), 'A'.repeat(22)])('answers 404 for the unknown token %s', async (token) => {
    const app = appWith();
    const res = await app.inject({ method: 'GET', url: `/api/bookings/${token}` });
    await app.close();

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain(PROBLEM);
  });
});
