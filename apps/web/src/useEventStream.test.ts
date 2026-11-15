import { describe, expect, it } from 'vitest';
import { isPollTick } from './useEventStream';

describe('isPollTick', () => {
  it('flags only the fallback poll hint', () => {
    expect(isPollTick({ type: 'poll' })).toBe(true);
    expect(isPollTick(null)).toBe(false);
    expect(isPollTick(undefined)).toBe(false);
    expect(isPollTick({ type: 'booking.confirmed', status: 'confirmed' })).toBe(false);
  });
});
