import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

/**
 * Railway's edge sets `X-Real-IP` to the client's address (docs.railway.com, public networking
 * specs). The left-most `X-Forwarded-For` entry that `request.ip` trusts is client-controlled.
 */
export function clientIp(request: FastifyRequest): string {
  const realIp = request.headers['x-real-ip'];
  const candidate = typeof realIp === 'string' ? realIp.trim() : '';
  return isIP(candidate) === 0 ? request.ip : candidate;
}
