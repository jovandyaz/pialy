import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createPeyConnector } from '@pialy/connector-pey';
import { applyProviderPayment, money, receiveWebhook, type RailConnector } from '@pialy/payments';
import { eq, sql } from 'drizzle-orm';
import { Webhook } from 'standardwebhooks';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  bookings,
  flags,
  outbox,
  paymentAttempts,
  paymentEvents,
  paymentIntents,
  resources,
  webhookInbox,
} from '../src/infrastructure/db/schema.js';
import { seedDemo } from '../src/infrastructure/db/seed.js';
import { createDrizzleUnitOfWork } from '../src/infrastructure/payments/drizzle-unit-of-work.js';
import { paymentReaction } from '../src/infrastructure/payments/payment-reaction.js';
import { cleanDb, openTestDb, testDeps } from './support.js';

const handle = openTestDb();
const { db } = handle;
afterAll(() => handle.close());
beforeEach(() => cleanDb(handle));

const WEBHOOK_SECRET = `whsec_${Buffer.from('pialy-webhook-route-test-secret').toString('base64')}`;
const URL_PATH = '/api/webhooks/pey';
const TX = '01M3QR5E7XHXMNZDEPFH3JAWS0';
const CLABE = '012180001234567890';
const PAID_AT_SECONDS = Math.floor(Date.parse('2026-11-14T18:02:30Z') / 1000);

const fetchMock = vi.fn<typeof fetch>();
afterEach(() => fetchMock.mockReset());

const connector: RailConnector = createPeyConnector({
  apiKey: 'pey_test_key',
  baseUrl: 'https://api.pey.test',
  webhookSecret: WEBHOOK_SECRET,
  fetch: fetchMock,
  sleep: () => Promise.resolve(),
});

interface Fixture {
  readonly intentId: string;
  readonly attemptId: string;
  readonly bookingId: string;
  readonly token: string;
}

async function holdingBooking(attempt: { providerTxId?: string } = { providerTxId: TX }): Promise<Fixture> {
  await seedDemo(db);
  const [resource] = await db.select().from(resources);
  if (!resource) throw new Error('no resource');
  const [intent] = await db
    .insert(paymentIntents)
    .values({ reference: `R-${randomUUID()}`, amountMinor: 1, status: 'processing' })
    .returning();
  const [created] = await db
    .insert(paymentAttempts)
    .values({
      intentId: intent!.id,
      mode: 'push',
      providerTxId: attempt.providerTxId ?? null,
      status: 'awaiting',
      expiresAt: new Date('2026-11-14T18:06:00Z'),
    })
    .returning();
  const token = `tok_${randomUUID()}`;
  const slotStart = new Date('2026-11-20T15:00:00Z');
  const [booking] = await db
    .insert(bookings)
    .values({
      token,
      businessId: resource.businessId,
      resourceId: resource.id,
      intentId: intent!.id,
      slotStart,
      during: { start: slotStart, end: new Date('2026-11-20T15:45:00Z') },
      status: 'holding',
      phoneLast4: '5678',
      phoneHash: 'hash',
      holdExpiresAt: new Date('2026-11-14T18:06:00Z'),
    })
    .returning();
  return { intentId: intent!.id, attemptId: created!.id, bookingId: booking!.id, token };
}

function pnWebhook(fields: { transactionId?: string; amount?: number; attemptId?: string } = {}): string {
  return JSON.stringify({
    amount: fields.amount ?? 0.01,
    apiKeyId: '01M3QMMR6X9CBVDY1SF3G8QWNW',
    concept: 'Anticipo cita',
    datePaid: PAID_AT_SECONDS,
    metadata: {
      clabe: CLABE,
      bankCode: 40012,
      accountType: 40,
      description: 'Anticipo cita',
      trackingKey: '0192191042',
      externalMetadata: fields.attemptId === undefined ? {} : { attemptId: fields.attemptId },
    },
    numRef: '1001',
    transactionId: fields.transactionId ?? TX,
    type: 'codi.pn.payment_received',
  });
}

function signed(body: string, webhookId = `msg_${randomUUID()}`): Record<string, string> {
  const at = new Date();
  return {
    'content-type': 'application/json',
    'webhook-id': webhookId,
    'webhook-timestamp': String(Math.floor(at.getTime() / 1000)),
    'webhook-signature': new Webhook(WEBHOOK_SECRET).sign(webhookId, at, body),
  };
}

function paidTransaction(base: number, total = base): Response {
  return new Response(
    JSON.stringify({
      id: TX,
      status: 'PAID',
      amount: total,
      amountBreakdown: { base, tip: 0, fee: total - base },
      currency: 'MXN',
      datePaid: PAID_AT_SECONDS,
      metadata: { clabe: CLABE, bankCode: 40012, trackingKey: '0192191042' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
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

function appWith(logStream?: Writable) {
  return buildApp(testDeps(handle, { connector, ...(logStream ? { logStream } : {}) }));
}

async function rowCounts() {
  const count = async (table: typeof paymentEvents | typeof webhookInbox | typeof outbox | typeof flags) =>
    (await db.select({ n: sql<number>`count(*)::int` }).from(table))[0]?.n;
  return {
    events: await count(paymentEvents),
    inbox: await count(webhookInbox),
    outbox: await count(outbox),
    flags: await count(flags),
  };
}

describe('POST /api/webhooks/pey', () => {
  it('applies a signed payment once: booking confirmed, money trace, outbox and inbox rows', async () => {
    const f = await holdingBooking();
    const logs = captureLogs();
    const app = appWith(logs.stream);
    const body = pnWebhook({ attemptId: f.attemptId });
    const headers = signed(body, 'msg_applied_1');

    const res = await app.inject({ method: 'POST', url: URL_PATH, headers, payload: body });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'applied' });
    const [booking] = await db.select().from(bookings).where(eq(bookings.id, f.bookingId));
    expect(booking).toMatchObject({ status: 'confirmed' });
    expect(booking?.confirmedAt).toBeInstanceOf(Date);
    const events = await db.select().from(paymentEvents);
    expect(events).toEqual([
      expect.objectContaining({
        providerTxId: TX,
        attemptId: f.attemptId,
        intentId: f.intentId,
        amountMinor: 1,
        trackingKey: '0192191042',
        late: false,
      }),
    ]);
    const topics = (await db.select().from(outbox)).map((row) => row.topic).sort();
    expect(topics).toEqual(['board', `booking:${f.token}`]);
    const [inbox] = await db.select().from(webhookInbox);
    expect(inbox).toMatchObject({ webhookId: 'msg_applied_1', eventType: 'codi.pn.payment_received', outcome: 'applied' });
    expect(inbox?.processedAt).toBeInstanceOf(Date);
    expect(await db.select().from(paymentIntents)).toEqual([expect.objectContaining({ status: 'succeeded' })]);
    expect(await db.select().from(paymentAttempts)).toEqual([expect.objectContaining({ status: 'succeeded' })]);

    const out = logs.text();
    expect(out).toContain('msg_applied_1');
    expect(out).toContain(TX);
    expect(out).not.toContain(CLABE);
    expect(out).not.toContain(headers['webhook-signature']);
  });

  it('answers a redelivery of the same webhook-id as duplicate without new rows', async () => {
    const f = await holdingBooking();
    const app = appWith();
    const body = pnWebhook({ attemptId: f.attemptId });
    const headers = signed(body, 'msg_dup_1');
    await app.inject({ method: 'POST', url: URL_PATH, headers, payload: body });
    const before = await rowCounts();

    const res = await app.inject({ method: 'POST', url: URL_PATH, headers, payload: body });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'duplicate' });
    expect(await rowCounts()).toEqual(before);
  });

  it('rejects a tampered body with 401, writes nothing and logs only the webhook id', async () => {
    await holdingBooking();
    const logs = captureLogs();
    const app = appWith(logs.stream);
    const body = pnWebhook();
    const headers = signed(body, 'msg_tampered_1');
    const tampered = body.replace('"amount":0.01', '"amount":100');

    const res = await app.inject({ method: 'POST', url: URL_PATH, headers, payload: tampered });
    await app.close();

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(await rowCounts()).toEqual({ events: 0, inbox: 0, outbox: 0, flags: 0 });
    const out = logs.text();
    expect(out).toContain('msg_tampered_1');
    expect(out).not.toContain(CLABE);
    expect(out).not.toContain(headers['webhook-signature']);
  });

  it('records a payment no attempt claims and flags it unmatched', async () => {
    const f = await holdingBooking();
    const app = appWith();
    const body = pnWebhook({ transactionId: '01UNKNOWNTX000000000000000', attemptId: randomUUID() });

    const res = await app.inject({ method: 'POST', url: URL_PATH, headers: signed(body), payload: body });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'unmatched' });
    const [flag] = await db.select().from(flags);
    expect(flag).toMatchObject({ kind: 'unmatched_payment', bookingId: null });
    expect(flag?.payload).toMatchObject({ providerTxId: '01UNKNOWNTX000000000000000', amount: { amountMinor: 1 } });
    expect(await db.select().from(paymentEvents)).toEqual([
      expect.objectContaining({ providerTxId: '01UNKNOWNTX000000000000000', attemptId: null, intentId: null }),
    ]);
    const [booking] = await db.select().from(bookings).where(eq(bookings.id, f.bookingId));
    expect(booking?.status).toBe('holding');
  });

  it('matches by metadata attemptId when the transaction id is not stored yet', async () => {
    const f = await holdingBooking({});
    const app = appWith();
    const body = pnWebhook({ attemptId: f.attemptId });

    const res = await app.inject({ method: 'POST', url: URL_PATH, headers: signed(body), payload: body });
    await app.close();

    expect(res.json()).toEqual({ status: 'applied' });
    const [attempt] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, f.attemptId));
    expect(attempt).toMatchObject({ status: 'succeeded', providerTxId: TX });
  });

  it('treats an attemptId that is not one of ours as unmatched', async () => {
    await holdingBooking();
    const app = appWith();
    const body = pnWebhook({ transactionId: '01UNKNOWNTX000000000000000', attemptId: 'att_not_a_uuid' });

    const res = await app.inject({ method: 'POST', url: URL_PATH, headers: signed(body), payload: body });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'unmatched' });
  });

  it('applies a fee-inclusive webhook amount once the rail confirms the base amount', async () => {
    const f = await holdingBooking();
    fetchMock.mockResolvedValueOnce(paidTransaction(0.01, 0.03));
    const app = appWith();
    const body = pnWebhook({ amount: 0.03 });

    const res = await app.inject({ method: 'POST', url: URL_PATH, headers: signed(body), payload: body });
    await app.close();

    expect(res.json()).toEqual({ status: 'applied' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://api.pey.test/transaction/${TX}`);
    expect(await db.select().from(paymentEvents)).toEqual([expect.objectContaining({ amountMinor: 1 })]);
    const [booking] = await db.select().from(bookings).where(eq(bookings.id, f.bookingId));
    expect(booking?.status).toBe('confirmed');
  });

  it('keeps the money trace and flags amount_mismatch when the rail confirms a wrong amount', async () => {
    const f = await holdingBooking();
    fetchMock.mockResolvedValueOnce(paidTransaction(0.02));
    const app = appWith();
    const body = pnWebhook({ amount: 0.02 });

    const res = await app.inject({ method: 'POST', url: URL_PATH, headers: signed(body), payload: body });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'unmatched' });
    const [flag] = await db.select().from(flags);
    expect(flag).toMatchObject({ kind: 'amount_mismatch', bookingId: f.bookingId });
    expect(flag?.payload).toMatchObject({
      providerTxId: TX,
      expected: { amountMinor: 1, currency: 'MXN' },
      received: { amountMinor: 2, currency: 'MXN' },
      amountCheck: 'rail_lookup',
    });
    expect(await db.select().from(paymentEvents)).toEqual([
      expect.objectContaining({ attemptId: f.attemptId, intentId: f.intentId, amountMinor: 2 }),
    ]);
    const [booking] = await db.select().from(bookings).where(eq(bookings.id, f.bookingId));
    expect(booking?.status).toBe('holding');
    expect(await db.select().from(paymentIntents)).toEqual([expect.objectContaining({ status: 'processing' })]);
  });

  it('flags amount_mismatch with the delivered amount when the rail lookup fails', async () => {
    await holdingBooking();
    fetchMock.mockResolvedValue(new Response('{"message":"down"}', { status: 503 }));
    const app = appWith();
    const body = pnWebhook({ amount: 0.03 });

    const res = await app.inject({ method: 'POST', url: URL_PATH, headers: signed(body), payload: body });
    await app.close();

    expect(res.json()).toEqual({ status: 'unmatched' });
    const [flag] = await db.select().from(flags);
    expect(flag).toMatchObject({ kind: 'amount_mismatch' });
    expect(flag?.payload).toMatchObject({ received: { amountMinor: 3 }, amountCheck: 'rail_lookup_failed' });
  });

  it('answers 500 to a signed but malformed payment event so pey retries, and writes nothing', async () => {
    await holdingBooking();
    const app = appWith();
    const body = JSON.stringify({ type: 'codi.pn.payment_received', amount: 0.01 });

    const res = await app.inject({ method: 'POST', url: URL_PATH, headers: signed(body), payload: body });
    await app.close();

    expect(res.statusCode).toBe(500);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(await rowCounts()).toEqual({ events: 0, inbox: 0, outbox: 0, flags: 0 });
  });

  it('keeps the raw body out of the logs when storing the payment fails', async () => {
    await holdingBooking();
    const logs = captureLogs();
    const app = appWith(logs.stream);
    // Postgres jsonb rejects \u0000, so the insert fails with the whole body among its parameters.
    const body = pnWebhook().replace('"concept":"Anticipo cita"', '"concept":"Anticipo\\u0000cita"');

    const res = await app.inject({ method: 'POST', url: URL_PATH, headers: signed(body, 'msg_db_fail_1'), payload: body });
    await app.close();

    expect(res.statusCode).toBe(500);
    expect(await rowCounts()).toEqual({ events: 0, inbox: 0, outbox: 0, flags: 0 });
    const out = logs.text();
    expect(out).toContain('msg_db_fail_1');
    expect(out).toContain('22P05');
    expect(out).not.toContain(CLABE);
  });

  it('logs a verified event that reports no payment and ignores it', async () => {
    const app = appWith();
    const body = JSON.stringify({ type: 'bank_account.updated', id: 'ba_1' });

    const res = await app.inject({ method: 'POST', url: URL_PATH, headers: signed(body, 'msg_other_1'), payload: body });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ignored' });
    expect(await db.select().from(webhookInbox)).toEqual([
      expect.objectContaining({ webhookId: 'msg_other_1', eventType: 'bank_account.updated', outcome: 'ignored' }),
    ]);
  });

  it('keeps JSON body parsing for every other route', async () => {
    const app = appWith();
    app.post('/probe', (request) => ({ bodyType: typeof request.body }));

    const res = await app.inject({
      method: 'POST',
      url: '/probe',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":1}',
    });
    await app.close();

    expect(res.json()).toEqual({ bodyType: 'object' });
  });
});

describe('applying a payment concurrently', () => {
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

  /** Holds the intent row lock until `contenders` transactions queue behind it, then lets them race. */
  async function raceBehindIntentLock<T>(intentId: string, contenders: number, start: () => T): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.transaction(async (tx) => {
      await tx.select().from(paymentIntents).where(eq(paymentIntents.id, intentId)).for('update');
      locked();
      await gate;
    });
    await lockTaken;
    const started = start();
    try {
      await waitForLockWaiters(contenders);
    } finally {
      release();
      await holder;
    }
    return started;
  }

  it('applies once when a webhook and a reconcile deliver the same payment at the same time', async () => {
    const f = await holdingBooking();
    const app = appWith();
    const uow = createDrizzleUnitOfWork(db, paymentReaction);
    const body = pnWebhook({ attemptId: f.attemptId });
    const payment = {
      providerTxId: TX,
      amount: money(1),
      paidAt: new Date(PAID_AT_SECONDS * 1000),
      ref: { transactionId: TX },
    };

    const [webhookRes, reconcileOutcome] = await raceBehindIntentLock(f.intentId, 2, () =>
      Promise.all([
        app.inject({ method: 'POST', url: URL_PATH, headers: signed(body), payload: body }),
        applyProviderPayment(uow, connector, payment, 'reconcile', { source: 'test' }),
      ]),
    );
    await app.close();

    const outcomes = [webhookRes.json<{ status: string }>().status, reconcileOutcome].sort();
    expect(outcomes).toEqual(['applied', 'duplicate']);
    expect(await db.select().from(paymentEvents)).toHaveLength(1);
    expect(await db.select().from(outbox)).toHaveLength(2);
    const [booking] = await db.select().from(bookings).where(eq(bookings.id, f.bookingId));
    expect(booking?.status).toBe('confirmed');
  });

  it('confirms once and reports the other as a second payment when two payments for one intent race', async () => {
    const f = await holdingBooking();
    await db.insert(paymentAttempts).values({
      intentId: f.intentId,
      mode: 'qr',
      providerQrId: 'QR1',
      status: 'awaiting',
      expiresAt: new Date('2026-11-14T18:10:00Z'),
    });
    const seen: string[] = [];
    const uow = createDrizzleUnitOfWork(db, async (tx, event) => {
      seen.push(event.type);
      await paymentReaction(tx, event);
    });
    const paidAt = new Date(PAID_AT_SECONDS * 1000);
    const viaPush = { providerTxId: TX, amount: money(1), paidAt, ref: { transactionId: TX } };
    const viaQr = { providerTxId: 'TX_QR_2', amount: money(1), paidAt, ref: { transactionId: 'TX_QR_2', qrId: 'QR1' } };

    const outcomes = await raceBehindIntentLock(f.intentId, 2, () =>
      Promise.all([
        applyProviderPayment(uow, connector, viaPush, 'reconcile', {}),
        applyProviderPayment(uow, connector, viaQr, 'reconcile', {}),
      ]),
    );

    expect(outcomes).toEqual(['applied', 'applied']);
    expect(seen.sort()).toEqual(['DuplicatePaymentReceived', 'PaymentSucceeded']);
    expect(await db.select().from(paymentEvents)).toHaveLength(2);
    expect(await db.select().from(outbox)).toHaveLength(2);
  });

  it('records an unmatched payment once when two deliveries race', async () => {
    const app = appWith();
    const body = pnWebhook({ transactionId: '01UNKNOWNTX000000000000000' });

    const responses = await Promise.all([
      app.inject({ method: 'POST', url: URL_PATH, headers: signed(body), payload: body }),
      app.inject({ method: 'POST', url: URL_PATH, headers: signed(body), payload: body }),
    ]);
    await app.close();

    expect(responses.map((r) => r.json<{ status: string }>().status).sort()).toEqual(['duplicate', 'unmatched']);
    expect(await db.select().from(paymentEvents)).toHaveLength(1);
    expect(await db.select().from(flags)).toHaveLength(1);
  });
});

describe('drizzle unit of work', () => {
  it('rolls back the inbox row with the payment when the reaction fails, so a redelivery applies', async () => {
    const f = await holdingBooking();
    const failing = createDrizzleUnitOfWork(db, () => Promise.reject(new Error('reaction crashed')));
    const body = pnWebhook({ attemptId: f.attemptId });
    const parsed = connector.parseWebhook(body, signed(body, 'msg_crash_1'));

    await expect(receiveWebhook(failing, connector, parsed, JSON.parse(body))).rejects.toThrow('reaction crashed');
    expect(await rowCounts()).toEqual({ events: 0, inbox: 0, outbox: 0, flags: 0 });
    expect(await db.select().from(paymentIntents)).toEqual([expect.objectContaining({ status: 'processing' })]);

    const working = createDrizzleUnitOfWork(db, paymentReaction);
    expect(await receiveWebhook(working, connector, parsed, JSON.parse(body))).toBe('applied');
  });

  it('reports other awaiting attempts of an intent', async () => {
    const f = await holdingBooking();
    const [second] = await db
      .insert(paymentAttempts)
      .values({ intentId: f.intentId, mode: 'qr', status: 'awaiting', expiresAt: new Date('2026-11-14T18:10:00Z') })
      .returning();
    const uow = createDrizzleUnitOfWork(db, paymentReaction);

    const [fromFirst, fromSecond] = await uow.run(async (tx) => [
      await tx.payments.hasOtherAwaiting(f.intentId, f.attemptId),
      await tx.payments.hasOtherAwaiting(f.intentId, second!.id),
    ]);
    expect([fromFirst, fromSecond]).toEqual([true, true]);

    await db.update(paymentAttempts).set({ status: 'expired' }).where(eq(paymentAttempts.id, second!.id));
    expect(await uow.run((tx) => tx.payments.hasOtherAwaiting(f.intentId, f.attemptId))).toBe(false);
  });

  it('refuses to guess when two attempts carry the same rail transaction id', async () => {
    const f = await holdingBooking();
    await db
      .insert(paymentAttempts)
      .values({ intentId: f.intentId, mode: 'push', providerTxId: TX, status: 'awaiting', expiresAt: new Date() });
    const uow = createDrizzleUnitOfWork(db, paymentReaction);

    await expect(uow.run((tx) => tx.payments.findAttemptByRef({ transactionId: TX }))).rejects.toThrow(
      /more than one attempt/,
    );
  });
});
