import helmet from '@fastify/helmet';
import type { Clock, RailConnector } from '@pialy/payments';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import { problemErrorHandler, problemNotFoundHandler } from './http/problem.js';
import type { Db } from './infrastructure/db/client.js';

export interface AppDeps {
  readonly db: Db;
  readonly connector: RailConnector;
  readonly clock: Clock;
  readonly env: Env;
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
  '*.phone',
  '*.phoneNumber',
  'PEY_API_KEY',
  'PEY_WEBHOOK_SECRET',
  '*.PEY_API_KEY',
  '*.PEY_WEBHOOK_SECRET',
] as const;

export function buildApp(deps: AppDeps): FastifyInstance {
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

  return app;
}
