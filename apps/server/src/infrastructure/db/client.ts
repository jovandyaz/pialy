import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  readonly db: Db;
  /** The pool under `db`, for work that needs one connection to itself (session advisory locks). */
  readonly client: Sql;
  readonly close: () => Promise<void>;
}

export function createDb(databaseUrl: string): DbHandle {
  const sql = postgres(databaseUrl, { max: 10, onnotice: () => undefined });
  return { db: drizzle(sql, { schema }), client: sql, close: () => sql.end({ timeout: 5 }) };
}
