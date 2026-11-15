import { describe, expect, it } from 'vitest';
import { HOLD_SECONDS, LOOP_PHASE, loopStateAt } from './useSlotLoop';

describe('loopStateAt', () => {
  it('runs free → held (counting down from the 6-minute hold) → paid, then repeats', () => {
    const phases = Array.from({ length: 10 }, (_, tick) => loopStateAt(tick).phase);
    expect(phases).toEqual([
      LOOP_PHASE.free,
      LOOP_PHASE.held,
      LOOP_PHASE.held,
      LOOP_PHASE.held,
      LOOP_PHASE.held,
      LOOP_PHASE.held,
      LOOP_PHASE.paid,
      LOOP_PHASE.paid,
      LOOP_PHASE.paid,
      LOOP_PHASE.free,
    ]);
    expect(loopStateAt(1).remainingSeconds).toBe(HOLD_SECONDS);
    expect(loopStateAt(5).remainingSeconds).toBe(HOLD_SECONDS - 4);
    expect(loopStateAt(9).cycle).toBe(1);
  });
});
