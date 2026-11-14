import { createPeyConnector } from '@pialy/connector-pey';
import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createDb } from './infrastructure/db/client.js';

const env = loadEnv();
const { PEY_API_KEY, PEY_BASE_URL, PEY_WEBHOOK_SECRET } = env;
if (!PEY_API_KEY || !PEY_BASE_URL || !PEY_WEBHOOK_SECRET) {
  console.error('PEY_API_KEY, PEY_BASE_URL and PEY_WEBHOOK_SECRET are required to start the server');
  process.exit(1);
}

const { db, close } = createDb(env.DATABASE_URL);
const app = buildApp({
  db,
  env,
  clock: { now: () => new Date() },
  connector: createPeyConnector({
    apiKey: PEY_API_KEY,
    baseUrl: PEY_BASE_URL,
    webhookSecret: PEY_WEBHOOK_SECRET,
  }),
});

const shutdown = async (): Promise<void> => {
  try {
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
