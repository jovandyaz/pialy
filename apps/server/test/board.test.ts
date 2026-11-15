import { randomBytes } from 'node:crypto';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { bookings, flags, outbox, paymentEvents, paymentIntents, resources } from '../src/infrastructure/db/schema.js';
import { seedDemo } from '../src/infrastructure/db/seed.js';
import { cleanDb, openTestDb, testDeps, TEST_PIN } from './support.js';

const handle = openTestDb();
const { db } = handle;
afterAll(() => handle.close());
beforeEach(async () => {
  await cleanDb(handle);
  await seedDemo(db);
});

const SLOT_START = new Date('2026-11-20T15:00:00Z');
const DATE = '2026-11-20';
const NOW = new Date('2026-11-14T12:00:00Z');
const PHONE_HASH = 'phone-hash-must-never-leave';
const CLABE = '012180001234567899';

let current: FastifyInstance | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

function appAt(now: Date = NOW): FastifyInstance {
  current = buildApp(testDeps(handle, { clock: { now: () => now } }));
  return current;
}

async function login(app: FastifyInstance, pin = TEST_PIN) {
  return app.inject({ method: 'POST', url: '/api/session', payload: { pin } });
}

/** `name=value` of the session cookie, as a browser would send it back. */
async function ownerCookie(app: FastifyInstance): Promise<string> {
  const response = await login(app);
  const set = response.cookies.find((c) => c.name === 'pialy_owner');
  if (!set) throw new Error('no session cookie');
  return `pialy_owner=${set.value}`;
}

async function booking(status: string, options: { bankCode?: number | string; slotStart?: Date } = {}) {
  const [resource] = await db.select().from(resources);
  const slotStart = options.slotStart ?? SLOT_START;
  const [intent] = await db
    .insert(paymentIntents)
    .values({ reference: `R-${randomBytes(4).toString('hex')}`, amountMinor: 1, status: 'succeeded' })
    .returning();
  const token = randomBytes(16).toString('base64url');
  const [row] = await db
    .insert(bookings)
    .values({
      token,
      businessId: resource!.businessId,
      resourceId: resource!.id,
      intentId: intent!.id,
      slotStart,
      during: { start: slotStart, end: new Date(slotStart.getTime() + 45 * 60_000) },
      status,
      customerName: 'Ana Pérez',
      phoneLast4: '5678',
      phoneHash: PHONE_HASH,
    })
    .returning();
  if (options.bankCode !== undefined) {
    await db.insert(paymentEvents).values({
      intentId: intent!.id,
      providerTxId: `TX-${token}`,
      amountMinor: 1,
      raw: { metadata: { bankCode: options.bankCode, clabe: CLABE } },
    });
  }
  return { id: row!.id, token };
}

describe('owner session', () => {
  it('answers 401 without the cookie on every owner endpoint', async () => {
    const app = appAt();
    const { token } = await booking('confirmed');
    const calls = [
      { method: 'GET', url: `/api/board?date=${DATE}` },
      { method: 'GET', url: '/api/board/events' },
      { method: 'GET', url: `/api/verify/${token}` },
      { method: 'POST', url: `/api/bookings/${token}/check-in` },
      { method: 'POST', url: '/api/flags/2c4e6a1e-1f6e-4d5a-9a53-3f3b2f6e9d11/resolve', payload: { note: 'x' } },
    ] as const;
    for (const call of calls) {
      const response = await app.inject(call);
      expect(response.statusCode, `${call.method} ${call.url}`).toBe(401);
      expect(response.headers['content-type']).toContain('application/problem+json');
    }
  });

  it('rejects a wrong PIN and limits attempts to 5 per 10 minutes per IP: the 6th is 429', async () => {
    const app = appAt();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await login(app, 'wrong')).statusCode);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    const limited = await login(app, 'wrong');
    expect(limited.headers['content-type']).toContain('application/problem+json');
    expect(limited.json()).toMatchObject({ status: 429, detail: 'Demasiados intentos. Espera unos minutos.' });
    expect((await login(app)).statusCode).toBe(429);
  });

  it('caps wrong PINs across all IPs at 20 per 10 minutes, locking out even the right PIN until the window passes', async () => {
    let now = NOW;
    current = buildApp(testDeps(handle, { clock: { now: () => now } }));
    const app = current;
    const from = (ip: string, pin: string) =>
      app.inject({ method: 'POST', url: '/api/session', headers: { 'x-real-ip': ip }, payload: { pin } });
    for (let i = 1; i <= 20; i += 1) expect((await from(`10.0.0.${i}`, 'wrong')).statusCode).toBe(401);

    const locked = await from('10.0.1.1', TEST_PIN);
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['content-type']).toContain('application/problem+json');

    now = new Date(NOW.getTime() + 10 * 60_000 + 1);
    expect((await from('10.0.1.2', TEST_PIN)).statusCode).toBe(204);
  });

  it('logs one warn line, without the PIN or any IP, when the global failed-PIN cap trips', async () => {
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(...chunk.toString().split('\n'));
        cb();
      },
    });
    current = buildApp(testDeps(handle, { logStream }));
    const app = current;
    const from = (ip: string, pin: string) =>
      app.inject({ method: 'POST', url: '/api/session', headers: { 'x-real-ip': ip }, payload: { pin } });
    for (let i = 1; i <= 20; i += 1) await from(`10.0.0.${i}`, 'wrong-pin-secret');
    for (let i = 1; i <= 3; i += 1) expect((await from(`10.0.1.${i}`, 'wrong-pin-secret')).statusCode).toBe(429);

    const locked = lines.filter((line) => line.includes('owner login locked: global failed-PIN cap reached'));
    expect(locked).toHaveLength(1);
    expect(JSON.parse(locked[0] ?? '{}')).toMatchObject({ level: 40 });
    expect(locked[0]).not.toContain('wrong-pin-secret');
    expect(locked[0]).not.toContain('10.0.');
  });

  it('sets a signed httpOnly SameSite=Strict cookie that lasts 12 hours', async () => {
    const app = appAt();
    const response = await login(app);
    expect(response.statusCode).toBe(204);
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('pialy_owner=');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toContain('Max-Age=43200');
    expect(setCookie).not.toMatch(/Secure/i);
    expect(setCookie).not.toContain(TEST_PIN);
  });

  it('accepts the cookie, and rejects a tampered one and one older than 12 hours', async () => {
    const app = appAt();
    const cookie = await ownerCookie(app);
    const board = (headers: Record<string, string>) => app.inject({ method: 'GET', url: `/api/board?date=${DATE}`, headers });
    expect((await board({ cookie })).statusCode).toBe(200);
    expect((await board({ cookie: `${cookie}x` })).statusCode).toBe(401);
    expect((await board({ cookie: 'pialy_owner=1.forged' })).statusCode).toBe(401);

    await current?.close();
    const later = appAt(new Date(NOW.getTime() + 12 * 3_600_000 + 1000));
    expect((await later.inject({ method: 'GET', url: `/api/board?date=${DATE}`, headers: { cookie } })).statusCode).toBe(401);
  });

  it('logs out by clearing the cookie', async () => {
    const app = appAt();
    const response = await app.inject({ method: 'DELETE', url: '/api/session' });
    expect(response.statusCode).toBe(204);
    expect(String(response.headers['set-cookie'])).toMatch(/pialy_owner=;/);
  });

  it('marks the cookie Secure in production', async () => {
    current = buildApp(
      testDeps(handle, {
        env: { ...testDeps(handle).env, NODE_ENV: 'production' },
      }),
    );
    const response = await login(current);
    expect(String(response.headers['set-cookie'])).toMatch(/Secure/i);
  });
});

describe('board', () => {
  it('lists the day with each booking as name, last 4 and bank name, and never the phone hash or CLABE', async () => {
    const app = appAt();
    const cookie = await ownerCookie(app);
    const confirmed = await booking('confirmed', { bankCode: 40012 });
    await db.update(bookings).set({ late: true }).where(eq(bookings.id, confirmed.id));
    await booking('holding', { slotStart: new Date('2026-11-20T15:45:00Z'), bankCode: 99999 });
    await booking('expired', { slotStart: new Date('2026-11-20T16:30:00Z') });

    const response = await app.inject({ method: 'GET', url: `/api/board?date=${DATE}`, headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<{
      date: string;
      slots: { start: string; end: string; booking: Record<string, unknown> | null }[];
      flags: unknown[];
    }>();
    expect(body.date).toBe(DATE);
    expect(body.slots).toHaveLength(14);
    expect(body.slots[0]).toMatchObject({
      start: '2026-11-20T15:00:00.000Z',
      booking: {
        token: confirmed.token,
        status: 'confirmed',
        late: true,
        customerName: 'Ana Pérez',
        phoneLast4: '5678',
        bankName: 'BBVA',
        checkedInAt: null,
      },
    });
    expect(body.slots[1]?.booking).toMatchObject({ status: 'holding', bankName: null });
    expect(body.slots[2]?.booking).toBeNull();
    expect(response.body).not.toContain(PHONE_HASH);
    expect(response.body).not.toContain(CLABE);
    expect(response.body).not.toContain('phoneHash');
  });

  it('lists bookings paid in the last 15 minutes for any day, with only what the payment notice needs', async () => {
    const app = appAt();
    const cookie = await ownerCookie(app);
    const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
    const paidAt = async (id: string, at: Date) => db.update(bookings).set({ confirmedAt: at }).where(eq(bookings.id, id));
    const older = await booking('checked_in', { slotStart: new Date('2026-11-18T15:00:00Z') });
    await paidAt(older.id, minutesAgo(14));
    const latest = await booking('confirmed', { slotStart: new Date('2026-11-18T16:30:00Z'), bankCode: 40012 });
    await paidAt(latest.id, minutesAgo(1));
    const stale = await booking('confirmed', { slotStart: new Date('2026-11-18T17:15:00Z') });
    await paidAt(stale.id, minutesAgo(16));
    await booking('holding', { slotStart: new Date('2026-11-18T18:00:00Z') });

    const response = await app.inject({ method: 'GET', url: '/api/board', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ date: string; slots: { booking: unknown }[]; recent: unknown[] }>();
    expect(body.date).toBe('2026-11-14');
    expect(body.slots.every((slot) => slot.booking === null)).toBe(true);
    expect(body.recent).toEqual([
      {
        token: older.token,
        slotStart: '2026-11-18T15:00:00.000Z',
        customerName: 'Ana Pérez',
        bankName: null,
        confirmedAt: minutesAgo(14).toISOString(),
      },
      {
        token: latest.token,
        slotStart: '2026-11-18T16:30:00.000Z',
        customerName: 'Ana Pérez',
        bankName: 'BBVA',
        confirmedAt: minutesAgo(1).toISOString(),
      },
    ]);
    expect(response.body).not.toContain(PHONE_HASH);
    expect(response.body).not.toContain(CLABE);
  });

  it('defaults to today in the business time zone and rejects a malformed date', async () => {
    const app = appAt();
    const cookie = await ownerCookie(app);
    const today = await app.inject({ method: 'GET', url: '/api/board', headers: { cookie } });
    expect(today.json<{ date: string }>().date).toBe('2026-11-14');
    const bad = await app.inject({ method: 'GET', url: '/api/board?date=hoy', headers: { cookie } });
    expect(bad.statusCode).toBe(400);
  });

  it('shows open flags with their booking and hides resolved ones', async () => {
    const app = appAt();
    const cookie = await ownerCookie(app);
    const { id, token } = await booking('confirmed');
    const [flag] = await db
      .insert(flags)
      .values({
        kind: 'refund_due',
        bookingId: id,
        payload: { reason: 'duplicate_payment', paidAt: '2026-11-14T12:00:00.000Z', amount: { amountMinor: 1, currency: 'MXN' }, trackingKey: 'K1' },
      })
      .returning();

    const open = await app.inject({ method: 'GET', url: `/api/board?date=${DATE}`, headers: { cookie } });
    expect(open.json<{ flags: unknown[] }>().flags).toEqual([
      {
        id: flag!.id,
        kind: 'refund_due',
        trackingKey: 'K1',
        createdAt: expect.any(String),
        reason: 'duplicate_payment',
        paidAt: '2026-11-14T12:00:00.000Z',
        amount: { amountMinor: 1, currency: 'MXN' },
        expected: null,
        received: null,
        booking: { token, customerName: 'Ana Pérez', phoneLast4: '5678', slotStart: '2026-11-20T15:00:00.000Z' },
      },
    ]);

    const resolved = await app.inject({
      method: 'POST',
      url: `/api/flags/${flag!.id}/resolve`,
      headers: { cookie },
      payload: { note: 'Reembolsado por SPEI' },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual({ id: flag!.id, resolvedAt: NOW.toISOString() });
    const [stored] = await db.select().from(flags).where(eq(flags.id, flag!.id));
    expect(stored).toMatchObject({ note: 'Reembolsado por SPEI', resolvedAt: NOW });

    const after = await app.inject({ method: 'GET', url: `/api/board?date=${DATE}`, headers: { cookie } });
    expect(after.json<{ flags: unknown[] }>().flags).toEqual([]);
    const again = await app.inject({
      method: 'POST',
      url: `/api/flags/${flag!.id}/resolve`,
      headers: { cookie },
      payload: { note: 'otra vez' },
    });
    expect(again.statusCode).toBe(404);
    const noNote = await app.inject({ method: 'POST', url: `/api/flags/${flag!.id}/resolve`, headers: { cookie }, payload: {} });
    expect(noNote.statusCode).toBe(400);
  });
});

describe('board flags with bad rows', () => {
  it('still serves the board when one flag has a malformed payload or an unknown kind', async () => {
    const app = appAt();
    const cookie = await ownerCookie(app);
    await db.execute(sql`ALTER TABLE flags DROP CONSTRAINT flags_kind_check`);
    try {
      await db.insert(flags).values([
        { kind: 'refund_due', payload: { amount: 'not money' } },
        { kind: 'mystery', payload: { reason: 'x' } },
        { kind: 'amount_mismatch', payload: { reason: 'ok' } },
      ]);

      const response = await app.inject({ method: 'GET', url: `/api/board?date=${DATE}`, headers: { cookie } });

      expect(response.statusCode).toBe(200);
      const rows = response.json<{ flags: { kind: string; reason: string | null; trackingKey: string | null }[] }>().flags;
      expect(rows.map((f) => f.kind).sort()).toEqual(['amount_mismatch', 'refund_due', 'unknown']);
      expect(rows.find((f) => f.kind === 'refund_due')).toMatchObject({ reason: null, trackingKey: null });
      expect(rows.find((f) => f.kind === 'amount_mismatch')?.reason).toBe('ok');
    } finally {
      await db.delete(flags);
      await db.execute(sql`ALTER TABLE flags ADD CONSTRAINT flags_kind_check CHECK (kind IN ('unmatched_payment','refund_due','amount_mismatch'))`);
    }
  });
});

describe('check-in', () => {
  it('checks in a confirmed booking once; the second call is 409 with the original time', async () => {
    const app = appAt();
    const cookie = await ownerCookie(app);
    const { token } = await booking('confirmed');
    const url = `/api/bookings/${token}/check-in`;

    const first = await app.inject({ method: 'POST', url, headers: { cookie } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ checkedInAt: NOW.toISOString() });

    await current?.close();
    const later = appAt(new Date(NOW.getTime() + 60_000));
    const second = await later.inject({ method: 'POST', url, headers: { cookie } });
    expect(second.statusCode).toBe(409);
    expect(second.headers['content-type']).toContain('application/problem+json');
    expect(second.json()).toMatchObject({ status: 409, detail: 'Este pase ya se usó', checkedInAt: NOW.toISOString() });

    const [row] = await db.select().from(bookings).where(eq(bookings.token, token));
    expect(row).toMatchObject({ status: 'checked_in', checkedInAt: NOW });
  });

  it('refuses a booking that is not confirmed, or unknown', async () => {
    const app = appAt();
    const cookie = await ownerCookie(app);
    for (const status of ['holding', 'expired', 'canceled']) {
      const { token } = await booking(status, { slotStart: new Date(`2026-11-2${status.length % 9}T15:00:00Z`) });
      const response = await app.inject({ method: 'POST', url: `/api/bookings/${token}/check-in`, headers: { cookie } });
      expect(response.statusCode, status).toBe(409);
      expect(response.json()).toMatchObject({ detail: 'Anticipo no confirmado' });
      expect(response.json()).not.toHaveProperty('checkedInAt');
    }
    const missing = await app.inject({
      method: 'POST',
      url: `/api/bookings/${randomBytes(16).toString('base64url')}/check-in`,
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('lets exactly one of two simultaneous check-ins win', async () => {
    const app = appAt();
    const cookie = await ownerCookie(app);
    const { token } = await booking('confirmed');
    const url = `/api/bookings/${token}/check-in`;

    const responses = await Promise.all([
      app.inject({ method: 'POST', url, headers: { cookie } }),
      app.inject({ method: 'POST', url, headers: { cookie } }),
    ]);

    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });

  it('announces the check-in to the board and the booking page through the outbox', async () => {
    const app = appAt();
    const cookie = await ownerCookie(app);
    const { token } = await booking('confirmed');
    await app.inject({ method: 'POST', url: `/api/bookings/${token}/check-in`, headers: { cookie } });

    const rows = await db.select().from(outbox);
    expect(rows.map((r) => r.topic).sort()).toEqual(['board', `booking:${token}`]);
    expect(rows[0]?.payload).toMatchObject({ type: 'booking.updated', status: 'checked_in' });
  });
});

describe('verify and pass', () => {
  it('returns the pass status for staff behind the owner cookie', async () => {
    const app = appAt();
    const cookie = await ownerCookie(app);
    const { token } = await booking('confirmed', { bankCode: '40072' });

    const response = await app.inject({ method: 'GET', url: `/api/verify/${token}`, headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      token,
      status: 'confirmed',
      late: false,
      slotStart: '2026-11-20T15:00:00.000Z',
      customerName: 'Ana Pérez',
      phoneLast4: '5678',
      bankName: 'Banorte',
      checkedInAt: null,
    });
    const missing = await app.inject({
      method: 'GET',
      url: `/api/verify/${randomBytes(16).toString('base64url')}`,
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('adds the payer bank name to the customer pass, null when the code is unknown', async () => {
    const app = appAt();
    const known = await booking('confirmed', { bankCode: 40014 });
    const unknown = await booking('confirmed', { bankCode: 12345, slotStart: new Date('2026-11-20T15:45:00Z') });
    const none = await booking('confirmed', { slotStart: new Date('2026-11-20T16:30:00Z') });

    const pass = async (token: string) =>
      (await app.inject({ method: 'GET', url: `/api/bookings/${token}` })).json<{ pass: { bankName: string | null } }>().pass;

    expect((await pass(known.token)).bankName).toBe('Santander');
    expect((await pass(unknown.token)).bankName).toBeNull();
    expect((await pass(none.token)).bankName).toBeNull();
  });
});

describe('board events', () => {
  it('streams the board topic to the owner', async () => {
    const app = appAt();
    const cookie = await ownerCookie(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    const { status, type } = await new Promise<{ status: number | undefined; type: string | undefined }>((resolve, reject) => {
      const request = get(`http://127.0.0.1:${port}/api/board/events`, { headers: { cookie } }, (response) => {
        resolve({ status: response.statusCode, type: response.headers['content-type'] });
        request.destroy();
      });
      request.on('error', reject);
    });

    expect(status).toBe(200);
    expect(type).toBe('text/event-stream');
  });
});
