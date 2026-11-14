import type { RailConnector } from '@pialy/payments';
import { sql } from 'drizzle-orm';
import { loadEnv } from '../src/config/env.js';
import type { AppDeps } from '../src/app.js';
import { createDb, type DbHandle } from '../src/infrastructure/db/client.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/pialy_test';

export function openTestDb(): DbHandle {
  return createDb(TEST_DATABASE_URL);
}

/** Empties every table; the booking-number sequence restarts too. */
export async function cleanDb(handle: DbHandle): Promise<void> {
  await handle.db.execute(sql`
    TRUNCATE business, resources, payment_intents, bookings, payment_attempts, payment_events,
      webhook_inbox, idempotency_keys, outbox, flags RESTART IDENTITY CASCADE`);
  await handle.db.execute(sql`ALTER SEQUENCE booking_number_seq RESTART WITH 1`);
}

export const fakeConnector: RailConnector = {
  id: 'fake',
  createPushCharge: () => Promise.reject(new Error('not used')),
  createQrCharge: () => Promise.reject(new Error('not used')),
  findPayments: () => Promise.resolve([]),
  parseWebhook: () => {
    throw new Error('not used');
  },
};

export function testDeps(handle: DbHandle, overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    db: handle.db,
    connector: fakeConnector,
    clock: { now: () => new Date('2026-11-14T12:00:00Z') },
    env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: TEST_DATABASE_URL }),
    ...overrides,
  };
}
