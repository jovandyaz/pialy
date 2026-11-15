import { randomBytes } from 'node:crypto';
import { get, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDrizzleBookingPaymentStore } from '../src/infrastructure/booking/drizzle-booking-repository.js';
import { bookings, outbox, paymentIntents, resources } from '../src/infrastructure/db/schema.js';
import { seedDemo } from '../src/infrastructure/db/seed.js';
import { BOARD_TOPIC, bookingTopic, createDrizzleOutboxStore } from '../src/infrastructure/outbox.js';
import { RELAY_BATCH, createOutboxRelay } from '../src/modules/realtime/outbox-relay.js';
import { HEARTBEAT_MS, createSseHub, type SseHub, type SseStream } from '../src/modules/realtime/sse-hub.js';
import { cleanDb, openTestDb, testDeps } from './support.js';

const handle = openTestDb();
const { db } = handle;
afterAll(() => handle.close());
beforeEach(() => cleanDb(handle));

interface FakeStream extends SseStream {
  readonly writes: string[];
  readonly opened: () => number;
  readonly closed: () => number;
}

function fakeStream(): FakeStream {
  const writes: string[] = [];
  let opened = 0;
  let closed = 0;
  return {
    writes,
    opened: () => opened,
    closed: () => closed,
    open: () => void (opened += 1),
    write: (chunk) => void writes.push(chunk),
    close: () => void (closed += 1),
  };
}

function subscribed(hub: SseHub, topic: string, stream: SseStream = fakeStream()): () => void {
  const result = hub.subscribe(topic, stream);
  if (!result.ok) throw new Error(`subscription refused: ${result.reason}`);
  return result.unsubscribe;
}

async function holdingBooking(): Promise<{ id: string; token: string }> {
  await seedDemo(db);
  const [resource] = await db.select().from(resources);
  if (!resource) throw new Error('no resource');
  const [intent] = await db
    .insert(paymentIntents)
    .values({ reference: `R-${randomBytes(4).toString('hex')}`, amountMinor: 1, status: 'processing' })
    .returning();
  const token = randomBytes(16).toString('base64url');
  const slotStart = new Date('2026-11-20T15:00:00Z');
  const [booking] = await db
    .insert(bookings)
    .values({
      token,
      businessId: resource.businessId,
      resourceId: resource.id,
      intentId: intent!.id,
      slotStart,
      during: { start: slotStart, end: new Date('2026-11-20T15:45:00Z') },
      status: 'holding',
      phoneLast4: '5678',
      phoneHash: 'phone-hash-must-never-leave',
      holdExpiresAt: new Date('2026-11-14T18:06:00Z'),
    })
    .returning();
  return { id: booking!.id, token };
}

describe('SseHub', () => {
  afterEach(() => vi.useRealTimers());

  it('opens the stream, sets the reconnect delay and sends each topic only its own messages', () => {
    const hub = createSseHub();
    const mine = fakeStream();
    const other = fakeStream();
    subscribed(hub, 'booking:a', mine);
    subscribed(hub, 'booking:b', other);

    hub.publish('booking:a', { type: 'booking.updated', status: 'confirmed' });

    expect(mine.opened()).toBe(1);
    expect(mine.writes).toEqual(['retry: 2000\n\n', 'data: {"type":"booking.updated","status":"confirmed"}\n\n']);
    expect(other.writes).toEqual(['retry: 2000\n\n']);
  });

  it('stops writing to a stream once it unsubscribes', () => {
    const hub = createSseHub();
    const stream = fakeStream();
    const unsubscribe = subscribed(hub, 'booking:a', stream);

    unsubscribe();
    unsubscribe();
    hub.publish('booking:a', { type: 'x' });

    expect(stream.writes).toEqual(['retry: 2000\n\n']);
    expect(hub.subscriberCount()).toBe(0);
  });

  it('refuses a subscriber past the per-topic and the total caps without opening its stream', () => {
    const hub = createSseHub({ maxPerTopic: 2, maxTotal: 3 });
    subscribed(hub, 'booking:a');
    subscribed(hub, 'booking:a');
    const refused = fakeStream();

    expect(hub.subscribe('booking:a', refused)).toEqual({ ok: false, reason: 'topic_full' });
    subscribed(hub, 'booking:b');
    expect(hub.subscribe('booking:c', refused)).toEqual({ ok: false, reason: 'hub_full' });
    expect(refused.opened()).toBe(0);
    expect(hub.subscriberCount('booking:a')).toBe(2);
    expect(hub.subscriberCount()).toBe(3);
  });

  it('defaults to 20 subscribers per topic and 500 in total', () => {
    const hub = createSseHub();
    for (let i = 0; i < 20; i += 1) subscribed(hub, 'booking:a');
    expect(hub.subscribe('booking:a', fakeStream())).toEqual({ ok: false, reason: 'topic_full' });
    for (let i = 0; i < 480; i += 1) subscribed(hub, `booking:${i}`);
    expect(hub.subscribe('booking:z', fakeStream())).toEqual({ ok: false, reason: 'hub_full' });
  });

  it('sends a heartbeat comment every 20 s while anyone listens, and no timer once nobody does', () => {
    vi.useFakeTimers();
    const hub = createSseHub();
    const stream = fakeStream();
    const unsubscribe = subscribed(hub, 'booking:a', stream);

    vi.advanceTimersByTime(HEARTBEAT_MS);

    expect(HEARTBEAT_MS).toBe(20_000);
    expect(stream.writes).toEqual(['retry: 2000\n\n', ': ping\n\n']);
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends every stream on close and refuses new subscribers afterwards', () => {
    vi.useFakeTimers();
    const hub = createSseHub();
    const stream = fakeStream();
    subscribed(hub, 'booking:a', stream);

    hub.closeAll();

    expect(stream.closed()).toBe(1);
    expect(hub.subscriberCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(hub.subscribe('booking:a', fakeStream())).toEqual({ ok: false, reason: 'closing' });
  });

  it('drops a stream whose write throws and keeps serving the others', () => {
    const hub = createSseHub();
    const broken: SseStream = { open: () => undefined, write: () => undefined, close: () => undefined };
    subscribed(hub, 'booking:a', broken);
    const healthy = fakeStream();
    subscribed(hub, 'booking:a', healthy);
    broken.write = () => {
      throw new Error('socket gone');
    };

    hub.publish('booking:a', { type: 'x' });

    expect(healthy.writes).toContain('data: {"type":"x"}\n\n');
    expect(hub.subscriberCount('booking:a')).toBe(1);
  });
});

describe('outbox relay', () => {
  function relayInto(hub: SseHub) {
    return createOutboxRelay(createDrizzleOutboxStore(db), hub);
  }

  it('publishes unpublished messages in insert order, marks them published and never sends them again', async () => {
    const hub = createSseHub();
    const stream = fakeStream();
    subscribed(hub, 'booking:a', stream);
    const later = new Date('2026-11-14T18:00:00Z');
    const earlier = new Date('2026-11-14T17:00:00Z');
    await db.insert(outbox).values({ topic: 'booking:a', payload: { type: 'first' }, createdAt: later });
    await db.insert(outbox).values({ topic: 'booking:a', payload: { type: 'second' }, createdAt: earlier });

    expect(await relayInto(hub).drainOnce()).toBe(2);
    expect(await relayInto(hub).drainOnce()).toBe(0);

    expect(stream.writes.slice(1)).toEqual(['data: {"type":"first"}\n\n', 'data: {"type":"second"}\n\n']);
    expect(await db.select().from(outbox).where(isNotNull(outbox.publishedAt))).toHaveLength(2);
  });

  it(`relays at most ${RELAY_BATCH} messages per drain`, async () => {
    await db.insert(outbox).values(
      Array.from({ length: RELAY_BATCH + 1 }, (_, i) => ({ topic: BOARD_TOPIC, payload: { type: `m${i}` } })),
    );
    const relay = relayInto(createSseHub());

    expect(await relay.drainOnce()).toBe(RELAY_BATCH);
    expect(await relay.drainOnce()).toBe(1);
  });

  it('sends only the event type and the new status: no token, phone hash or payment data', async () => {
    const hub = createSseHub();
    const stream = fakeStream();
    subscribed(hub, BOARD_TOPIC, stream);
    await db.insert(outbox).values({
      topic: BOARD_TOPIC,
      payload: { type: 'booking.updated', token: 'tok', status: 'confirmed', late: true, phoneHash: 'h', clabe: '0121' },
    });

    await relayInto(hub).drainOnce();

    expect(stream.writes.slice(1)).toEqual(['data: {"type":"booking.updated","status":"confirmed"}\n\n']);
  });
});

interface EventStream {
  readonly response: IncomingMessage;
  next(): Promise<string>;
  readonly ended: Promise<void>;
  close(): void;
}

function openEventStream(url: string): Promise<EventStream> {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      response.setEncoding('utf8');
      let buffer = '';
      const blocks: string[] = [];
      const waiting: ((block: string) => void)[] = [];
      response.on('data', (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const waiter = waiting.shift();
          if (waiter) waiter(block);
          else blocks.push(block);
        }
      });
      const ended = new Promise<void>((done) => response.on('close', done));
      resolve({
        response,
        next: () => {
          const block = blocks.shift();
          return block === undefined ? new Promise((done) => waiting.push(done)) : Promise.resolve(block);
        },
        ended,
        close: () => request.destroy(),
      });
    });
    request.on('error', reject);
  });
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 10_000; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition never held');
}

describe('GET /api/bookings/:token/events', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function listening(hub: SseHub): Promise<string> {
    app = buildApp(testDeps(handle, { hub }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it('streams the booking topic: event-stream headers, reconnect delay, then events only after they commit', async () => {
    const booking = await holdingBooking();
    const hub = createSseHub();
    const relay = createOutboxRelay(createDrizzleOutboxStore(db), hub);
    const base = await listening(hub);

    const stream = await openEventStream(`${base}/api/bookings/${booking.token}/events`);

    expect(stream.response.statusCode).toBe(200);
    expect(stream.response.headers).toMatchObject({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });
    expect(await stream.next()).toBe('retry: 2000');

    await db.transaction(async (tx) => {
      await createDrizzleBookingPaymentStore(tx).confirm(booking.id, new Date('2026-11-14T18:03:00Z'), false);
      expect(await relay.drainOnce()).toBe(0);
      hub.publish(bookingTopic(booking.token), { type: 'marker' });
    });
    expect(await stream.next()).toBe('data: {"type":"marker"}');

    expect(await relay.drainOnce()).toBe(2);
    expect(await stream.next()).toBe('data: {"type":"booking.updated","status":"confirmed"}');
  });

  it('unsubscribes when the client goes away', async () => {
    const booking = await holdingBooking();
    const hub = createSseHub();
    const base = await listening(hub);
    const stream = await openEventStream(`${base}/api/bookings/${booking.token}/events`);
    await stream.next();
    expect(hub.subscriberCount(bookingTopic(booking.token))).toBe(1);

    stream.close();

    await until(() => hub.subscriberCount() === 0);
  });

  it('ends open streams when the server shuts down', async () => {
    const booking = await holdingBooking();
    const hub = createSseHub();
    const base = await listening(hub);
    const stream = await openEventStream(`${base}/api/bookings/${booking.token}/events`);
    await stream.next();

    await app?.close();
    app = undefined;

    await stream.ended;
    expect(hub.subscriberCount()).toBe(0);
  });

  it.each([
    ['an unknown token', 'AAAAAAAAAAAAAAAAAAAAAA'],
    ['a malformed token', 'not!a!token'],
  ])('answers 404 for %s', async (_case, token) => {
    app = buildApp(testDeps(handle, { hub: createSseHub() }));

    const res = await app.inject({ method: 'GET', url: `/api/bookings/${token}/events` });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it.each([
    ['the booking already has as many listeners as allowed', { maxPerTopic: 1 }, 'same'],
    ['the server has as many listeners as allowed', { maxTotal: 1 }, 'other'],
  ] as const)('answers 503 when %s', async (_case, limits, which) => {
    const booking = await holdingBooking();
    const hub = createSseHub(limits);
    subscribed(hub, which === 'same' ? bookingTopic(booking.token) : 'booking:someone-else');
    app = buildApp(testDeps(handle, { hub }));

    const res = await app.inject({ method: 'GET', url: `/api/bookings/${booking.token}/events` });

    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 503, type: 'urn:pialy:problem:live-updates-busy' });
  });
});
