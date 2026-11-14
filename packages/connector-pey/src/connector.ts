import { setTimeout as delay } from 'node:timers/promises';
import {
  RailUnavailableError,
  WebhookSignatureError,
  toProviderAmount,
  type Money,
  type ParsedWebhook,
  type ProviderPayment,
  type RailConnector,
} from '@pialy/payments';
import { Webhook, WebhookVerificationError } from 'standardwebhooks';
import { z } from 'zod';
import { createPeyHttpClient, type PeyHttpClient } from './client.js';
import {
  PeyEventType,
  paymentReceivedSchema,
  pushChargeResponseSchema,
  qrChargeResponseSchema,
  qrTransactionsPageSchema,
  transactionSchema,
  webhookEnvelopeSchema,
  type PeyMetadata,
  type PeyTransaction,
} from './schemas.js';

export interface PeyConnectorConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  /** Standard Webhooks secret from the pey portal (`whsec_…`). */
  readonly webhookSecret: string;
  readonly fetch?: typeof fetch;
  /** Per-attempt timeout. */
  readonly timeoutMs?: number;
  /** Backoff wait between retries; injectable so tests do not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 8000;
/** pey pages QR transactions 20 at a time; this bounds a runaway `nextToken` loop. */
const MAX_QR_PAGES = 10;
const PAID_STATUS = 'PAID';
const PAYMENT_EVENT_TYPES: ReadonlySet<string> = new Set(Object.values(PeyEventType));

export function createPeyConnector(config: PeyConnectorConfig): RailConnector {
  if (config.apiKey.trim() === '') throw new Error('pey api key is required');
  if (config.webhookSecret.trim() === '') throw new Error('pey webhook secret is required');
  const webhook = new Webhook(config.webhookSecret);
  const http = createPeyHttpClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    fetch: config.fetch ?? ((input, init) => fetch(input, init)),
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    sleep: config.sleep ?? ((ms) => delay(ms)),
  });

  return {
    id: 'pey',

    async createPushCharge(input) {
      const created = await http.post(
        '/codi/pn',
        {
          amount: toProviderAmount(input.amount),
          phoneNumber: input.phone10,
          concept: input.concept,
          expiration: input.expiresInSec,
          numRef: input.numRef,
          metadata: input.metadata,
        },
        pushChargeResponseSchema,
      );
      return { transactionId: created.transactionId, codiId: created.codiId };
    },

    async createQrCharge(input) {
      const created = await http.post(
        '/codi/qr',
        {
          amount: toProviderAmount(input.amount),
          concept: input.concept,
          expiration: input.expiresInSec,
          numRef: input.numRef,
          metadata: input.metadata,
        },
        qrChargeResponseSchema,
      );
      return { qrId: created.id, qrString: created.qrString };
    },

    async findPayments(ref) {
      if ('transactionId' in ref) {
        const transaction = await http.get(
          `/transaction/${encodeURIComponent(ref.transactionId)}`,
          transactionSchema,
        );
        return paidPayments([transaction], undefined);
      }
      return findQrPayments(http, ref.qrId);
    },

    parseWebhook(rawBody, headers) {
      const webhookId = verifySignature(webhook, rawBody, headers);
      const payload = parseJsonWithoutEchoingBody(rawBody, webhookId);
      const envelope = webhookEnvelopeSchema.safeParse(payload);
      if (!envelope.success) {
        throw new Error(`pey webhook ${webhookId} has no event type: ${z.prettifyError(envelope.error)}`);
      }
      const eventType = envelope.data.type;
      if (!PAYMENT_EVENT_TYPES.has(eventType)) {
        return { webhookId, eventType, payment: null };
      }
      const event = paymentReceivedSchema.safeParse(payload);
      if (!event.success) {
        throw new Error(
          `pey webhook ${webhookId} (${eventType}) breaks the documented payload: ${z.prettifyError(event.error)}`,
        );
      }
      const data = event.data;
      const payment = toProviderPayment({
        transactionId: data.transactionId,
        amount: data.amount,
        paidAt: data.datePaid,
        metadata: data.metadata,
        qrId: data.type === PeyEventType.QrPaymentReceived ? data.codiQrId : undefined,
      });
      return { webhookId, eventType, payment } satisfies ParsedWebhook;
    },
  };
}

async function findQrPayments(http: PeyHttpClient, qrId: string): Promise<ProviderPayment[]> {
  const path = `/transaction/codi/qr/${encodeURIComponent(qrId)}`;
  const payments: ProviderPayment[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_QR_PAGES; page += 1) {
    const result = await http.get(
      path,
      qrTransactionsPageSchema,
      nextToken === undefined ? undefined : { nextToken },
    );
    payments.push(...paidPayments(result.items, qrId));
    if (!result.nextToken) return payments;
    nextToken = result.nextToken;
  }
  throw new RailUnavailableError(`pey QR ${qrId} has more than ${MAX_QR_PAGES} pages of transactions`);
}

function paidPayments(transactions: readonly PeyTransaction[], qrId: string | undefined): ProviderPayment[] {
  return transactions
    .filter((transaction) => transaction.status === PAID_STATUS)
    .map((transaction) => {
      // The base excludes any tip or payer fee, so it is what the charge asked for.
      const amount = transaction.amountBreakdown?.base ?? transaction.amount;
      if (amount === undefined || transaction.datePaid === undefined) {
        throw new RailUnavailableError(`pey transaction ${transaction.id} is PAID without amount or datePaid`);
      }
      return toProviderPayment({
        transactionId: transaction.id,
        amount,
        paidAt: transaction.datePaid,
        metadata: transaction.metadata,
        qrId,
      });
    });
}

function toProviderPayment(fields: {
  transactionId: string;
  amount: Money;
  paidAt: Date;
  metadata: PeyMetadata | null | undefined;
  qrId: string | undefined;
}): ProviderPayment {
  const trackingKey = fields.metadata?.trackingKey;
  const payerBankCode = fields.metadata?.bankCode;
  const attemptId = fields.metadata?.externalMetadata?.attemptId;
  return {
    providerTxId: fields.transactionId,
    amount: fields.amount,
    paidAt: fields.paidAt,
    ...(trackingKey ? { trackingKey } : {}),
    ...(payerBankCode ? { payerBankCode } : {}),
    ref: {
      transactionId: fields.transactionId,
      ...(fields.qrId ? { qrId: fields.qrId } : {}),
      ...(attemptId ? { attemptId } : {}),
    },
  };
}

/** Verifies the Standard Webhooks signature and timestamp; returns the delivery id. */
function verifySignature(
  webhook: Webhook,
  rawBody: string,
  headers: Readonly<Record<string, string | undefined>>,
): string {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) normalized[name.toLowerCase()] = value;
  }
  try {
    webhook.verify(rawBody, normalized, { jsonParse: false });
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      throw new WebhookSignatureError(`pey webhook rejected: ${error.message}`, { cause: error });
    }
    throw error;
  }
  const webhookId = normalized['webhook-id'];
  if (!webhookId) throw new WebhookSignatureError('pey webhook rejected: missing webhook-id');
  return webhookId;
}

/** The body carries the payer's CLABE and V8's SyntaxError quotes its input, so that error is dropped. */
function parseJsonWithoutEchoingBody(rawBody: string, webhookId: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw new Error(`pey webhook ${webhookId} body is not valid JSON`);
  }
}
