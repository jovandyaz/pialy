import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Board, type RecentlyPaid } from '../api';
import { POLL_INTERVAL_MS } from '../useEventStream';
import { BoardPage, newlyPaid } from './BoardPage';

const TODAY = '2026-11-14';
const TUESDAY_17_AT_11 = '2026-11-17T17:00:00.000Z';

function paid(token: string, overrides: Partial<RecentlyPaid> = {}): RecentlyPaid {
  return {
    token,
    slotStart: TUESDAY_17_AT_11,
    customerName: null,
    bankName: null,
    confirmedAt: '2026-11-14T18:00:00.000Z',
    ...overrides,
  };
}

function board(recent: RecentlyPaid[]): Board {
  return { date: TODAY, slots: [], flags: [], recent };
}

describe('newlyPaid', () => {
  it('announces nothing on the first load, then each deposit once', () => {
    expect(newlyPaid(null, [paid('a')])).toEqual([]);
    expect(newlyPaid(new Set(['a']), [paid('a'), paid('b')]).map((p) => p.token)).toEqual(['b']);
    expect(newlyPaid(new Set(['a', 'b']), [paid('a'), paid('b')])).toEqual([]);
  });
});

describe('BoardPage payment notice', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-11-14T18:05:00.000Z'));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('announces a deposit for another day that arrives after the first load, naming the day', async () => {
    vi.spyOn(api, 'board')
      .mockResolvedValueOnce(board([paid('before', { customerName: 'Ana' })]))
      .mockResolvedValue(board([paid('before', { customerName: 'Ana' }), paid('new', { customerName: 'Luis' })]));

    render(<BoardPage />);
    await screen.findByRole('list', { name: 'Agenda' });
    expect(screen.queryByText(/Anticipo recibido/)).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS);
      await Promise.resolve();
    });

    expect(await screen.findByText('Anticipo recibido de Luis · cita del mar 17')).toBeDefined();
    expect(screen.queryByText(/de Ana/)).toBeNull();
  });
});
