import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * `apps/server/drizzle`. The bundle lives in `apps/server/dist`; the source in
 * `apps/server/src/infrastructure/db`. Keyed on the module's own directory name.
 */
export const MIGRATIONS_FOLDER =
  basename(moduleDir) === 'dist' ? resolve(moduleDir, '../drizzle') : resolve(moduleDir, '../../../drizzle');

export async function runMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
