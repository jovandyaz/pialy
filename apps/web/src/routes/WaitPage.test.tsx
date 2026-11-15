import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type BookingView } from '../api';
import { WaitPage } from './WaitPage';

const EXPIRED: BookingView = {
  token: 'tok_expired_booking_01',
  status: 'expired',
  late: false,
  slot: { start: '2026-11-17T17:00:00.000Z', end: '2026-11-17T17:45:00.000Z' },
  holdExpiresAt: '2026-11-15T18:06:00.000Z',
  attempts: [{ mode: 'push', status: 'expired' }],
};

describe('WaitPage released hold', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('tells a customer who paid late that a taken slot is refunded by SPEI', async () => {
    vi.spyOn(api, 'booking').mockResolvedValue(EXPIRED);

    render(<WaitPage token={EXPIRED.token} />);

    expect(await screen.findByText(/si el horario ya se ocupó, el negocio te devuelve el anticipo por SPEI/)).toBeDefined();
  });
});
