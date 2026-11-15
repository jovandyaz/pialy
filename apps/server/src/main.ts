import { createPeyConnector } from '@pialy/connector-pey';
import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createDb } from './infrastructure/db/client.js';
import { createAdvisoryClusterLock } from './infrastructure/db/cluster-lock.js';
import { createDrizzleOutboxStore } from './infrastructure/outbox.js';
import { createDrizzleUnitOfWork } from './infrastructure/payments/drizzle-unit-of-work.js';
import { paymentReaction } from './infrastructure/payments/payment-reaction.js';
import { startRepeating, type Repeating } from './jobs/repeat.js';
import { SWEEP_LOCK_KEY, startSweeper } from './jobs/sweeper.js';
import { RELAY_INTERVAL_MS, createOutboxRelay } from './modules/realtime/outbox-relay.js';
import { createSseHub } from './modules/realtime/sse-hub.js';

const env = loadEnv();
const { PEY_API_KEY, PEY_BASE_URL, PEY_WEBHOOK_SECRET, PHONE_HASH_SALT } = env;
if (!PEY_API_KEY || !PEY_BASE_URL || !PEY_WEBHOOK_SECRET || !PHONE_HASH_SALT) {
  console.error('PEY_API_KEY, PEY_BASE_URL, PEY_WEBHOOK_SECRET and PHONE_HASH_SALT are required to start the server');
  process.exit(1);
}

const { db, client, close } = createDb(env.DATABASE_URL);
const clock = { now: () => new Date() };
const connector = createPeyConnector({
  apiKey: PEY_API_KEY,
  baseUrl: PEY_BASE_URL,
  webhookSecret: PEY_WEBHOOK_SECRET,
});
const hub = createSseHub();
const app = buildApp({ db, env, clock, connector, hub });
const jobs: Repeating[] = [];

const shutdown = async (): Promise<void> => {
  try {
    await Promise.all(jobs.map((job) => job.stop()));
    await app.close();
    await close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'graceful shutdown failed');
    process.exit(1);
  }
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());

await app.listen({ port: env.PORT, host: '0.0.0.0' });

const relay = createOutboxRelay(createDrizzleOutboxStore(db), hub);
jobs.push(
  startRepeating('outbox relay', () => relay.drainOnce(), RELAY_INTERVAL_MS, app.log),
  startSweeper({
    db,
    lock: createAdvisoryClusterLock(client, SWEEP_LOCK_KEY),
    uow: createDrizzleUnitOfWork(db, paymentReaction),
    rail: connector,
    clock,
    log: app.log.child({ job: 'sweeper' }),
  }),
);
