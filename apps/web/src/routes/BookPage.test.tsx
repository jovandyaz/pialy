import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type SlotItem } from '../api';
import { lastHold, rememberHold } from '../lib/last-hold';
import { nextDays } from '../lib/time';
import { BookPage } from './BookPage';

const NOW = new Date('2026-11-15T23:30:00.000Z'); // 17:30 in Mexico City
const DAYS = nextDays(5, NOW);

function slot(day: string, state: SlotItem['state']): SlotItem {
  return { start: `${day}T18:00:00.000Z`, end: `${day}T18:45:00.000Z`, state };
}

function mockSlots(stateByDay: Readonly<Record<string, SlotItem['state']>>) {
  return vi.spyOn(api, 'slots').mockImplementation((date: string) => {
    const state = stateByDay[date];
    return Promise.resolve({ slots: state === undefined ? [] : [slot(date, state)] });
  });
}

const pressedDay = (): string | null =>
  screen
    .getAllByRole('button', { pressed: true })
    .find((button) => button.closest('[aria-label="Día"]') !== null)?.textContent ?? null;

describe('BookPage default day', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('skips ahead to the first day with a free slot when today is full', async () => {
    const [today, tomorrow, third] = DAYS as [string, string, string];
    const spy = mockSlots({ [today]: 'taken', [tomorrow]: 'held', [third]: 'free' });
    render(<BookPage />);
    await screen.findByText('Libre');
    expect(spy.mock.calls.map(([date]) => date)).toEqual([today, tomorrow, third]);
    expect(pressedDay()).toContain(String(Number(third.slice(8))));
  });

  it('stays on today when it has a free slot', async () => {
    const [today] = DAYS as [string];
    const spy = mockSlots({ [today]: 'free' });
    render(<BookPage />);
    await screen.findByText('Libre');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('shows the empty message on the last day when no day has a free slot', async () => {
    mockSlots({});
    render(<BookPage />);
    await screen.findByText(/No quedan horarios este día/);
    expect(api.slots).toHaveBeenCalledTimes(DAYS.length);
  });

  it('does not skip a full day the customer picked', async () => {
    const [today, tomorrow] = DAYS as [string, string];
    mockSlots({ [today]: 'free', [tomorrow]: 'taken' });
    render(<BookPage />);
    await screen.findByText('Libre');
    const dayButtons = screen.getByRole('group', { name: 'Día' }).querySelectorAll('button');
    fireEvent.click(dayButtons[1] as HTMLButtonElement);
    await screen.findByText('Ocupado');
    await waitFor(() => expect(pressedDay()).toContain(String(Number(tomorrow.slice(8)))));
  });
});

describe('BookPage hold already in progress', () => {
  const ACTIVE_HOLD = new ApiError(409, 'Ya tienes un apartado en curso', {
    type: 'urn:pialy:problem:active-hold-exists',
    status: 409,
    detail: 'Ya tienes un apartado en curso',
  });

  beforeEach(() => {
    // jsdom has <dialog> but not its show(); the hold sheet opens with it.
    HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/estudio-demo');
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function submitHold(): Promise<void> {
    const [today] = DAYS as [string];
    mockSlots({ [today]: 'free' });
    render(<BookPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Libre/ }));
    fireEvent.change(screen.getByLabelText(/Tu celular/), { target: { value: '5512345678' } });
    fireEvent.click(screen.getByRole('button', { name: /Enviar solicitud/ }));
  }

  it('links back to the hold this tab made when the phone already has one', async () => {
    rememberHold('tok_previous_hold_0001');
    vi.spyOn(api, 'hold').mockRejectedValue(ACTIVE_HOLD);

    await submitHold();
    fireEvent.click(await screen.findByRole('button', { name: 'Ver mi apartado' }));

    expect(window.location.pathname).toBe('/c/tok_previous_hold_0001');
  });

  it('shows only the message when this tab made no hold', async () => {
    vi.spyOn(api, 'hold').mockRejectedValue(ACTIVE_HOLD);

    await submitHold();

    await screen.findByText('Ya tienes un apartado en curso');
    expect(screen.queryByRole('button', { name: 'Ver mi apartado' })).toBeNull();
  });

  it('remembers the hold it makes', async () => {
    vi.spyOn(api, 'hold').mockResolvedValue({ token: 'tok_new_hold_000001', holdExpiresAt: '2026-11-16T00:06:00.000Z' });

    await submitHold();

    await waitFor(() => expect(window.location.pathname).toBe('/c/tok_new_hold_000001'));
    expect(lastHold()).toBe('tok_new_hold_000001');
  });
});
