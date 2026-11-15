import {
  WebhookSignatureError,
  receiveWebhook,
  type ParsedWebhook,
  type RailConnector,
  type UnitOfWork,
  type WebhookOutcome,
} from '@pialy/payments';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { sendProblem } from '../problem.js';

export interface WebhookRoutesOptions {
  readonly connector: RailConnector;
  readonly uow: UnitOfWork;
}

const MAX_LOGGED_ID_LENGTH = 128;

/**
 * Register without `fastify-plugin`: the parser that keeps the body as the raw string the
 * signature covers must stay inside this scope, so every other route still parses JSON.
 * The body carries the payer's CLABE, so neither it nor the headers are ever logged.
 */
export const webhookRoutes: FastifyPluginAsync<WebhookRoutesOptions> = async (app, { connector, uow }) => {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    done(null, body);
  });

  app.post('/api/webhooks/pey', async (request, reply) => {
    const rawBody = typeof request.body === 'string' ? request.body : '';
    let webhook: ParsedWebhook;
    try {
      webhook = connector.parseWebhook(rawBody, headersOf(request));
    } catch (error) {
      // Only a bad signature is the sender's fault; any other failure gets a 500 so pey retries it.
      if (!(error instanceof WebhookSignatureError)) throw error;
      request.log.warn({ webhookId: claimedWebhookId(request) }, 'pey webhook rejected: invalid signature');
      return sendProblem(reply, 401);
    }

    const context = {
      webhookId: webhook.webhookId,
      eventType: webhook.eventType,
      providerTxId: webhook.payment?.providerTxId,
    };
    const raw: unknown = JSON.parse(rawBody);
    let outcome: WebhookOutcome;
    try {
      outcome = await receiveWebhook(uow, connector, webhook, raw);
    } catch (error) {
      // Nothing was committed: a 5xx makes pey redeliver.
      request.log.error({ ...context, err: error }, 'pey webhook failed');
      return sendProblem(reply, 500);
    }
    request.log.info({ ...context, outcome }, 'pey webhook processed');
    return reply.send({ status: outcome });
  });
};

function headersOf(request: FastifyRequest): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers[name] = value;
  }
  return headers;
}

function claimedWebhookId(request: FastifyRequest): string | undefined {
  const id = request.headers['webhook-id'];
  return typeof id === 'string' ? id.slice(0, MAX_LOGGED_ID_LENGTH) : undefined;
}
