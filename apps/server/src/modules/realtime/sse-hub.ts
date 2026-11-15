/** Keeps idle streams alive through proxies; Railway drops a response that sends nothing for 5 minutes. */
export const HEARTBEAT_MS = 20_000;
/** How long a browser's EventSource waits before reconnecting. */
export const RETRY_MS = 2000;

/** One subscriber's response. `open` sends the HTTP headers; `close` must not throw. */
export interface SseStream {
  open(): void;
  write(chunk: string): void;
  close(): void;
}

export interface SseLimits {
  readonly maxPerTopic: number;
  readonly maxTotal: number;
}

export const DEFAULT_SSE_LIMITS: SseLimits = { maxPerTopic: 20, maxTotal: 500 };

export type SubscribeRefusal = 'topic_full' | 'hub_full' | 'closing';

export type SubscribeResult =
  | { readonly ok: true; readonly unsubscribe: () => void }
  | { readonly ok: false; readonly reason: SubscribeRefusal };

/**
 * In-process fan-out of server-sent events by topic (`booking:<token>`, `board`). Data is sent as
 * one `data:` line of JSON; clients treat every event as a hint to refetch.
 */
export interface SseHub {
  /** Opens the stream only when there is room; a refused stream is left untouched. */
  subscribe(topic: string, stream: SseStream): SubscribeResult;
  publish(topic: string, data: unknown): void;
  /** Ends every stream and refuses new ones; an open stream would keep the HTTP server from closing. */
  closeAll(): void;
  subscriberCount(topic?: string): number;
}

const HEARTBEAT = ': ping\n\n';

export function createSseHub(limits: Partial<SseLimits> = {}): SseHub {
  const { maxPerTopic, maxTotal } = { ...DEFAULT_SSE_LIMITS, ...limits };
  const topics = new Map<string, Set<SseStream>>();
  let total = 0;
  let closing = false;
  let heartbeat: NodeJS.Timeout | undefined;

  function remove(topic: string, stream: SseStream): void {
    const streams = topics.get(topic);
    if (streams === undefined || !streams.delete(stream)) return;
    total -= 1;
    if (streams.size === 0) topics.delete(topic);
    if (total === 0) stopHeartbeat();
  }

  /** A stream that cannot be written to is dropped so it cannot stop the others. */
  function send(topic: string, stream: SseStream, chunk: string): void {
    try {
      stream.write(chunk);
    } catch {
      remove(topic, stream);
    }
  }

  function startHeartbeat(): void {
    heartbeat ??= setInterval(() => {
      for (const [topic, streams] of topics) for (const stream of [...streams]) send(topic, stream, HEARTBEAT);
    }, HEARTBEAT_MS);
    heartbeat.unref();
  }

  function stopHeartbeat(): void {
    clearInterval(heartbeat);
    heartbeat = undefined;
  }

  return {
    subscribe(topic, stream) {
      if (closing) return { ok: false, reason: 'closing' };
      const streams = topics.get(topic) ?? new Set<SseStream>();
      if (streams.size >= maxPerTopic) return { ok: false, reason: 'topic_full' };
      if (total >= maxTotal) return { ok: false, reason: 'hub_full' };
      stream.open();
      stream.write(`retry: ${RETRY_MS}\n\n`);
      streams.add(stream);
      topics.set(topic, streams);
      total += 1;
      startHeartbeat();
      return { ok: true, unsubscribe: () => remove(topic, stream) };
    },

    publish(topic, data) {
      const streams = topics.get(topic);
      if (streams === undefined) return;
      const chunk = `data: ${JSON.stringify(data)}\n\n`;
      for (const stream of [...streams]) send(topic, stream, chunk);
    },

    closeAll() {
      closing = true;
      for (const streams of topics.values()) for (const stream of streams) stream.close();
      topics.clear();
      total = 0;
      stopHeartbeat();
    },

    subscriberCount(topic) {
      return topic === undefined ? total : (topics.get(topic)?.size ?? 0);
    },
  };
}
