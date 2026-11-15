import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type VerifyView } from '../api';
import { VerifyPage } from './VerifyPage';

// 10:00 in Mexico City on Friday 20 November 2026.
const NOW = new Date('2026-11-20T16:00:00Z');
const TODAY_SLOT = '2026-11-20T17:00:00.000Z';
const TOMORROW_SLOT = '2026-11-21T17:00:00.000Z';

function pass(overrides: Partial<VerifyView> = {}): VerifyView {
  return {
    token: 'tok_verify_pass_000001',
    status: 'confirmed',
    late: false,
    slotStart: TODAY_SLOT,
    customerName: 'Ana Pérez',
    phoneLast4: '5678',
    bankName: 'BBVA',
    checkedInAt: null,
    ...overrides,
  };
}

describe('VerifyPage pass date', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows the appointment date and lets a pass for today be checked in', async () => {
    vi.spyOn(api, 'verify').mockResolvedValue(pass());
    render(<VerifyPage token="tok_verify_pass_000001" />);
    expect(await screen.findByText(/Vie 20 nov · 11:00/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Marcar que llegó' })).toBeDefined();
  });

  it('does not offer check-in for a pass of another day', async () => {
    vi.spyOn(api, 'verify').mockResolvedValue(pass({ slotStart: TOMORROW_SLOT }));
    render(<VerifyPage token="tok_verify_pass_000001" />);
    expect(await screen.findByText(/Este pase es para el Sábado 21 de noviembre/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Marcar que llegó' })).toBeNull();
  });

  it('dates a use from another day instead of saying today', async () => {
    vi.spyOn(api, 'verify').mockResolvedValue(
      pass({ slotStart: '2026-11-19T17:00:00.000Z', status: 'checked_in', checkedInAt: '2026-11-19T16:55:00.000Z' }),
    );
    render(<VerifyPage token="tok_verify_pass_000001" />);
    expect(await screen.findByText('Llegada registrada el Jue 19 nov a las 10:55.')).toBeDefined();
  });
});
