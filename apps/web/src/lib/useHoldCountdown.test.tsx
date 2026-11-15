import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatCountdown, useHoldCountdown } from './useHoldCountdown';

const T0 = Date.parse('2026-11-15T17:30:00.000Z');

describe('formatCountdown', () => {
  it('formats minutes and seconds with two digits', () => {
    expect(formatCountdown(312_000)).toBe('05:12');
    expect(formatCountdown(59_000)).toBe('00:59');
    expect(formatCountdown(360_000)).toBe('06:00');
  });

  it('rounds partial seconds up so 00:00 means the hold is over', () => {
    expect(formatCountdown(311_001)).toBe('05:12');
    expect(formatCountdown(1)).toBe('00:01');
  });

  it('never goes below 00:00', () => {
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(-5_000)).toBe('00:00');
  });
});

describe('useHoldCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats the time left until expiresAt', () => {
    const expiresAt = new Date(T0 + 312_000).toISOString();
    const { result } = renderHook(() => useHoldCountdown(expiresAt, Date.now));
    expect(result.current.label).toBe('05:12');
    expect(result.current.expired).toBe(false);
  });

  it('ticks every second', () => {
    const expiresAt = new Date(T0 + 312_000).toISOString();
    const { result } = renderHook(() => useHoldCountdown(expiresAt, Date.now));
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current.label).toBe('05:10');
  });

  it('stops at 00:00 and reports expiry', () => {
    const expiresAt = new Date(T0 + 3_000).toISOString();
    const { result } = renderHook(() => useHoldCountdown(expiresAt, Date.now));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current.label).toBe('00:00');
    expect(result.current.remainingMs).toBe(0);
    expect(result.current.expired).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the injected clock', () => {
    const expiresAt = new Date(T0 + 312_000).toISOString();
    const { result } = renderHook(() => useHoldCountdown(expiresAt, () => T0 + 12_000));
    expect(result.current.label).toBe('05:00');
  });

  it('shows 00:00 without a timer when there is no expiry', () => {
    const { result } = renderHook(() => useHoldCountdown(null, Date.now));
    expect(result.current.label).toBe('00:00');
    expect(result.current.expired).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restarts when expiresAt moves later (QR extends the hold)', () => {
    const first = new Date(T0 + 3_000).toISOString();
    const { result, rerender } = renderHook(({ at }) => useHoldCountdown(at, Date.now), {
      initialProps: { at: first },
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current.expired).toBe(true);
    rerender({ at: new Date(T0 + 365_000).toISOString() });
    expect(result.current.label).toBe('06:00');
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current.label).toBe('05:59');
  });
});
