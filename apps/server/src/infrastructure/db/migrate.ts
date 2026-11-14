import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/** `apps/server/drizzle`, resolved from both `src/infrastructure/db` and `dist`. */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL(import.meta.url.includes('/dist/') ? '../drizzle' : '../../../drizzle', import.meta.url),
);

export async function runMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
