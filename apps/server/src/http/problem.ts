import { STATUS_CODES } from 'node:http';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/** RFC 9457 problem details. */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export function problem(status: number, detail?: string, type = 'about:blank'): ProblemDetails {
  const title = STATUS_CODES[status] ?? 'Error';
  return detail === undefined ? { type, title, status } : { type, title, status, detail };
}

export function sendProblem(reply: FastifyReply, status: number, detail?: string): FastifyReply {
  return reply.status(status).header('content-type', PROBLEM_CONTENT_TYPE).send(problem(status, detail));
}

export function problemErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const status = error.statusCode;
  if (status !== undefined && status >= 400 && status < 500) {
    // Fastify's own 4xx messages (bad JSON, schema, payload size) are written for clients.
    request.log.info({ err: error }, 'client error');
    return sendProblem(reply, status, error.message);
  }
  request.log.error({ err: error }, 'unhandled error');
  return sendProblem(reply, 500);
}

export function problemNotFoundHandler(_request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendProblem(reply, 404);
}
