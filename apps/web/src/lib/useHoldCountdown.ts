import { useEffect, useState } from 'react';

const TICK_MS = 1000;
const SECONDS_PER_MINUTE = 60;

export interface HoldCountdown {
  /** `mm:ss`, never below `00:00`. */
  readonly label: string;
  readonly remainingMs: number;
  readonly expired: boolean;
}

/** `mm:ss` of a duration; partial seconds round up, so `00:00` only once it is over. */
export function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / TICK_MS));
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  return `${pad(minutes)}:${pad(seconds % SECONDS_PER_MINUTE)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function remainingUntil(expiresAt: string | null, now: () => number): number {
  if (expiresAt === null) return 0;
  const end = Date.parse(expiresAt);
  return Number.isNaN(end) ? 0 : Math.max(0, end - now());
}

/** Time left on a hold, from the server's `holdExpiresAt`; ticks each second and stops at zero. */
export function useHoldCountdown(expiresAt: string | null, now: () => number = Date.now): HoldCountdown {
  const [remainingMs, setRemainingMs] = useState(() => remainingUntil(expiresAt, now));

  useEffect(() => {
    const update = (): number => {
      const left = remainingUntil(expiresAt, now);
      setRemainingMs(left);
      return left;
    };
    if (update() === 0) return undefined;
    const timer = setInterval(() => {
      if (update() === 0) clearInterval(timer);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [expiresAt, now]);

  return { label: formatCountdown(remainingMs), remainingMs, expired: remainingMs === 0 };
}
