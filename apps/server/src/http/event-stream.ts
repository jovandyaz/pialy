import type { FastifyReply } from 'fastify';
import type { SseHub, SseStream } from '../modules/realtime/sse-hub.js';
import { sendProblem } from './problem.js';

const HTTP_OK = 200;
const HTTP_SERVICE_UNAVAILABLE = 503;
const BUSY_TYPE = 'urn:pialy:problem:live-updates-busy';
const BUSY_DETAIL = 'Demasiadas conexiones en vivo. La página se actualizará sola.';
/** `x-accel-buffering: no` keeps nginx-style proxies from holding events back. */
const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  'x-accel-buffering': 'no',
} as const;

/**
 * Turns the reply into a server-sent event stream of `topic` until the client leaves or the server
 * closes, or answers a 503 problem when the hub has no room. Return its result from the handler.
 */
export function openEventStream(hub: SseHub, topic: string, reply: FastifyReply): FastifyReply {
  const subscription = hub.subscribe(topic, replyStream(reply));
  if (!subscription.ok) return sendProblem(reply, HTTP_SERVICE_UNAVAILABLE, BUSY_DETAIL, BUSY_TYPE);
  reply.raw.on('close', subscription.unsubscribe);
  // A client that left during an earlier await already fired 'close', before the listener existed.
  if (reply.raw.destroyed) subscription.unsubscribe();
  return reply;
}

/** Takes the response away from Fastify, keeping the headers its hooks (helmet) already set. */
function replyStream(reply: FastifyReply): SseStream {
  const raw = reply.raw;
  return {
    open() {
      reply.hijack();
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) raw.setHeader(name, value);
      }
      raw.writeHead(HTTP_OK, SSE_HEADERS);
    },
    write(chunk) {
      raw.write(chunk);
    },
    close() {
      if (!raw.writableEnded) raw.end();
    },
  };
}
