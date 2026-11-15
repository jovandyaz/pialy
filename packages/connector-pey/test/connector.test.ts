import { readFileSync } from 'node:fs';
import { Webhook } from 'standardwebhooks';
import { describe, expect, it, vi } from 'vitest';
import {
  RailRejectedError,
  RailUnavailableError,
  WebhookSignatureError,
  money,
  type PushChargeInput,
  type QrChargeInput,
} from '@pialy/payments';
import { createPeyConnector, type PeyConnectorConfig } from '../src/index.js';

const API_KEY = 'pey_live_test_key_must_not_leak';
const BASE_URL = 'https://api.pey.test';
const WEBHOOK_SECRET = `whsec_${Buffer.from('pialy-connector-test-secret-0001').toString('base64')}`;
const PHONE = '5512345678';

const pushInput: PushChargeInput = {
  amount: money(1),
  phone10: PHONE,
  concept: 'Anticipo cita',
  expiresInSec: 360,
  numRef: '1001',
  metadata: { attemptId: 'att_1', intentId: 'pi_1' },
};

const qrInput: QrChargeInput = {
  amount: money(1),
  concept: 'Anticipo cita',
  expiresInSec: 600,
  numRef: '1002',
  metadata: { attemptId: 'att_2' },
};

/** pey's documented Get Transaction example, with our metadata in externalMetadata. */
const paidTransaction = {
  id: '01HXYZTXN1234567890ABCDE00',
  status: 'PAID',
  amount: 102.5,
  amountBreakdown: { base: 100, tip: 0, fee: 2.5 },
  currency: 'MXN',
  paymentMethod: 'CODI',
  payableType: 'API_CODI_PN',
  payableId: '01HXYZ1234567890ABCDEFGH00',
  applicationFee: 7.5,
  dateCreated: 1704067200,
  datePaid: 1704067260,
  metadata: {
    clabe: '000000000000000000',
    bankCode: 40012,
    accountType: 40,
    description: 'Pago en Tacos Pey',
    trackingKey: '0192191042',
    externalMetadata: { attemptId: 'att_1', orderId: '12345' },
  },
};

const pnWebhookRaw = readFileSync(new URL('./fixtures/pn-webhook.json', import.meta.url), 'utf8');
const qrWebhookRaw = readFileSync(new URL('./fixtures/qr-webhook.json', import.meta.url), 'utf8');

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withoutKey<T extends object>(value: T, key: keyof T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function peyError(status: number, message: string, type: string): Response {
  return jsonResponse(status, { error: { message, type, requestId: 'req-123' } });
}

function setup(responses: ReadonlyArray<Response | Error>, overrides: Partial<PeyConnectorConfig> = {}) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) {
    if (response instanceof Error) {
      fetchMock.mockRejectedValueOnce(response);
    } else {
      fetchMock.mockResolvedValueOnce(response);
    }
  }
  const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
  const connector = createPeyConnector({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    webhookSecret: WEBHOOK_SECRET,
    fetch: fetchMock,
    sleep,
    ...overrides,
  });
  return { connector, fetchMock, sleep };
}

function requestAt(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index: number) {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`fetch call #${index} was not made`);
  const [input, init] = call;
  return { url: String(input), init: init ?? {}, headers: new Headers(init?.headers) };
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error('rejected with a non-Error value', { cause: error });
  }
  throw new Error('expected the promise to reject');
}

function timeoutError(): DOMException {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

function signedHeaders(rawBody: string, at: Date = new Date(), id = 'msg_2pYrBkWzGr4nVz5BMSWcDNAkV1y') {
  return {
    'webhook-id': id,
    'webhook-timestamp': String(Math.floor(at.getTime() / 1000)),
    'webhook-signature': new Webhook(WEBHOOK_SECRET).sign(id, at, rawBody),
  };
}

describe('createPeyConnector', () => {
  it('identifies itself as the pey rail', () => {
    expect(setup([]).connector.id).toBe('pey');
  });

  it('fails fast on an empty webhook secret', () => {
    expect(() => setup([], { webhookSecret: '' })).toThrow(/webhook secret/);
  });

  it('fails fast on an empty api key', () => {
    expect(() => setup([], { apiKey: '' })).toThrow(/api key/);
  });
});

describe('createPushCharge', () => {
  it('posts the CoDi push request with a Bearer key and returns the ids', async () => {
    const { connector, fetchMock } = setup([
      jsonResponse(200, { transactionId: '01J5KXYZ1234567890ABCD', codiId: '12345678901234567890' }),
    ]);

    const result = await connector.createPushCharge(pushInput);

    expect(result).toStrictEqual({ transactionId: '01J5KXYZ1234567890ABCD', codiId: '12345678901234567890' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init, headers } = requestAt(fetchMock, 0);
    expect(url).toBe(`${BASE_URL}/codi/pn`);
    expect(init.method).toBe('POST');
    expect(headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toStrictEqual({
      amount: 0.01,
      phoneNumber: PHONE,
      concept: 'Anticipo cita',
      expiration: 360,
      numRef: '1001',
      metadata: { attemptId: 'att_1', intentId: 'pi_1' },
    });
  });

  it('retries a 503 with 200/400 ms backoff and succeeds on the third attempt', async () => {
    const { connector, fetchMock, sleep } = setup([
      peyError(503, 'This endpoint is under maintenance, please try again later', 'SERVICE_UNAVAILABLE'),
      peyError(503, 'This endpoint is under maintenance, please try again later', 'SERVICE_UNAVAILABLE'),
      jsonResponse(200, { transactionId: 'tx_1', codiId: 'codi_1' }),
    ]);

    await expect(connector.createPushCharge(pushInput)).resolves.toStrictEqual({
      transactionId: 'tx_1',
      codiId: 'codi_1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toStrictEqual([[200], [400]]);
  });

  it('gives up after three 503 responses with RailUnavailableError', async () => {
    const { connector, fetchMock } = setup([
      peyError(503, 'maintenance', 'SERVICE_UNAVAILABLE'),
      peyError(503, 'maintenance', 'SERVICE_UNAVAILABLE'),
      peyError(503, 'maintenance', 'SERVICE_UNAVAILABLE'),
    ]);

    const error = await rejectionOf(connector.createPushCharge(pushInput));

    expect(error).toBeInstanceOf(RailUnavailableError);
    expect(error).toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a 502 response', async () => {
    const { connector, fetchMock } = setup([
      new Response('Bad Gateway', { status: 502 }),
      jsonResponse(200, { transactionId: 'tx_1', codiId: 'codi_1' }),
    ]);

    await expect(connector.createPushCharge(pushInput)).resolves.toMatchObject({ transactionId: 'tx_1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 500, which may have created the charge', async () => {
    const { connector, fetchMock, sleep } = setup([
      peyError(500, 'Error creating CoDi push notification', 'INTERNAL_SERVER_ERROR'),
    ]);

    const error = await rejectionOf(connector.createPushCharge(pushInput));

    expect(error).toBeInstanceOf(RailUnavailableError);
    expect(error).toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('maps a 400 to RailRejectedError carrying pey message, without retrying', async () => {
    const { connector, fetchMock } = setup([
      peyError(400, 'API key does not have CoDi enabled', 'INVALID_STATE'),
    ]);

    const error = await rejectionOf(connector.createPushCharge(pushInput));

    expect(error).toBeInstanceOf(RailRejectedError);
    expect(error).toMatchObject({
      status: 400,
      providerMessage: 'API key does not have CoDi enabled',
      providerCode: 'INVALID_STATE',
      requestId: 'req-123',
    });
    expect(error.message).toContain('API key does not have CoDi enabled');
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain(PHONE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('masks a phone number echoed in pey error message', async () => {
    const { connector } = setup([peyError(400, `phoneNumber ${PHONE} is not enrolled in CoDi`, 'INVALID_PARAMETER')]);

    const error = await rejectionOf(connector.createPushCharge(pushInput));

    expect(error).toBeInstanceOf(RailRejectedError);
    expect(error.message).not.toContain(PHONE);
    expect(error).toMatchObject({ providerMessage: 'phoneNumber ******5678 is not enrolled in CoDi' });
  });

  it('does not retry a network error, which may have created the charge', async () => {
    const { connector, fetchMock, sleep } = setup([new TypeError('fetch failed')]);

    const error = await rejectionOf(connector.createPushCharge(pushInput));

    expect(error).toBeInstanceOf(RailUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('aborts after timeoutMs and does not retry', async () => {
    const hangingFetch = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const { connector, sleep } = setup([], { fetch: hangingFetch, timeoutMs: 5 });

    const error = await rejectionOf(connector.createPushCharge(pushInput));

    expect(error).toBeInstanceOf(RailUnavailableError);
    expect(hangingFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejects a success response without the expected ids', async () => {
    const { connector, fetchMock } = setup([jsonResponse(200, { transactionId: 'tx_1' })]);

    const error = await rejectionOf(connector.createPushCharge(pushInput));

    expect(error).toBeInstanceOf(RailUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('createQrCharge', () => {
  it('posts the CoDi QR request and returns the IDC and QR payload', async () => {
    const qrString = '{"TYP":20,"ic":{"IDC":"35f8361d2b"}}';
    const { connector, fetchMock } = setup([
      jsonResponse(201, { id: '35f8361d2b', qrString, qrImage: null }),
    ]);

    const result = await connector.createQrCharge(qrInput);

    expect(result).toStrictEqual({ qrId: '35f8361d2b', qrString });
    const { url, init, headers } = requestAt(fetchMock, 0);
    expect(url).toBe(`${BASE_URL}/codi/qr`);
    expect(init.method).toBe('POST');
    expect(headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(String(init.body))).toStrictEqual({
      amount: 0.01,
      concept: 'Anticipo cita',
      expiration: 600,
      numRef: '1002',
      metadata: { attemptId: 'att_2' },
    });
  });
});

describe('findPayments by transactionId', () => {
  it('maps a PAID transaction to one ProviderPayment using the base amount', async () => {
    const { connector, fetchMock } = setup([jsonResponse(200, paidTransaction)]);

    const payments = await connector.findPayments({ transactionId: paidTransaction.id });

    expect(payments).toStrictEqual([
      {
        providerTxId: paidTransaction.id,
        amount: money(10000),
        paidAt: new Date(1704067260 * 1000),
        trackingKey: '0192191042',
        payerBankCode: '40012',
        ref: { transactionId: paidTransaction.id, attemptId: 'att_1' },
      },
    ]);
    const { url, init, headers } = requestAt(fetchMock, 0);
    expect(url).toBe(`${BASE_URL}/transaction/${paidTransaction.id}`);
    expect(init.method).toBe('GET');
    expect(headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('falls back to the total amount when there is no breakdown', async () => {
    const { connector } = setup([
      jsonResponse(200, { ...withoutKey(paidTransaction, 'amountBreakdown'), amount: 0.01 }),
    ]);

    const payments = await connector.findPayments({ transactionId: paidTransaction.id });

    expect(payments.map((p) => p.amount)).toStrictEqual([money(1)]);
  });

  it('leaves optional fields out when pey metadata lacks them', async () => {
    const { connector } = setup([jsonResponse(200, { ...paidTransaction, metadata: {} })]);

    const [payment] = await connector.findPayments({ transactionId: paidTransaction.id });

    expect(payment).toStrictEqual({
      providerTxId: paidTransaction.id,
      amount: money(10000),
      paidAt: new Date(1704067260 * 1000),
      ref: { transactionId: paidTransaction.id },
    });
  });

  it('returns no payments for a PENDING transaction', async () => {
    const { connector } = setup([
      jsonResponse(200, { id: paidTransaction.id, status: 'PENDING', amount: 0.01, dateCreated: 1704067200 }),
    ]);

    await expect(connector.findPayments({ transactionId: paidTransaction.id })).resolves.toStrictEqual([]);
  });

  it('retries any 5xx on a GET', async () => {
    const { connector, fetchMock, sleep } = setup([
      peyError(500, 'Error retrieving transaction', 'INTERNAL_SERVER_ERROR'),
      new Response('Gateway Timeout', { status: 504 }),
      jsonResponse(200, paidTransaction),
    ]);

    await expect(connector.findPayments({ transactionId: paidTransaction.id })).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toStrictEqual([[200], [400]]);
  });

  it('retries a network error or timeout on a GET', async () => {
    const { connector, fetchMock } = setup([
      new TypeError('fetch failed'),
      timeoutError(),
      jsonResponse(200, paidTransaction),
    ]);

    await expect(connector.findPayments({ transactionId: paidTransaction.id })).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up on a GET after three failed attempts', async () => {
    const { connector, fetchMock } = setup([timeoutError(), timeoutError(), timeoutError()]);

    const error = await rejectionOf(connector.findPayments({ transactionId: paidTransaction.id }));

    expect(error).toBeInstanceOf(RailUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('maps a 404 to RailRejectedError without retrying', async () => {
    const { connector, fetchMock } = setup([peyError(404, 'Transaction not found', 'NOT_FOUND')]);

    const error = await rejectionOf(connector.findPayments({ transactionId: 'missing' }));

    expect(error).toBeInstanceOf(RailRejectedError);
    expect(error).toMatchObject({ status: 404, providerMessage: 'Transaction not found' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a PAID transaction without datePaid', async () => {
    const { connector } = setup([jsonResponse(200, withoutKey(paidTransaction, 'datePaid'))]);

    await expect(connector.findPayments({ transactionId: paidTransaction.id })).rejects.toBeInstanceOf(
      RailUnavailableError,
    );
  });

  it('rejects an amount that is not a whole number of centavos', async () => {
    const { connector } = setup([
      jsonResponse(200, { ...paidTransaction, amountBreakdown: { base: 0.015 } }),
    ]);

    await expect(connector.findPayments({ transactionId: paidTransaction.id })).rejects.toBeInstanceOf(
      RailUnavailableError,
    );
  });

  it('rejects a non-MXN transaction', async () => {
    const { connector } = setup([jsonResponse(200, { ...paidTransaction, currency: 'USD' })]);

    await expect(connector.findPayments({ transactionId: paidTransaction.id })).rejects.toBeInstanceOf(
      RailUnavailableError,
    );
  });
});

describe('findPayments by qrId', () => {
  const qrPaid = (id: string, attemptId: string) => ({
    id,
    status: 'PAID',
    amount: 0.01,
    amountBreakdown: { base: 0.01 },
    currency: 'MXN',
    paymentMethod: 'CODI',
    description: 'Anticipo cita',
    dateCreated: 1704067200,
    datePaid: 1704067230,
    metadata: {
      clabe: '000000000000000000',
      bankCode: 40012,
      accountType: 40,
      trackingKey: `tk_${id}`,
      externalMetadata: { attemptId },
    },
  });

  it('maps each PAID item of the QR and skips the rest', async () => {
    const { connector, fetchMock } = setup([
      jsonResponse(200, {
        items: [
          qrPaid('tx_b', 'att_2'),
          { id: 'tx_pending', status: 'PENDING', amount: 0.01, dateCreated: 1704067200 },
          qrPaid('tx_a', 'att_2'),
        ],
        nextToken: null,
      }),
    ]);

    const payments = await connector.findPayments({ qrId: '35a13c183a' });

    expect(payments).toStrictEqual(
      ['tx_b', 'tx_a'].map((id) => ({
        providerTxId: id,
        amount: money(1),
        paidAt: new Date(1704067230 * 1000),
        trackingKey: `tk_${id}`,
        payerBankCode: '40012',
        ref: { transactionId: id, qrId: '35a13c183a', attemptId: 'att_2' },
      })),
    );
    const { url, init } = requestAt(fetchMock, 0);
    expect(url).toBe(`${BASE_URL}/transaction/codi/qr/35a13c183a`);
    expect(init.method).toBe('GET');
  });

  it('follows nextToken until the last page', async () => {
    const { connector, fetchMock } = setup([
      jsonResponse(200, { items: [qrPaid('tx_c', 'att_2')], nextToken: 'eyJQSyI6/+=' }),
      jsonResponse(200, { items: [qrPaid('tx_d', 'att_2')], nextToken: null }),
    ]);

    const payments = await connector.findPayments({ qrId: '35a13c183a' });

    expect(payments.map((p) => p.providerTxId)).toStrictEqual(['tx_c', 'tx_d']);
    expect(requestAt(fetchMock, 1).url).toBe(
      `${BASE_URL}/transaction/codi/qr/35a13c183a?nextToken=eyJQSyI6%2F%2B%3D`,
    );
  });
});

describe('parseWebhook', () => {
  it('verifies and maps a CoDi push payment', () => {
    const { connector } = setup([]);

    const parsed = connector.parseWebhook(pnWebhookRaw, signedHeaders(pnWebhookRaw));

    expect(parsed).toStrictEqual({
      webhookId: 'msg_2pYrBkWzGr4nVz5BMSWcDNAkV1y',
      eventType: 'codi.pn.payment_received',
      payment: {
        providerTxId: '01M3QR5E7XHXMNZDEPFH3JAWS0',
        amount: money(10000),
        paidAt: new Date(1790724758 * 1000),
        trackingKey: '0192191042',
        payerBankCode: '40012',
        ref: { transactionId: '01M3QR5E7XHXMNZDEPFH3JAWS0', attemptId: 'att_01TESTATTEMPTPN000000001' },
      },
    });
  });

  it('verifies and maps a CoDi QR payment with the QR id', () => {
    const { connector } = setup([]);

    const parsed = connector.parseWebhook(qrWebhookRaw, signedHeaders(qrWebhookRaw));

    expect(parsed.eventType).toBe('codi.qr.payment_received');
    expect(parsed.payment).toStrictEqual({
      providerTxId: '01M3QR8H0RH0XBCKYYD242YXNV',
      amount: money(15000),
      paidAt: new Date(1790724818 * 1000),
      trackingKey: '0192191042',
      payerBankCode: '40012',
      ref: {
        transactionId: '01M3QR8H0RH0XBCKYYD242YXNV',
        qrId: '35a13c183a',
        attemptId: 'att_01TESTATTEMPTQR000000001',
      },
    });
  });

  it('leaves attemptId undefined when externalMetadata is absent', () => {
    const payload = JSON.parse(pnWebhookRaw) as { metadata: Record<string, unknown> };
    delete payload.metadata['externalMetadata'];
    const raw = JSON.stringify(payload);
    const { connector } = setup([]);

    const parsed = connector.parseWebhook(raw, signedHeaders(raw));

    expect(parsed.payment?.ref).toStrictEqual({ transactionId: '01M3QR5E7XHXMNZDEPFH3JAWS0' });
  });

  it('accepts header names in any case', () => {
    const { connector } = setup([]);
    const headers = signedHeaders(pnWebhookRaw);

    const parsed = connector.parseWebhook(pnWebhookRaw, {
      'Webhook-Id': headers['webhook-id'],
      'Webhook-Timestamp': headers['webhook-timestamp'],
      'Webhook-Signature': headers['webhook-signature'],
      'content-type': undefined,
    });

    expect(parsed.webhookId).toBe('msg_2pYrBkWzGr4nVz5BMSWcDNAkV1y');
  });

  it('rejects a tampered body', () => {
    const { connector } = setup([]);
    const headers = signedHeaders(pnWebhookRaw);
    const tampered = pnWebhookRaw.replace('"amount": 100', '"amount": 1');
    expect(tampered).not.toBe(pnWebhookRaw);

    expect(() => connector.parseWebhook(tampered, headers)).toThrow(WebhookSignatureError);
  });

  it('rejects a signature from another secret', () => {
    const { connector } = setup([], {
      webhookSecret: `whsec_${Buffer.from('a-different-secret-for-the-test!').toString('base64')}`,
    });

    expect(() => connector.parseWebhook(pnWebhookRaw, signedHeaders(pnWebhookRaw))).toThrow(
      WebhookSignatureError,
    );
  });

  it('rejects a timestamp 10 minutes old', () => {
    const { connector } = setup([]);
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    expect(() => connector.parseWebhook(pnWebhookRaw, signedHeaders(pnWebhookRaw, tenMinutesAgo))).toThrow(
      WebhookSignatureError,
    );
  });

  it('rejects a delivery without signature headers', () => {
    const { connector } = setup([]);

    expect(() => connector.parseWebhook(pnWebhookRaw, {})).toThrow(WebhookSignatureError);
  });

  it('returns no payment for an unknown event type after verifying it', () => {
    const raw = JSON.stringify({ type: 'payment_link.status_updated', status: 'paid' });
    const { connector } = setup([]);

    expect(connector.parseWebhook(raw, signedHeaders(raw, new Date(), 'msg_unknown'))).toStrictEqual({
      webhookId: 'msg_unknown',
      eventType: 'payment_link.status_updated',
      payment: null,
    });
    expect(() => connector.parseWebhook(raw, {})).toThrow(WebhookSignatureError);
  });

  it('fails loudly on a signed payment event that breaks pey contract', () => {
    const raw = JSON.stringify({ type: 'codi.pn.payment_received', amount: 100 });
    const { connector } = setup([]);

    let thrown: unknown;
    try {
      connector.parseWebhook(raw, signedHeaders(raw));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(WebhookSignatureError);
    expect(String(thrown)).toContain('codi.pn.payment_received');
  });
});
