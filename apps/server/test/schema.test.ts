import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bookings, business, flags, paymentEvents, paymentIntents, resources, webhookInbox } from '../src/infrastructure/db/schema.js';
import { DEMO_BUSINESS_NAME, seedDemo } from '../src/infrastructure/db/seed.js';
import { cleanDb, openTestDb } from './support.js';

const handle = openTestDb();
const { db } = handle;

afterAll(() => handle.close());
beforeEach(() => cleanDb(handle));

let counter = 0;
async function fixture() {
  await seedDemo(db);
  const [res] = await db.select().from(resources);
  if (!res) throw new Error('no resource');
  return res;
}

function booking(resourceId: string, businessId: string, start: string, end: string, status = 'holding') {
  counter += 1;
  return {
    token: `tok-${counter}-${Math.random()}`,
    businessId,
    resourceId,
    slotStart: new Date(start),
    during: { start: new Date(start), end: new Date(end) },
    status,
    phoneLast4: '5678',
    phoneHash: `hash-${counter}`,
  };
}

async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    // drizzle wraps driver errors; the SQLSTATE lives on the cause.
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

describe('bookings exclusion constraint', () => {
  it('rejects overlapping active bookings for one resource with 23P01', async () => {
    const res = await fixture();
    await db.insert(bookings).values(booking(res.id, res.businessId, '2026-11-20T15:00:00Z', '2026-11-20T15:45:00Z'));
    const code = await pgCode(
      db.insert(bookings).values(booking(res.id, res.businessId, '2026-11-20T15:30:00Z', '2026-11-20T16:15:00Z')),
    );
    expect(code).toBe('23P01');
  });

  it('allows adjacent half-open ranges', async () => {
    const res = await fixture();
    await db.insert(bookings).values(booking(res.id, res.businessId, '2026-11-20T15:00:00Z', '2026-11-20T15:45:00Z'));
    await db
      .insert(bookings)
      .values(booking(res.id, res.businessId, '2026-11-20T15:45:00Z', '2026-11-20T16:30:00Z', 'confirmed'));
    expect(await db.select().from(bookings)).toHaveLength(2);
  });

  it('frees the slot once a booking expires', async () => {
    const res = await fixture();
    await db
      .insert(bookings)
      .values(booking(res.id, res.businessId, '2026-11-20T15:00:00Z', '2026-11-20T15:45:00Z', 'expired'));
    await db.insert(bookings).values(booking(res.id, res.businessId, '2026-11-20T15:00:00Z', '2026-11-20T15:45:00Z'));
    expect(await db.select().from(bookings)).toHaveLength(2);
  });

  it('allows the same range on another resource', async () => {
    const res = await fixture();
    const [other] = await db
      .insert(resources)
      .values({ businessId: res.businessId, name: 'Consultorio 2' })
      .returning();
    await db.insert(bookings).values(booking(res.id, res.businessId, '2026-11-20T15:00:00Z', '2026-11-20T15:45:00Z'));
    await db
      .insert(bookings)
      .values(booking(other!.id, res.businessId, '2026-11-20T15:00:00Z', '2026-11-20T15:45:00Z'));
    expect(await db.select().from(bookings)).toHaveLength(2);
  });

  it('round-trips the range and numbers bookings from the sequence', async () => {
    const res = await fixture();
    const [row] = await db
      .insert(bookings)
      .values(booking(res.id, res.businessId, '2026-11-20T15:00:00Z', '2026-11-20T15:45:00Z'))
      .returning();
    expect(row?.during.start.toISOString()).toBe('2026-11-20T15:00:00.000Z');
    expect(row?.during.end.toISOString()).toBe('2026-11-20T15:45:00.000Z');
    expect(row?.number).toBe(1);
  });
});

describe('one holding booking per phone', () => {
  it('rejects a second holding booking for the same phone hash with 23505', async () => {
    const res = await fixture();
    const first = booking(res.id, res.businessId, '2026-11-20T15:00:00Z', '2026-11-20T15:45:00Z');
    await db.insert(bookings).values({ ...first, phoneHash: 'same-phone' });
    const second = booking(res.id, res.businessId, '2026-11-20T17:00:00Z', '2026-11-20T17:45:00Z');

    expect(await pgCode(db.insert(bookings).values({ ...second, phoneHash: 'same-phone' }))).toBe('23505');
  });

  it('allows a new hold once the phone has no holding booking', async () => {
    const res = await fixture();
    for (const status of ['expired', 'confirmed', 'canceled', 'holding']) {
      const row = booking(res.id, res.businessId, `2026-11-2${counter % 10}T15:00:00Z`, `2026-11-2${counter % 10}T15:45:00Z`, status);
      await db.insert(bookings).values({ ...row, phoneHash: 'same-phone' });
    }
    expect(await db.select().from(bookings)).toHaveLength(4);
  });
});

describe('constraints', () => {
  it('rejects unknown booking statuses', async () => {
    const res = await fixture();
    const code = await pgCode(
      db.insert(bookings).values(booking(res.id, res.businessId, '2026-11-20T15:00:00Z', '2026-11-20T15:45:00Z', 'weird')),
    );
    expect(code).toBe('23514');
  });

  it('rejects unknown flag kinds and accepts the known ones', async () => {
    expect(await pgCode(db.insert(flags).values({ kind: 'nope', payload: {} }))).toBe('23514');
    for (const kind of ['unmatched_payment', 'refund_due', 'amount_mismatch']) {
      await db.insert(flags).values({ kind, payload: {} });
    }
  });

  it('keeps provider_tx_id and webhook_id unique', async () => {
    const event = { providerTxId: 'tx1', amountMinor: 1, raw: {} };
    await db.insert(paymentEvents).values(event);
    expect(await pgCode(db.insert(paymentEvents).values(event))).toBe('23505');
    const hook = { webhookId: 'wh1', eventType: 'payment.received' };
    await db.insert(webhookInbox).values(hook);
    expect(await pgCode(db.insert(webhookInbox).values(hook))).toBe('23505');
  });

  it('rejects zero-amount payment intents but accepts positive ones', async () => {
    const intent = { reference: 'ref-0', amountMinor: 0 };
    expect(await pgCode(db.insert(paymentIntents).values(intent))).toBe('23514');
    await db.insert(paymentIntents).values({ reference: 'ref-1', amountMinor: 1 });
  });

  it('rejects empty booking ranges', async () => {
    const res = await fixture();
    const code = await pgCode(
      db.insert(bookings).values(booking(res.id, res.businessId, '2026-11-20T15:00:00Z', '2026-11-20T15:00:00Z')),
    );
    expect(code).toBe('23514');
  });

  it('rejects a range whose lower bound differs from slot_start', async () => {
    const res = await fixture();
    const row = booking(res.id, res.businessId, '2026-11-20T15:00:00Z', '2026-11-20T15:45:00Z');
    const code = await pgCode(
      db.insert(bookings).values({ ...row, slotStart: new Date('2026-11-20T15:15:00Z') }),
    );
    expect(code).toBe('23514');
  });

  it('caps booking numbers at 7 digits', async () => {
    const [{ max }] = (await db.execute(
      sql`select max_value as max from pg_sequences where sequencename = 'booking_number_seq'`,
    )) as unknown as [{ max: string }];
    expect(max).toBe('9999999');
  });
});

describe('seed', () => {
  it('is idempotent', async () => {
    await seedDemo(db);
    await seedDemo(db);
    const rows = await db.select().from(business).where(eq(business.name, DEMO_BUSINESS_NAME));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ serviceName: 'Consulta', serviceMinutes: 45, depositMinor: 1 });
    expect(await db.select().from(resources)).toHaveLength(1);
  });
});
