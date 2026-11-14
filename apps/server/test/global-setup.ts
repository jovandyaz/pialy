import postgres from 'postgres';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import { TEST_DATABASE_URL } from './support.js';

export default async function setup(): Promise<void> {
  const probe = postgres(TEST_DATABASE_URL, { max: 1, connect_timeout: 5 });
  try {
    await probe`select 1`;
  } catch (cause) {
    throw new Error(
      'Test database unreachable. Start it with: docker compose -f docker-compose.test.yml up -d ' +
        '(or set TEST_DATABASE_URL).',
      { cause },
    );
  } finally {
    await probe.end({ timeout: 2 });
  }
  await runMigrations(TEST_DATABASE_URL);
}
