import { createHash, timingSafeEqual } from 'node:crypto';
import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import type { Clock } from '@pialy/payments';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { clientIp } from './client-ip.js';
import { sendProblem } from './problem.js';

export const OWNER_COOKIE = 'pialy_owner';
export const SESSION_HOURS = 12;

const MS_PER_HOUR = 3_600_000;
const MS_PER_SECOND = 1000;
const SESSION_MS = SESSION_HOURS * MS_PER_HOUR;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_TOO_MANY_REQUESTS = 429;
/** Per client IP; in memory, so per instance. Every attempt counts, right or wrong. */
const PIN_ATTEMPTS = { max: 5, timeWindow: 10 * 60_000 } as const;
const PIN_LIMIT_DETAIL = 'Demasiados intentos. Espera unos minutos.';
/** Wrong PINs from all IPs together: caps a botnet that rotates addresses to dodge the per-IP limit. */
const GLOBAL_FAILED_PINS = { max: 20, windowMs: 10 * 60_000 } as const;
const LOCKOUT_LOG = 'owner login locked: global failed-PIN cap reached';
const pinBody = z.strictObject({ pin: z.string().min(1).max(128) });

export interface OwnerAuthConfig {
  readonly pin: string;
  readonly cookieSecret: string;
  readonly clock: Clock;
  /** `Secure` cookie; on in production. */
  readonly secureCookie: boolean;
}

export interface OwnerAuth {
  /** `preHandler` that answers 401 unless the request carries a live, untampered owner cookie. */
  readonly requireOwner: preHandlerAsyncHookHandler;
  readonly sessionRoutes: FastifyPluginAsync;
}

/**
 * The business owner's session: a PIN exchanged for a signed, httpOnly, SameSite=Strict cookie.
 * The cookie value is the issue time, so the 12 h lifetime is enforced here and not only by the
 * browser. Requires `@fastify/cookie` (with `cookieSecret`) registered on the app beforehand.
 */
export function createOwnerAuth(config: OwnerAuthConfig): OwnerAuth {
  const { clock } = config;
  const expectedPin = digest(config.pin);
  // In memory, so per instance; entries older than the window are dropped on each use.
  let failedAt: number[] = [];
  // One warn line per lockout window, not one per rejected request.
  let lockLogged = false;

  /** Seconds until the global cap frees a login, or `null` when logins are open. */
  function lockoutSeconds(log: { warn(message: string): void }): number | null {
    const now = clock.now().getTime();
    failedAt = failedAt.filter((at) => at > now - GLOBAL_FAILED_PINS.windowMs);
    const locked = failedAt.length >= GLOBAL_FAILED_PINS.max;
    if (locked && !lockLogged) log.warn(LOCKOUT_LOG);
    lockLogged = locked;
    if (!locked) return null;
    // Failures are kept oldest first: logins reopen once this one leaves the window.
    const freeing = failedAt[failedAt.length - GLOBAL_FAILED_PINS.max] ?? now;
    return Math.max(1, Math.ceil((freeing + GLOBAL_FAILED_PINS.windowMs - now) / MS_PER_SECOND));
  }

  function isOwner(request: FastifyRequest): boolean {
    const signed = request.cookies[OWNER_COOKIE];
    if (signed === undefined) return false;
    const unsigned = request.unsignCookie(signed);
    if (!unsigned.valid || unsigned.value === null) return false;
    const issuedAt = Number(unsigned.value);
    const age = clock.now().getTime() - issuedAt;
    return Number.isSafeInteger(issuedAt) && age >= 0 && age < SESSION_MS;
  }

  function issue(reply: FastifyReply): void {
    void reply.setCookie(OWNER_COOKIE, String(clock.now().getTime()), {
      signed: true,
      httpOnly: true,
      sameSite: 'strict',
      secure: config.secureCookie,
      path: '/',
      maxAge: SESSION_MS / 1000,
    });
  }

  const requireOwner: preHandlerAsyncHookHandler = async (request, reply) => {
    if (isOwner(request)) {
      void reply.header('cache-control', 'no-store');
      return;
    }
    return sendProblem(reply, HTTP_UNAUTHORIZED, 'Inicia sesión como dueño');
  };

  const sessionRoutes: FastifyPluginAsync = async (app) => {
    await app.register(rateLimit, {
      global: false,
      keyGenerator: (request) => normalizeIP(clientIp(request)),
      errorResponseBuilder: (_request, context) =>
        Object.assign(new Error(PIN_LIMIT_DETAIL), { statusCode: context.statusCode }),
    });

    app.post('/api/session', { config: { rateLimit: PIN_ATTEMPTS } }, async (request, reply) => {
      const body = pinBody.safeParse(request.body);
      if (!body.success) return sendProblem(reply, HTTP_BAD_REQUEST, 'Escribe tu PIN');
      const retryAfter = lockoutSeconds(request.log);
      if (retryAfter !== null) {
        void reply.header('retry-after', String(retryAfter));
        return sendProblem(reply, HTTP_TOO_MANY_REQUESTS, PIN_LIMIT_DETAIL);
      }
      if (!timingSafeEqual(digest(body.data.pin), expectedPin)) {
        failedAt.push(clock.now().getTime());
        return sendProblem(reply, HTTP_UNAUTHORIZED, 'PIN incorrecto');
      }
      issue(reply);
      return reply.status(HTTP_NO_CONTENT).send();
    });

    app.delete('/api/session', async (_request, reply) => {
      void reply.clearCookie(OWNER_COOKIE, { path: '/' });
      return reply.status(HTTP_NO_CONTENT).send();
    });
  };

  return { requireOwner, sessionRoutes };
}

/** Fixed-length digests make the comparison constant time whatever the PIN's length. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
