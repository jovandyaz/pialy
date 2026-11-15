import type { FastifyPluginAsync } from 'fastify';
import { bookingExists } from '../../infrastructure/booking/booking-read-model.js';
import type { Db } from '../../infrastructure/db/client.js';
import { bookingTopic } from '../../infrastructure/outbox.js';
import type { SseHub } from '../../modules/realtime/sse-hub.js';
import { bookingTokenParam } from '../booking-token.js';
import { openEventStream } from '../event-stream.js';
import { sendProblem } from '../problem.js';

export interface EventRoutesOptions {
  readonly db: Db;
  readonly hub: SseHub;
}

const HTTP_NOT_FOUND = 404;

/**
 * Live updates for a booking's page. An event carries only its type and the booking's new status;
 * the page refetches on each one, and polls when the stream is refused or drops.
 */
export const eventRoutes: FastifyPluginAsync<EventRoutesOptions> = async (app, { db, hub }) => {
  app.get('/api/bookings/:token/events', async (request, reply) => {
    const token = bookingTokenParam(request.params);
    if (token === null || !(await bookingExists(db, token))) return sendProblem(reply, HTTP_NOT_FOUND);
    return openEventStream(hub, bookingTopic(token), reply);
  });
};
