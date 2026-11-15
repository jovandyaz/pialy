import { useEffect, useState, useSyncExternalStore } from 'react';

/** The landing's one orchestrated loop: a slot goes free → someone pays (6:00 countdown) → paid. */
export const LOOP_PHASES = ['free', 'held', 'paid'] as const;
export type LoopPhase = (typeof LOOP_PHASES)[number];
export const LOOP_PHASE = { free: 'free', held: 'held', paid: 'paid' } as const satisfies Record<LoopPhase, LoopPhase>;

export interface SlotLoop {
  readonly phase: LoopPhase;
  /** Seconds left on the example hold; starts at the real CoDi request lifetime (360 s). */
  readonly remainingSeconds: number;
  /** Increments every loop, so paid-state animations can restart by key. */
  readonly cycle: number;
}

const TICK_MS = 1000;
const FREE_TICKS = 1;
const HELD_TICKS = 5;
const PAID_TICKS = 3;
const LOOP_TICKS = FREE_TICKS + HELD_TICKS + PAID_TICKS;
export const HOLD_SECONDS = 360;

export const PAID_LOOP: SlotLoop = { phase: LOOP_PHASE.paid, remainingSeconds: HOLD_SECONDS - HELD_TICKS, cycle: 0 };

export function loopStateAt(tick: number): SlotLoop {
  const cycle = Math.floor(tick / LOOP_TICKS);
  const step = tick % LOOP_TICKS;
  if (step < FREE_TICKS) return { phase: LOOP_PHASE.free, remainingSeconds: HOLD_SECONDS, cycle };
  if (step < FREE_TICKS + HELD_TICKS) return { phase: LOOP_PHASE.held, remainingSeconds: HOLD_SECONDS - (step - FREE_TICKS), cycle };
  return { ...PAID_LOOP, cycle };
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(listener: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia(REDUCED_MOTION).matches);
}

/** Ticks once a second; with reduced motion it holds the static paid state and never starts a timer. */
export function useSlotLoop(): SlotLoop {
  const reduced = usePrefersReducedMotion();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (reduced) return undefined;
    const id = window.setInterval(() => setTick((value) => value + 1), TICK_MS);
    return () => window.clearInterval(id);
  }, [reduced]);

  return reduced ? PAID_LOOP : loopStateAt(tick);
}
