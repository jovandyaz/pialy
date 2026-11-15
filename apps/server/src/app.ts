import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { money, type Clock, type RailConnector } from '@pialy/payments';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import { createOwnerAuth } from './http/auth.js';
import { problemErrorHandler, problemNotFoundHandler } from './http/problem.js';
import { boardRoutes } from './http/routes/board.js';
import { bookingRoutes } from './http/routes/bookings.js';
import { eventRoutes } from './http/routes/events.js';
import { webhookRoutes } from './http/routes/webhooks.js';
import type { Db } from './infrastructure/db/client.js';
import { createDrizzleUnitOfWork } from './infrastructure/payments/drizzle-unit-of-work.js';
import { paymentReaction } from './infrastructure/payments/payment-reaction.js';
import type { SseHub } from './modules/realtime/sse-hub.js';

export interface AppDeps {
  readonly db: Db;
  readonly connector: RailConnector;
  readonly clock: Clock;
  readonly env: Env;
  /** Live-update streams; the outbox relay started next to the app publishes into it. */
  readonly hub: SseHub;
  /** Log destination; defaults to stdout. Tests pass a capturing stream. */
  readonly logStream?: NodeJS.WritableStream;
}

export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["webhook-signature"]',
  'headers.authorization',
  'headers["webhook-signature"]',
  'phone',
  'phoneNumber',
  'pin',
  '*.pin',
  'req.headers.cookie',
  'headers.cookie',
  'BUSINESS_PIN',
  'COOKIE_SECRET',
  '*.BUSINESS_PIN',
  '*.COOKIE_SECRET',
  '*.phone',
  '*.phoneNumber',
  'PEY_API_KEY',
  'PEY_WEBHOOK_SECRET',
  '*.PEY_API_KEY',
  '*.PEY_WEBHOOK_SECRET',
] as const;

export function buildApp(deps: AppDeps): FastifyInstance {
  const phoneHashSalt = deps.env.PHONE_HASH_SALT;
  if (phoneHashSalt === undefined) throw new Error('PHONE_HASH_SALT is required to hash customer phones');
  const { BUSINESS_PIN: pin, COOKIE_SECRET: cookieSecret } = deps.env;
  if (pin === undefined) throw new Error('BUSINESS_PIN is required for the owner session');
  if (cookieSecret === undefined) throw new Error('COOKIE_SECRET is required to sign the owner cookie');
  const app = Fastify({
    trustProxy: true, // behind Railway's proxy: real client IP for rate limits
    logger:
      deps.env.NODE_ENV === 'test' && deps.logStream === undefined
        ? false
        : {
            level: 'info',
            redact: { paths: [...LOG_REDACT_PATHS], censor: '[redacted]' },
            ...(deps.logStream ? { stream: deps.logStream } : {}),
          },
  });

  void app.register(helmet);
  void app.register(cookie, { secret: cookieSecret });
  const auth = createOwnerAuth({
    pin,
    cookieSecret,
    clock: deps.clock,
    secureCookie: deps.env.NODE_ENV === 'production',
  });
  app.setErrorHandler(problemErrorHandler);
  app.setNotFoundHandler(problemNotFoundHandler);

  app.get('/healthz', async (_request, reply) => {
    try {
      await deps.db.execute(sql`select 1`);
      return { ok: true, db: true };
    } catch (err) {
      app.log.error({ err }, 'health check: database unreachable');
      return reply.status(503).send({ ok: false, db: false });
    }
  });

  void app.register(bookingRoutes, {
    db: deps.db,
    connector: deps.connector,
    clock: deps.clock,
    deposit: money(deps.env.DEMO_DEPOSIT_CENTS),
    phoneHashSalt,
  });

  void app.register(auth.sessionRoutes);
  void app.register(boardRoutes, { db: deps.db, clock: deps.clock, hub: deps.hub, auth });
  void app.register(eventRoutes, { db: deps.db, hub: deps.hub });
  app.addHook('preClose', (done) => {
    deps.hub.closeAll();
    done();
  });

  void app.register(webhookRoutes, {
    connector: deps.connector,
    uow: createDrizzleUnitOfWork(deps.db, paymentReaction),
  });

  return app;
}
