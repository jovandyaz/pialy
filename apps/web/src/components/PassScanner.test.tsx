import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NotFoundException } from '@zxing/library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOT_A_PASS, PassScanner } from './PassScanner';

type ScanCallback = (result: { getText: () => string } | undefined, error: unknown) => void;

const decoder = vi.hoisted(() => ({
  onFrame: null as ScanCallback | null,
  stop: () => undefined as void,
  started: Promise.resolve(),
}));

vi.mock('@zxing/browser', () => ({
  BrowserQRCodeReader: class {
    async decodeFromStream(_stream: MediaStream, _video: HTMLVideoElement, callback: ScanCallback) {
      await decoder.started;
      decoder.onFrame = callback;
      return { stop: decoder.stop };
    }
  },
}));

const TOKEN = 'Xk3_9fQe-2LmNpRsTuVwYz';
const DENIED = 'Permite el acceso a la cámara para escanear.';
const CAMERA_FAILED = 'No pudimos abrir la cámara. Cierra otras apps que la estén usando y vuelve a intentarlo.';
const FALLBACK_LABEL = '¿No lee el código? Escribe el código del pase';

function fakeStream() {
  const track = { stop: vi.fn() };
  return { track, stream: { getTracks: () => [track] } as unknown as MediaStream };
}

function withCamera(getUserMedia: () => Promise<MediaStream>) {
  vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(getUserMedia) } });
}

function renderScanner() {
  const onPass = vi.fn();
  const view = render(<PassScanner onPass={onPass} onClose={() => undefined} />);
  return { onPass, ...view };
}

function scan(text: string) {
  act(() => decoder.onFrame?.({ getText: () => text }, undefined));
}

function frameError(error: unknown) {
  act(() => decoder.onFrame?.(undefined, error));
}

async function renderScanning() {
  const { stream, track } = fakeStream();
  withCamera(() => Promise.resolve(stream));
  const view = renderScanner();
  await waitFor(() => expect(decoder.onFrame).not.toBeNull());
  return { track, ...view };
}

describe('PassScanner', () => {
  beforeEach(() => {
    decoder.onFrame = null;
    decoder.stop = vi.fn();
    decoder.started = Promise.resolve();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'mediaDevices');
  });

  it('asks for camera permission when it is denied, and keeps the typed fallback', async () => {
    withCamera(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));

    renderScanner();

    expect(await screen.findByText(DENIED)).toBeDefined();
    expect(screen.getByLabelText(FALLBACK_LABEL)).toBeDefined();
  });

  it('says so when the device has no camera', async () => {
    withCamera(() => Promise.reject(new DOMException('none', 'NotFoundError')));

    renderScanner();

    expect(await screen.findByText('No encontramos una cámara en este dispositivo.')).toBeDefined();
  });

  it('explains that the camera needs a secure connection, without asking for it', async () => {
    withCamera(() => Promise.reject(new Error('unreachable')));
    vi.stubGlobal('isSecureContext', false);

    renderScanner();

    expect(await screen.findByText('La cámara solo funciona en una conexión segura (https).')).toBeDefined();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('rejects a scanned code that is not a pass and keeps scanning', async () => {
    const { stream, track } = fakeStream();
    withCamera(() => Promise.resolve(stream));
    const { onPass } = renderScanner();
    await waitFor(() => expect(decoder.onFrame).not.toBeNull());

    scan(`https://evil.example/negocio/verificar/${TOKEN}`);

    expect(screen.getByText(NOT_A_PASS)).toBeDefined();
    expect(onPass).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();
  });

  it('rejects a scanned bare token, which only the typed field accepts', async () => {
    const { stream, track } = fakeStream();
    withCamera(() => Promise.resolve(stream));
    const { onPass } = renderScanner();
    await waitFor(() => expect(decoder.onFrame).not.toBeNull());

    scan(TOKEN);

    expect(screen.getByText(NOT_A_PASS)).toBeDefined();
    expect(onPass).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();
  });

  it('stops the camera and hands over the token of a scanned pass', async () => {
    const { stream, track } = fakeStream();
    withCamera(() => Promise.resolve(stream));
    const { onPass } = renderScanner();
    await waitFor(() => expect(decoder.onFrame).not.toBeNull());

    scan(`${window.location.origin}/negocio/verificar/${TOKEN}`);

    expect(track.stop).toHaveBeenCalled();
    expect(decoder.stop).toHaveBeenCalled();
    expect(onPass).toHaveBeenCalledWith(TOKEN);
  });

  it('stops the camera when the sheet closes', async () => {
    const { stream, track } = fakeStream();
    withCamera(() => Promise.resolve(stream));
    const { unmount } = renderScanner();
    await waitFor(() => expect(decoder.onFrame).not.toBeNull());

    unmount();

    expect(track.stop).toHaveBeenCalled();
    expect(decoder.stop).toHaveBeenCalled();
  });

  it('keeps scanning through frames without a readable code', async () => {
    const { track } = await renderScanning();

    frameError(new NotFoundException());

    expect(screen.queryByRole('alert')).toBeNull();
    expect(track.stop).not.toHaveBeenCalled();
    expect(decoder.stop).not.toHaveBeenCalled();
  });

  it('stops the camera and says so when the scan loop fails', async () => {
    const { track } = await renderScanning();

    frameError(new Error('canvas lost'));

    expect(screen.getByText(CAMERA_FAILED)).toBeDefined();
    expect(track.stop).toHaveBeenCalled();
  });

  it('opens a pass only once, however many times it is read or typed', async () => {
    const { onPass } = await renderScanning();

    scan(`${window.location.origin}/negocio/verificar/${TOKEN}`);
    scan(`${window.location.origin}/negocio/verificar/${TOKEN}`);
    fireEvent.change(screen.getByLabelText(FALLBACK_LABEL), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Verificar pase' }));

    expect(onPass).toHaveBeenCalledTimes(1);
  });

  it('releases a decoder that starts after the sheet already closed', async () => {
    let start: () => void = () => undefined;
    decoder.started = new Promise<void>((resolve) => (start = resolve));
    const { stream, track } = fakeStream();
    withCamera(() => Promise.resolve(stream));
    const { unmount } = renderScanner();
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());

    unmount();
    await act(async () => start());

    expect(decoder.stop).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });

  it('stops a camera that opens after the sheet already closed', async () => {
    const { stream, track } = fakeStream();
    let open: (value: MediaStream) => void = () => undefined;
    withCamera(() => new Promise<MediaStream>((resolve) => (open = resolve)));
    const { unmount } = renderScanner();

    unmount();
    await act(async () => open(stream));

    expect(track.stop).toHaveBeenCalled();
    expect(decoder.onFrame).toBeNull();
  });

  it('opens a typed pass code', async () => {
    withCamera(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    const { onPass } = renderScanner();
    await screen.findByText(DENIED);

    fireEvent.change(screen.getByLabelText(FALLBACK_LABEL), { target: { value: ` ${TOKEN} ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Verificar pase' }));

    expect(onPass).toHaveBeenCalledWith(TOKEN);
  });

  it('rejects a typed code that is not a pass', async () => {
    withCamera(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    const { onPass } = renderScanner();
    await screen.findByText(DENIED);

    const input = screen.getByLabelText(FALLBACK_LABEL);
    fireEvent.change(input, { target: { value: 'hola' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verificar pase' }));

    expect(screen.getByText(NOT_A_PASS)).toBeDefined();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(onPass).not.toHaveBeenCalled();
  });
});
