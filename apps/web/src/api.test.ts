import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

function hangingFetch() {
  return vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason));
      }),
  );
}

describe('request timeouts', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fails a GET that hangs for 10 s as a network failure, so the next poll can run', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const result = api.booking('tok_hanging').catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(9_999);
    await vi.advanceTimersByTimeAsync(1);

    const error = await result;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0 });
  });

  it('still passes the caller abort through untouched', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const controller = new AbortController();
    const result = api.slots('2026-11-15', controller.signal).catch((error: unknown) => error);

    controller.abort();

    expect(await result).toMatchObject({ name: 'AbortError' });
  });

  it('never times out a POST, whose answer must not be lost', async () => {
    vi.useFakeTimers();
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    void api.hold({ slotStart: '2026-11-15T18:00:00.000Z', phone: '5512345678' }, 'key-0123456789abcdef').catch(() => undefined);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeUndefined();
  });
});
