import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PassScanner } from './PassScanner';

vi.mock('../lib/qr-decoder', () => {
  throw new TypeError('Failed to fetch dynamically imported module');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

it('tells the owner to check the connection or type the code when the reader fails to load', async () => {
  const track = { stop: vi.fn() };
  vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: () => Promise.resolve({ getTracks: () => [track] }) },
  });

  render(<PassScanner onPass={() => undefined} onClose={() => undefined} />);

  expect(await screen.findByText('No pudimos cargar el lector. Revisa tu conexión o escribe el código.')).toBeDefined();
  expect(track.stop).toHaveBeenCalled();
});
