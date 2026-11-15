import type { Money } from '../domain/money.js';

/** A settled payment as a rail reports it, normalized for the payments core. */
export interface ProviderPayment {
  readonly providerTxId: string;
  readonly amount: Money;
  readonly paidAt: Date;
  readonly trackingKey?: string;
  readonly payerBankCode?: string;
  /** Identifiers that tie the payment back to what we created on the rail. */
  readonly ref: {
    readonly transactionId?: string;
    readonly qrId?: string;
    readonly attemptId?: string;
  };
}

export interface ParsedWebhook {
  /** Idempotency key of the delivery. */
  readonly webhookId: string;
  readonly eventType: string;
  /** `null` for events that do not report a payment. */
  readonly payment: ProviderPayment | null;
}

export interface PushChargeInput {
  readonly amount: Money;
  readonly phone10: string;
  readonly concept: string;
  readonly expiresInSec: number;
  readonly numRef: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface QrChargeInput {
  readonly amount: Money;
  readonly concept: string;
  readonly expiresInSec: number;
  readonly numRef: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export type PaymentLookup = { readonly transactionId: string } | { readonly qrId: string };

/** One payment processor; the core never knows which one. */
export interface RailConnector {
  readonly id: string;
  createPushCharge(input: PushChargeInput): Promise<{ transactionId: string; codiId: string }>;
  createQrCharge(input: QrChargeInput): Promise<{ qrId: string; qrString: string }>;
  findPayments(ref: PaymentLookup): Promise<ProviderPayment[]>;
  /** Verifies the signature before reading the body; throws {@link WebhookSignatureError}. */
  parseWebhook(rawBody: string, headers: Readonly<Record<string, string | undefined>>): ParsedWebhook;
}

export interface Clock {
  now(): Date;
}

export class WebhookSignatureError extends Error {
  override readonly name = 'WebhookSignatureError';
}

/**
 * The rail gave no usable answer: 5xx, maintenance, timeout, network failure or an
 * unexpected response body. For a create call the charge may or may not exist.
 */
export class RailUnavailableError extends Error {
  override readonly name = 'RailUnavailableError';
  readonly status: number | undefined;

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.status = options.status;
  }
}

/** The rail refused the request (4xx); retrying the same request will not help. */
export class RailRejectedError extends Error {
  override readonly name = 'RailRejectedError';
  readonly status: number;
  readonly providerMessage: string;
  readonly providerCode: string | undefined;
  readonly requestId: string | undefined;

  constructor(
    message: string,
    details: {
      status: number;
      providerMessage: string;
      providerCode?: string | undefined;
      requestId?: string | undefined;
    },
  ) {
    super(message);
    this.status = details.status;
    this.providerMessage = details.providerMessage;
    this.providerCode = details.providerCode;
    this.requestId = details.requestId;
  }
}
