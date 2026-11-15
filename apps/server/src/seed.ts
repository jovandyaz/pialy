import { loadEnv } from './config/env.js';
import { createDb } from './infrastructure/db/client.js';
import { seedDemo } from './infrastructure/db/seed.js';

const { db, close } = createDb(loadEnv().DATABASE_URL);
try {
  await seedDemo(db);
  console.log('seed applied');
} finally {
  await close();
}
