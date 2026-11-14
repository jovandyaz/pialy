import { and, eq } from 'drizzle-orm';
import type { DbTx } from './db/client.js';
import { idempotencyKeys } from './db/schema.js';

/** An HTTP answer as stored on a key and replayed for the same request. */
export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface KeyRef {
  readonly key: string;
  readonly scope: string;
}

export const FINISHED = 'finished';

/**
 * - `claimed`: a new key, locked by the caller;
 * - `mismatch`: the key belongs to a request with another fingerprint;
 * - `finished`: replay `response`;
 * - `in_flight`: another request holds the key;
 * - `abandoned`: the request that held the key died; the caller now holds it and resumes from
 *   `recoveryPoint`, with what that request staged.
 */
export type KeyClaim =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'finished'; readonly response: StoredResponse }
  | { readonly kind: 'in_flight' }
  | { readonly kind: 'abandoned'; readonly recoveryPoint: string | null; readonly staged: unknown };

export interface KeyState {
  readonly recoveryPoint: string | null;
  /** Present once the key is finished. */
  readonly response: StoredResponse | null;
  readonly staged: unknown;
}

/**
 * Inserts the key locked, or reads the existing one under a row lock. A concurrent insert of the
 * same key waits on the primary key until the first transaction ends, so two requests never both
 * claim it.
 */
export async function claimKey(
  tx: DbTx,
  ref: KeyRef,
  requestHash: string,
  now: Date,
  staleBefore: Date,
): Promise<KeyClaim> {
  const inserted = await tx
    .insert(idempotencyKeys)
    .values({ key: ref.key, scope: ref.scope, requestHash, lockedAt: now })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });
  if (inserted.length > 0) return { kind: 'claimed' };

  const row = await lockedRow(tx, ref);
  if (row.requestHash !== requestHash) return { kind: 'mismatch' };
  if (row.recoveryPoint === FINISHED) return { kind: 'finished', response: finishedResponse(row) };
  if (row.lockedAt !== null && row.lockedAt > staleBefore) return { kind: 'in_flight' };
  await tx.update(idempotencyKeys).set({ lockedAt: now }).where(matching(ref));
  return { kind: 'abandoned', recoveryPoint: row.recoveryPoint, staged: row.responseBody };
}

/** Commits progress with the transaction that made it; `staged` is what a recovery needs. */
export async function reachRecoveryPoint(tx: DbTx, ref: KeyRef, recoveryPoint: string, staged: unknown): Promise<void> {
  await tx.update(idempotencyKeys).set({ recoveryPoint, responseBody: staged }).where(matching(ref));
}

/** Locks the key for a phase that follows a foreign call. */
export async function lockKey(tx: DbTx, ref: KeyRef): Promise<KeyState> {
  const row = await lockedRow(tx, ref);
  return {
    recoveryPoint: row.recoveryPoint,
    response: row.recoveryPoint === FINISHED ? finishedResponse(row) : null,
    staged: row.responseBody,
  };
}

/** Stores the final answer and releases the key. */
export async function finishKey(tx: DbTx, ref: KeyRef, response: StoredResponse): Promise<void> {
  await tx
    .update(idempotencyKeys)
    .set({ recoveryPoint: FINISHED, responseCode: response.status, responseBody: response.body, lockedAt: null })
    .where(matching(ref));
}

type KeyRow = typeof idempotencyKeys.$inferSelect;

async function lockedRow(tx: DbTx, ref: KeyRef): Promise<KeyRow> {
  const [row] = await tx.select().from(idempotencyKeys).where(matching(ref)).for('update');
  if (row === undefined) throw new Error(`idempotency key vanished in scope ${ref.scope}`);
  return row;
}

function finishedResponse(row: KeyRow): StoredResponse {
  if (row.responseCode === null) throw new Error(`finished idempotency key in scope ${row.scope} has no response`);
  return { status: row.responseCode, body: row.responseBody };
}

function matching(ref: KeyRef) {
  return and(eq(idempotencyKeys.key, ref.key), eq(idempotencyKeys.scope, ref.scope));
}
