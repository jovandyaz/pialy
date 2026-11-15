import { useEffect, useRef } from 'react';
import { streamEventSchema } from './api';

export const POLL_INTERVAL_MS = 2000;

const POLL_HINT_TYPE = 'poll';

export interface StreamHint {
  readonly type: string;
  readonly status?: string;
}

/** The hint passed for a poll tick, here or by a caller's own slower poll. */
export const POLL_TICK: StreamHint = { type: POLL_HINT_TYPE };

/** True for the hint of a fallback poll tick: callers may skip it while a fetch is in flight. */
export function isPollTick(hint: StreamHint | null | undefined): boolean {
  return hint?.type === POLL_HINT_TYPE;
}

/**
 * Calls `onChange` on every server-sent event, and every 2 s while the stream is down (refused,
 * dropped or reconnecting); `hint` is `{ type: 'poll' }` for a poll tick and `null` for any (re)connect, which closes the
 * race between the first fetch and the first subscription. Callers refetch.
 */
export function useEventStream(url: string | null, onChange: (hint: StreamHint | null) => void): void {
  const callback = useRef(onChange);
  useEffect(() => {
    callback.current = onChange;
  });

  useEffect(() => {
    if (url === null) return undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const startPolling = (): void => {
      poll ??= setInterval(() => callback.current(POLL_TICK), POLL_INTERVAL_MS);
    };
    const stopPolling = (): void => {
      clearInterval(poll);
      poll = undefined;
    };

    if (typeof EventSource === 'undefined') {
      startPolling();
      return stopPolling;
    }

    const source = new EventSource(url, { withCredentials: true });
    source.onopen = () => {
      stopPolling();
      callback.current(null);
    };
    source.onmessage = (message: MessageEvent<string>) => {
      const parsed = streamEventSchema.safeParse(safeJson(message.data));
      callback.current(parsed.success ? stripUndefined(parsed.data) : null);
    };
    source.onerror = () => startPolling();

    return () => {
      source.close();
      stopPolling();
    };
  }, [url]);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stripUndefined(event: { type: string; status?: string | undefined }): StreamHint {
  return event.status === undefined ? { type: event.type } : { type: event.type, status: event.status };
}
