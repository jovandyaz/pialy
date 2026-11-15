import { money } from '@pialy/payments';
import { z } from 'zod';

// Shapes follow pey's OpenAPI (CoDi API 2026-10-20) and docs.pey.mx webhook pages.
// Objects are loose: pey may add fields; only what we read is validated.

const CENTAVOS_PER_PESO = 100;
const CENTAVO_TOLERANCE = 1e-6;
const MS_PER_SECOND = 1000;

/** Decimal MXN amount as pey sends it, converted to integer centavos. */
const pesos = z
  .number()
  .nonnegative()
  .refine(
    (v) => Math.abs(v * CENTAVOS_PER_PESO - Math.round(v * CENTAVOS_PER_PESO)) < CENTAVO_TOLERANCE,
    'amount must be a whole number of centavos',
  )
  .transform((v) => money(Math.round(v * CENTAVOS_PER_PESO)));

/** Unix timestamp in seconds. */
const epochSeconds = z
  .number()
  .nonnegative()
  .transform((s) => new Date(s * MS_PER_SECOND));

/** pey "Metadata Response": CoDi fields plus the key/value pairs we attached. */
const metadataSchema = z.looseObject({
  trackingKey: z.string().nullish(),
  bankCode: z
    .union([z.number(), z.string()])
    .nullish()
    .transform((code) => (code === null || code === undefined ? undefined : String(code))),
  externalMetadata: z.looseObject({ attemptId: z.string().nullish() }).nullish(),
});
export type PeyMetadata = z.output<typeof metadataSchema>;

export const pushChargeResponseSchema = z.looseObject({
  transactionId: z.string().min(1),
  codiId: z.string().min(1),
});

export const qrChargeResponseSchema = z.looseObject({
  id: z.string().min(1),
  qrString: z.string().min(1),
});

export const transactionSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  amount: pesos.optional(),
  amountBreakdown: z.looseObject({ base: pesos.optional() }).nullish(),
  currency: z.literal('MXN').optional(),
  datePaid: epochSeconds.optional(),
  metadata: metadataSchema.nullish(),
});
export type PeyTransaction = z.output<typeof transactionSchema>;

export const qrTransactionsPageSchema = z.looseObject({
  items: z.array(transactionSchema),
  nextToken: z.string().min(1).nullish(),
});

/** pey error body: `{ error: { message, type, requestId } }`; gateway errors use `{ message }`. */
export const errorBodySchema = z.looseObject({
  error: z
    .looseObject({
      message: z.string().optional(),
      type: z.string().optional(),
      requestId: z.string().nullish(),
    })
    .optional(),
  message: z.string().optional(),
});

export const PeyEventType = {
  PushPaymentReceived: 'codi.pn.payment_received',
  QrPaymentReceived: 'codi.qr.payment_received',
} as const;

export const webhookEnvelopeSchema = z.looseObject({ type: z.string().min(1) });

const pushPaymentReceivedSchema = z.looseObject({
  type: z.literal(PeyEventType.PushPaymentReceived),
  transactionId: z.string().min(1),
  amount: pesos,
  datePaid: epochSeconds,
  metadata: metadataSchema.nullish(),
});

const qrPaymentReceivedSchema = pushPaymentReceivedSchema.extend({
  type: z.literal(PeyEventType.QrPaymentReceived),
  codiQrId: z.string().min(1),
});

export const paymentReceivedSchema = z.discriminatedUnion('type', [
  pushPaymentReceivedSchema,
  qrPaymentReceivedSchema,
]);
