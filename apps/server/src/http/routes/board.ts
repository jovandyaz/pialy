import type { Clock } from '@pialy/payments';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  createDrizzleBoardReader,
  createDrizzleCheckInStore,
  createDrizzleResolveFlagStore,
} from '../../infrastructure/booking/drizzle-board-repository.js';
import { loadBusiness } from '../../infrastructure/booking/booking-read-model.js';
import type { Db } from '../../infrastructure/db/client.js';
import { BOARD_TOPIC } from '../../infrastructure/outbox.js';
import { checkIn } from '../../modules/booking/application/check-in.js';
import { resolveFlag } from '../../modules/booking/application/resolve-flag.js';
import {
  AlreadyCheckedInError,
  BookingNotConfirmedError,
  BookingNotFoundError,
  FlagNotFoundError,
  PassNotForTodayError,
} from '../../modules/booking/domain/booking.js';
import { InvalidDateError, generateSlots, localDateOf } from '../../modules/booking/domain/slots.js';
import type { SseHub } from '../../modules/realtime/sse-hub.js';
import type { OwnerAuth } from '../auth.js';
import { bookingTokenParam } from '../booking-token.js';
import { openEventStream } from '../event-stream.js';
import { PROBLEM_CONTENT_TYPE, problem, sendProblem } from '../problem.js';

export interface BoardRoutesOptions {
  readonly db: Db;
  readonly clock: Clock;
  readonly hub: SseHub;
  readonly auth: OwnerAuth;
}

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const NOTE_MAX_LENGTH = 500;
const RECENTLY_PAID_MS = 15 * 60_000;
const DATE_FORMAT_DETAIL = 'Indica la fecha como AAAA-MM-DD';
const NOT_CONFIRMED_TYPE = 'urn:pialy:problem:deposit-not-confirmed';
const ALREADY_CHECKED_IN_TYPE = 'urn:pialy:problem:already-checked-in';
const OTHER_DAY_TYPE = 'urn:pialy:problem:pass-other-day';

const boardQuery = z.object({ date: z.string().optional() });
const flagParams = z.object({ id: z.uuid() });
const resolveBody = z.strictObject({ note: z.string().trim().min(1).max(NOTE_MAX_LENGTH) });

/**
 * Owner-only API: the day's board (plus deposits just confirmed for any day), live board events,
 * check-in, flag resolution and the staff verify lookup. Customer data is limited to name, last 4
 * digits and bank name.
 */
export const boardRoutes: FastifyPluginAsync<BoardRoutesOptions> = async (app, { db, clock, hub, auth }) => {
  const reader = createDrizzleBoardReader(db, app.log);
  const checkInStore = createDrizzleCheckInStore(db);
  const flagStore = createDrizzleResolveFlagStore(db);
  const owner = { preHandler: auth.requireOwner };

  app.get('/api/board', owner, async (request, reply) => {
    const query = boardQuery.safeParse(request.query);
    if (!query.success) return sendProblem(reply, HTTP_BAD_REQUEST, DATE_FORMAT_DETAIL);
    const business = await loadBusiness(db);
    const date = query.data.date ?? localDateOf(clock.now(), business.timezone);
    let slots;
    try {
      slots = generateSlots(date, business, business.timezone);
    } catch (error) {
      if (error instanceof InvalidDateError) return sendProblem(reply, HTTP_BAD_REQUEST, DATE_FORMAT_DETAIL);
      throw error;
    }
    const first = slots[0];
    const last = slots.at(-1);
    const day = first === undefined || last === undefined ? [] : await reader.bookingsStartingIn({ start: first.start, end: last.end });
    const byStart = new Map(day.map((booking) => [booking.slotStart.getTime(), booking]));
    return {
      date,
      slots: slots.map(({ start, end }) => ({
        start,
        end,
        booking: byStart.get(start.getTime()) ?? null,
      })),
      flags: await reader.openFlags(),
      recent: await reader.paidSince(new Date(clock.now().getTime() - RECENTLY_PAID_MS)),
    };
  });

  app.get('/api/board/events', owner, (_request, reply) => openEventStream(hub, BOARD_TOPIC, reply));

  app.post('/api/bookings/:token/check-in', owner, async (request, reply) => {
    const token = bookingTokenParam(request.params);
    if (token === null) return sendProblem(reply, HTTP_NOT_FOUND);
    try {
      const business = await loadBusiness(db);
      return { checkedInAt: await checkIn({ store: checkInStore, clock }, token, business.timezone) };
    } catch (error) {
      if (error instanceof BookingNotFoundError) return sendProblem(reply, HTTP_NOT_FOUND, 'No encontramos esa reserva');
      if (error instanceof BookingNotConfirmedError) {
        return sendProblem(reply, HTTP_CONFLICT, 'Anticipo no confirmado', NOT_CONFIRMED_TYPE);
      }
      if (error instanceof AlreadyCheckedInError) return sendAlreadyCheckedIn(reply, error.checkedInAt);
      if (error instanceof PassNotForTodayError) return sendOtherDay(reply, error.slotStart);
      throw error;
    }
  });

  app.post('/api/flags/:id/resolve', owner, async (request, reply) => {
    const params = flagParams.safeParse(request.params);
    if (!params.success) return sendProblem(reply, HTTP_NOT_FOUND);
    const body = resolveBody.safeParse(request.body);
    if (!body.success) return sendProblem(reply, HTTP_BAD_REQUEST, 'Escribe una nota para resolver el aviso');
    try {
      const resolvedAt = await resolveFlag({ store: flagStore, clock }, params.data.id, body.data.note);
      return { id: params.data.id, resolvedAt };
    } catch (error) {
      if (error instanceof FlagNotFoundError) return sendProblem(reply, HTTP_NOT_FOUND, 'Ese aviso no existe o ya se resolvió');
      throw error;
    }
  });

  // Owner-only because it names the customer; the staff page is reached from the signed-in board.
  app.get('/api/verify/:token', owner, async (request, reply) => {
    const token = bookingTokenParam(request.params);
    if (token === null) return sendProblem(reply, HTTP_NOT_FOUND);
    const booking = await reader.findBooking(token);
    if (booking === null) return sendProblem(reply, HTTP_NOT_FOUND, 'No encontramos esa reserva');
    return booking;
  });
};

function sendAlreadyCheckedIn(reply: FastifyReply, checkedInAt: Date): FastifyReply {
  return reply
    .status(HTTP_CONFLICT)
    .header('content-type', PROBLEM_CONTENT_TYPE)
    .send({ ...problem(HTTP_CONFLICT, 'Este pase ya se usó', ALREADY_CHECKED_IN_TYPE), checkedInAt });
}

function sendOtherDay(reply: FastifyReply, slotStart: Date): FastifyReply {
  return reply
    .status(HTTP_CONFLICT)
    .header('content-type', PROBLEM_CONTENT_TYPE)
    .send({ ...problem(HTTP_CONFLICT, 'Este pase es para otro día', OTHER_DAY_TYPE), slotStart });
}
