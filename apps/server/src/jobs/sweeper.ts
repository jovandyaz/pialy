import {
  AttemptStatus,
  RAIL_FAILURE_GRACE_MS,
  ReconcileOutcome,
  reconcileAttempt,
  type Clock,
  type PaymentFinder,
  type UnitOfWork,
} from '@pialy/payments';
import { and, asc, eq, gt, isNotNull, lte, or } from 'drizzle-orm';
import type { ClusterLock } from '../infrastructure/db/cluster-lock.js';
import type { Db } from '../infrastructure/db/client.js';
import { sanitized } from '../infrastructure/db/errors.js';
import { paymentAttempts } from '../infrastructure/db/schema.js';
import { startRepeating, type Repeating } from './repeat.js';
import { safeError } from './safe-error.js';

export const SWEEP_INTERVAL_MS = 15_000;
/** Advisory lock key that makes the sweep run on one instance of the cluster at a time. */
export const SWEEP_LOCK_KEY = 4242;
export const LATE_WATCH_EVERY_TICKS = 4;
/** Expired attempts are asked about late money this long after their expiry. */
export const LATE_WATCH_WINDOW_MS = 30 * 60_000;
/** Attempts per kind per sweep; each may cost a rail call of up to ~25 s when pey is down. */
const SWEEP_BATCH = 50;

export interface SweepLogger {
  info(context: object, message: string): void;
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

export interface SweepDeps {
  readonly db: Db;
  readonly lock: ClusterLock;
  readonly uow: UnitOfWork;
  readonly rail: PaymentFinder;
  readonly clock: Clock;
  readonly log: SweepLogger;
}

export interface SweepOptions {
  /** Also re-check attempts that expired in the last {@link LATE_WATCH_WINDOW_MS}. */
  readonly lateWatch?: boolean;
  /** Ends the sweep between attempts, for shutdown. */
  readonly signal?: AbortSignal;
}

const Check = { Due: 'due', LateWatch: 'late_watch' } as const;
type Check = (typeof Check)[keyof typeof Check];

/**
 * Reconciles every awaiting attempt past its expiry with the rail (paid → applied, unpaid →
 * expired, which frees the slot and the phone) and, on late-watch ticks, recently expired
 * attempts too. Runs only where the cluster lock is free and returns how many attempts it
 * checked. One attempt failing is logged and never stops the others.
 */
export async function runSweep(deps: SweepDeps, options: SweepOptions = {}): Promise<{ checked: number }> {
  const run = await deps.lock.tryRun(() => sweep(deps, options));
  return run.acquired ? run.value : { checked: 0 };
}

/** The first tick after boot includes the watch, so a restart does not leave late money waiting. */
export function isLateWatchTick(tick: number): boolean {
  return tick % LATE_WATCH_EVERY_TICKS === 0;
}

/** Sweeps now and every {@link SWEEP_INTERVAL_MS} after each sweep ends. */
export function startSweeper(deps: SweepDeps, intervalMs = SWEEP_INTERVAL_MS): Repeating {
  let tick = 0;
  return startRepeating(
    'sweeper',
    (signal) => runSweep(deps, { lateWatch: isLateWatchTick(tick++), signal }),
    intervalMs,
    deps.log,
  );
}

async function sweep(deps: SweepDeps, options: SweepOptions): Promise<{ checked: number }> {
  const now = deps.clock.now();
  const checks: (readonly [string, Check])[] = [
    ...(await overdueAttempts(deps.db, now)).map((id) => [id, Check.Due] as const),
    ...(options.lateWatch ? await recentlyExpiredAttempts(deps.db, now) : []).map((id) => [id, Check.LateWatch] as const),
  ];
  let checked = 0;
  for (const [attemptId, check] of checks) {
    if (options.signal?.aborted) break;
    await reconcileOne(deps, attemptId, check);
    checked += 1;
  }
  return { checked };
}

async function reconcileOne(deps: SweepDeps, attemptId: string, check: Check): Promise<void> {
  try {
    const { outcome, railError } = await reconcileAttempt(deps.uow, deps.rail, attemptId, deps.clock);
    if (railError !== null) {
      deps.log.warn({ attemptId, check, outcome, rail: safeError(railError) }, 'reconcile: rail lookup failed');
    } else if (check === Check.Due || outcome === ReconcileOutcome.Paid) {
      deps.log.info({ attemptId, check, outcome }, 'reconcile: attempt settled');
    }
  } catch (error) {
    deps.log.error({ attemptId, check, err: safeError(error) }, 'reconcile failed');
  }
}

function overdueAttempts(db: Db, now: Date): Promise<string[]> {
  return attemptIds(
    db,
    and(eq(paymentAttempts.status, AttemptStatus.Awaiting), lte(paymentAttempts.expiresAt, now)),
  );
}

/**
 * Attempts the rail never got an id for cannot be looked up there. The window adds the rail
 * failure grace so an attempt expired late still gets the full watch after it expired.
 */
function recentlyExpiredAttempts(db: Db, now: Date): Promise<string[]> {
  return attemptIds(
    db,
    and(
      eq(paymentAttempts.status, AttemptStatus.Expired),
      gt(paymentAttempts.expiresAt, new Date(now.getTime() - LATE_WATCH_WINDOW_MS - RAIL_FAILURE_GRACE_MS)),
      or(isNotNull(paymentAttempts.providerTxId), isNotNull(paymentAttempts.providerQrId)),
    ),
  );
}

async function attemptIds(db: Db, where: ReturnType<typeof and>): Promise<string[]> {
  const rows = await sanitized(() =>
    db
      .select({ id: paymentAttempts.id })
      .from(paymentAttempts)
      .where(where)
      .orderBy(asc(paymentAttempts.expiresAt))
      .limit(SWEEP_BATCH),
  );
  return rows.map((row) => row.id);
}
