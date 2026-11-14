import { isIP } from 'node:net';
import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import type { Clock, Money, RailConnector } from '@pialy/payments';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PastDateError, getSlots } from '../../modules/booking/application/get-slots.js';
import {
  IdempotencyKeyInFlightError,
  IdempotencyKeyReusedError,
  holdSlotAndCharge,
} from '../../modules/booking/application/hold-slot.js';
import {
  ActiveHoldExistsError,
  SlotTakenError,
  TooManyHoldsForPhoneError,
} from '../../modules/booking/domain/booking.js';
import { InvalidPhoneError } from '../../modules/booking/domain/phone.js';
import { InvalidDateError, SlotNotOfferedError } from '../../modules/booking/domain/slots.js';
import {
  createDrizzleActiveBookingsReader,
  findBookingView,
  loadBusiness,
} from '../../infrastructure/booking/booking-read-model.js';
import { createDrizzleHoldRepository } from '../../infrastructure/booking/drizzle-booking-repository.js';
import type { Db } from '../../infrastructure/db/client.js';
import { bookingTokenParam } from '../booking-token.js';
import { PROBLEM_CONTENT_TYPE, sendProblem } from '../problem.js';

export interface BookingRoutesOptions {
  readonly db: Db;
  readonly connector: RailConnector;
  readonly clock: Clock;
  /** Fixed server side; no request carries an amount. */
  readonly deposit: Money;
  readonly phoneHashSalt: string;
}

const PHONE_MAX_LENGTH = 32;
const CUSTOMER_NAME_MAX_LENGTH = 80;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,255}$/;
/** Structured-field strings (RFC 9651) arrive quoted. */
const QUOTED = /^"(.*)"$/;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_CREATED = 201;
/** Per client IP (see {@link clientIp}); in memory, so per instance. */
const HOLDS_PER_IP = { max: 10, timeWindow: 10 * 60_000 } as const;
const IP_LIMIT_DETAIL = 'Demasiados intentos. Espera unos minutos.';
const DATE_FORMAT_DETAIL = 'Indica la fecha como AAAA-MM-DD';

const slotsQuery = z.object({ date: z.string() });
const holdBody = z.strictObject({
  slotStart: z.iso.datetime({ offset: true }),
  phone: z.string().max(PHONE_MAX_LENGTH),
  customerName: z.string().trim().max(CUSTOMER_NAME_MAX_LENGTH).optional(),
});

interface DomainProblem {
  readonly status: number;
  readonly type: string;
  readonly detail: string;
}

const problems: readonly (readonly [new (...args: never[]) => Error, DomainProblem])[] = [
  [
    InvalidPhoneError,
    { status: HTTP_UNPROCESSABLE, type: 'urn:pialy:problem:invalid-phone', detail: 'Revisa tu número: deben ser 10 dígitos' },
  ],
  [
    SlotNotOfferedError,
    { status: HTTP_UNPROCESSABLE, type: 'urn:pialy:problem:slot-not-offered', detail: 'Ese horario no está disponible' },
  ],
  [SlotTakenError, { status: HTTP_CONFLICT, type: 'urn:pialy:problem:slot-taken', detail: 'Ese horario se acaba de ocupar' }],
  [
    IdempotencyKeyReusedError,
    {
      status: HTTP_UNPROCESSABLE,
      type: 'urn:pialy:problem:idempotency-key-reused',
      detail: 'Esta Idempotency-Key ya se usó con otra solicitud',
    },
  ],
  [
    IdempotencyKeyInFlightError,
    { status: HTTP_CONFLICT, type: 'urn:pialy:problem:request-in-progress', detail: 'Solicitud en proceso' },
  ],
  [
    TooManyHoldsForPhoneError,
    {
      status: HTTP_TOO_MANY_REQUESTS,
      type: 'urn:pialy:problem:phone-rate-limited',
      detail: 'Demasiados intentos con este número',
    },
  ],
  [
    ActiveHoldExistsError,
    { status: HTTP_CONFLICT, type: 'urn:pialy:problem:active-hold-exists', detail: 'Ya tienes un apartado en curso' },
  ],
];

/** Public booking API. The phone the customer types is never logged or stored, only its last 4 digits and hash. */
export const bookingRoutes: FastifyPluginAsync<BookingRoutesOptions> = async (app, options) => {
  const { db, connector, clock, deposit, phoneHashSalt } = options;
  const holds = createDrizzleHoldRepository(db);
  const activeBookings = createDrizzleActiveBookingsReader(db);
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (request) => normalizeIP(clientIp(request)),
    errorResponseBuilder: (_request, context) => Object.assign(new Error(IP_LIMIT_DETAIL), { statusCode: context.statusCode }),
  });

  app.get('/api/slots', async (request, reply) => {
    const query = slotsQuery.safeParse(request.query);
    if (!query.success) return sendProblem(reply, HTTP_BAD_REQUEST, DATE_FORMAT_DETAIL);
    const business = await loadBusiness(db);
    try {
      const slots = await getSlots({ bookings: activeBookings, clock, business }, query.data.date);
      return { slots: slots.map(({ start, end, state }) => ({ start, end, state })) };
    } catch (error) {
      if (error instanceof InvalidDateError) return sendProblem(reply, HTTP_BAD_REQUEST, DATE_FORMAT_DETAIL);
      if (error instanceof PastDateError) return sendProblem(reply, HTTP_BAD_REQUEST, 'Esa fecha ya pasó');
      throw error;
    }
  });

  app.post('/api/bookings', { config: { rateLimit: HOLDS_PER_IP } }, async (request, reply) => {
    const key = acceptedIdempotencyKey(request.headers['idempotency-key']);
    if (key === null) return sendProblem(reply, HTTP_BAD_REQUEST, 'Envía un encabezado Idempotency-Key con un UUID');
    const body = holdBody.safeParse(request.body);
    if (!body.success) return sendProblem(reply, HTTP_BAD_REQUEST, 'Revisa los datos de la reserva');

    const business = await loadBusiness(db);
    try {
      const response = await holdSlotAndCharge(
        { holds, rail: connector, clock, business, deposit, phoneHashSalt, log: request.log },
        {
          slotStart: new Date(body.data.slotStart),
          phone: body.data.phone,
          customerName: body.data.customerName,
          idempotencyKey: key,
        },
      );
      if (response.status !== HTTP_CREATED) reply.header('content-type', PROBLEM_CONTENT_TYPE);
      return reply.status(response.status).send(response.body);
    } catch (error) {
      return sendDomainProblem(reply, error);
    }
  });

  app.get('/api/bookings/:token', async (request, reply) => {
    const token = bookingTokenParam(request.params);
    if (token === null) return sendProblem(reply, HTTP_NOT_FOUND);
    const view = await findBookingView(db, token);
    if (view === null) return sendProblem(reply, HTTP_NOT_FOUND);
    return view;
  });
};

/**
 * Railway's edge sets `X-Real-IP` to the client's address (docs.railway.com, public networking
 * specs). The left-most `X-Forwarded-For` entry that `request.ip` trusts is client-controlled.
 */
function clientIp(request: FastifyRequest): string {
  const realIp = request.headers['x-real-ip'];
  const candidate = typeof realIp === 'string' ? realIp.trim() : '';
  return isIP(candidate) === 0 ? request.ip : candidate;
}

function acceptedIdempotencyKey(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const key = QUOTED.exec(header)?.[1] ?? header;
  return IDEMPOTENCY_KEY.test(key) ? key : null;
}

function sendDomainProblem(reply: FastifyReply, error: unknown): FastifyReply {
  const match = problems.find(([type]) => error instanceof type);
  if (match === undefined) throw error;
  const [, problem] = match;
  return sendProblem(reply, problem.status, problem.detail, problem.type);
}
