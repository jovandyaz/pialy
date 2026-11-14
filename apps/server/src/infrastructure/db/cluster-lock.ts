import type { Sql } from 'postgres';

export type LockedRun<T> = { readonly acquired: true; readonly value: T } | { readonly acquired: false };

/** Runs work on at most one instance at a time; the others skip instead of waiting. */
export interface ClusterLock {
  tryRun<T>(work: () => Promise<T>): Promise<LockedRun<T>>;
}

/**
 * A session-level advisory lock taken on a connection reserved for the run, so no transaction
 * stays open while `work` waits on the network. Postgres drops the lock with the session if the
 * process dies or the connection breaks; a second run may then overlap, so `work` must be safe
 * to repeat.
 */
export function createAdvisoryClusterLock(client: Sql, key: number): ClusterLock {
  return {
    async tryRun(work) {
      const reserved = await client.reserve();
      try {
        const [row] = await reserved<{ locked: boolean }[]>`select pg_try_advisory_lock(${key}::bigint) as locked`;
        if (row?.locked !== true) return { acquired: false };
        try {
          return { acquired: true, value: await work() };
        } finally {
          // A session lock outlives the run: left on a pooled connection it would block every later sweep.
          await reserved`select pg_advisory_unlock(${key}::bigint)`;
        }
      } finally {
        reserved.release();
      }
    },
  };
}
