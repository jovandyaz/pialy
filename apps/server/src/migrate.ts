import { loadEnv } from './config/env.js';
import { runMigrations } from './infrastructure/db/migrate.js';

await runMigrations(loadEnv().DATABASE_URL);
console.log('migrations applied');
