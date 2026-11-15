import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type BookingView } from '../api';
import { bookingWatch, WaitPage } from './WaitPage';

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

describe('WaitPage document title', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('names the pass page instead of keeping the landing title', async () => {
    const paid: BookingView = {
      ...EXPIRED,
      status: 'confirmed',
      attempts: [{ mode: 'push', status: 'succeeded' }],
      pass: { time: EXPIRED.slot.start, phoneLast4: '5678', bankName: 'BBVA' },
    };
    vi.spyOn(api, 'booking').mockResolvedValue(paid);
    document.title = 'Pialy · Citas con anticipo para tu negocio';

    render(<WaitPage token={paid.token} />);

    await waitFor(() => expect(document.title).toBe('Tu pase · Pialy'));
  });

  it('names the released hold', async () => {
    vi.spyOn(api, 'booking').mockResolvedValue(EXPIRED);

    render(<WaitPage token={EXPIRED.token} />);

    await waitFor(() => expect(document.title).toBe('Horario liberado · Pialy'));
  });
});

describe('WaitPage live updates', () => {
  const opened: string[] = [];
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) {
      opened.push(url);
    }
    close(): void {}
  }

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    opened.length = 0;
  });

  it('streams only while the slot is held', () => {
    expect(bookingWatch('holding')).toBe('live');
    expect(bookingWatch('confirmed')).toBe('slow');
    expect(bookingWatch('expired')).toBe('slow');
    expect(bookingWatch('checked_in')).toBe('none');
    expect(bookingWatch('canceled')).toBe('none');
  });

  it('opens the event stream for a hold', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.spyOn(api, 'booking').mockResolvedValue({ ...EXPIRED, status: 'holding', attempts: [{ mode: 'push', status: 'awaiting' }] });

    render(<WaitPage token={EXPIRED.token} />);

    await waitFor(() => expect(opened).toHaveLength(1));
  });

  it('does not hold a stream open for a used pass', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const used: BookingView = {
      ...EXPIRED,
      status: 'checked_in',
      attempts: [{ mode: 'push', status: 'succeeded' }],
      pass: { time: EXPIRED.slot.start, phoneLast4: '5678', bankName: 'BBVA' },
    };
    const booking = vi.spyOn(api, 'booking').mockResolvedValue(used);

    render(<WaitPage token={used.token} />);

    await waitFor(() => expect(booking).toHaveBeenCalled());
    await waitFor(() => expect(document.title).not.toBe(''));
    expect(opened).toHaveLength(0);
  });
});

describe('WaitPage bank guidance', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('says where to look in any bank and until when to authorize', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.spyOn(api, 'booking').mockResolvedValue({
      ...EXPIRED,
      status: 'holding',
      holdExpiresAt: '2099-11-15T18:06:00.000Z',
      attempts: [{ mode: 'push', status: 'awaiting' }],
    });

    render(<WaitPage token={EXPIRED.token} />);

    expect(await screen.findByText('Busca la solicitud de cobro')).toBeDefined();
    expect(screen.getByText(/la sección CoDi, tus notificaciones o el historial de operaciones con QR o CoDi/)).toBeDefined();
    expect(screen.getByText(/^Antes de las 12:06\./)).toBeDefined();
    expect(screen.queryByText(/BBVA/)).toBeNull();
  });
});
