import { z } from 'zod';

// Skip Zod's eval probe: the CSP blocks eval and would log a violation on every page.
z.config({ jitless: true });

export const BOOKING_STATUSES = ['holding', 'confirmed', 'checked_in', 'expired', 'canceled'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export const STATUS = {
  holding: 'holding',
  confirmed: 'confirmed',
  checkedIn: 'checked_in',
  expired: 'expired',
  canceled: 'canceled',
} as const satisfies Record<string, BookingStatus>;
export const SLOT_STATES = ['free', 'held', 'taken'] as const;
export type SlotState = (typeof SLOT_STATES)[number];
const FLAG_KINDS = ['refund_due', 'unmatched_payment', 'amount_mismatch', 'unknown'] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];
export const FLAG_KIND = {
  refundDue: 'refund_due',
  unmatchedPayment: 'unmatched_payment',
  amountMismatch: 'amount_mismatch',
  unknown: 'unknown',
} as const satisfies Record<string, FlagKind>;
export const DUPLICATE_PAYMENT_REASON = 'duplicate_payment';

const bookingStatus = z.enum(BOOKING_STATUSES);
const isoInstant = z.iso.datetime({ offset: true });
const slotRange = z.object({ start: isoInstant, end: isoInstant });

export const slotsSchema = z.object({ slots: z.array(slotRange.extend({ state: z.enum(SLOT_STATES) })) });
export type SlotItem = z.infer<typeof slotsSchema>['slots'][number];

export const holdSchema = z.object({ token: z.string(), holdExpiresAt: isoInstant });

export const bookingSchema = z.object({
  token: z.string(),
  status: bookingStatus,
  late: z.boolean(),
  slot: slotRange,
  holdExpiresAt: isoInstant.nullable(),
  attempts: z.array(
    z.object({ mode: z.enum(['push', 'qr']), status: z.enum(['awaiting', 'succeeded', 'expired', 'failed']) }),
  ),
  pass: z
    .object({
      time: isoInstant,
      phoneLast4: z.string(),
      trackingKey: z.string().optional(),
      bankName: z.string().nullable().optional(),
    })
    .optional(),
});
export type BookingView = z.infer<typeof bookingSchema>;

export const qrSchema = z.object({ qrString: z.string().min(1), expiresAt: isoInstant });
export type QrResponse = z.infer<typeof qrSchema>;

/** Live-update hint `{type,status}`; pages refetch on every one. */
export const streamEventSchema = z.object({ type: z.string(), status: z.string().optional() });

const ownerBooking = z.object({
  token: z.string(),
  status: bookingStatus,
  late: z.boolean(),
  slotStart: isoInstant,
  customerName: z.string().nullable(),
  phoneLast4: z.string(),
  bankName: z.string().nullable(),
  checkedInAt: isoInstant.nullable(),
});
export type OwnerBooking = z.infer<typeof ownerBooking>;

const money = z.object({ amountMinor: z.number(), currency: z.string() });

const flagSchema = z.object({
  id: z.string(),
  kind: z.enum(FLAG_KINDS),
  createdAt: isoInstant,
  reason: z.string().nullable(),
  paidAt: z.string().nullable(),
  trackingKey: z.string().nullable(),
  amount: money.nullable(),
  expected: money.nullable(),
  received: money.nullable(),
  booking: z
    .object({ token: z.string(), customerName: z.string().nullable(), phoneLast4: z.string(), slotStart: isoInstant })
    .nullable(),
});
export type Flag = z.infer<typeof flagSchema>;

/** A deposit confirmed in the last minutes, for any day: the board announces each one once. */
const recentlyPaid = z.object({
  token: z.string(),
  slotStart: isoInstant,
  customerName: z.string().nullable(),
  bankName: z.string().nullable(),
  confirmedAt: isoInstant,
});
export type RecentlyPaid = z.infer<typeof recentlyPaid>;

export const boardSchema = z.object({
  date: z.string(),
  slots: z.array(slotRange.extend({ booking: ownerBooking.nullable() })),
  flags: z.array(flagSchema),
  recent: z.array(recentlyPaid),
});
export type Board = z.infer<typeof boardSchema>;
export type BoardSlot = Board['slots'][number];

export const verifySchema = ownerBooking;
export type VerifyView = OwnerBooking;

export const checkInSchema = z.object({ checkedInAt: isoInstant });

const problemSchema = z.looseObject({
  title: z.string().optional(),
  status: z.number().optional(),
  detail: z.string().optional(),
  checkedInAt: isoInstant.optional(),
});
export type Problem = z.infer<typeof problemSchema>;

export const HTTP_UNAUTHORIZED = 401;
export const HTTP_NOT_FOUND = 404;
export const HTTP_CONFLICT = 409;
const NETWORK_FAILURE_STATUS = 0;
const FALLBACK_DETAIL = 'Algo salió mal. Intenta de nuevo.';
const OFFLINE_DETAIL = 'Sin conexión. Revisa tu internet e intenta de nuevo.';

/** A failed request: `detail` is safe to show the user; `status` is 0 when the network failed. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly detail: string,
    readonly problem: Problem | null,
  ) {
    super(detail);
  }
}

const METHOD = { get: 'GET', post: 'POST', delete: 'DELETE' } as const;
type Method = (typeof METHOD)[keyof typeof METHOD];

interface RequestOptions {
  readonly method?: Method;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

async function request<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? METHOD.get,
      headers,
      credentials: 'same-origin',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(NETWORK_FAILURE_STATUS, OFFLINE_DETAIL, null);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = problemSchema.safeParse(payload);
    const parsed = problem.success ? problem.data : null;
    throw new ApiError(response.status, parsed?.detail ?? FALLBACK_DETAIL, parsed);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    console.error(`Respuesta inesperada de ${path}`, parsed.error);
    throw new ApiError(response.status, FALLBACK_DETAIL, null);
  }
  return parsed.data;
}

const anyBody = z.unknown();
const enc = encodeURIComponent;

export const API_PATH = {
  slots: (date: string) => `/api/slots?date=${enc(date)}`,
  bookings: '/api/bookings',
  booking: (token: string) => `/api/bookings/${enc(token)}`,
  bookingQr: (token: string) => `/api/bookings/${enc(token)}/qr`,
  bookingEvents: (token: string) => `/api/bookings/${enc(token)}/events`,
  checkIn: (token: string) => `/api/bookings/${enc(token)}/check-in`,
  session: '/api/session',
  board: (date?: string) => (date === undefined ? '/api/board' : `/api/board?date=${enc(date)}`),
  boardEvents: '/api/board/events',
  verify: (token: string) => `/api/verify/${enc(token)}`,
  resolveFlag: (id: string) => `/api/flags/${enc(id)}/resolve`,
} as const;

export const api = {
  slots: (date: string, signal?: AbortSignal) =>
    request(API_PATH.slots(date), slotsSchema, signal === undefined ? {} : { signal }),
  hold: (body: { slotStart: string; phone: string; customerName?: string }, idempotencyKey: string) =>
    request(API_PATH.bookings, holdSchema, { method: METHOD.post, body, idempotencyKey }),
  booking: (token: string) => request(API_PATH.booking(token), bookingSchema),
  /** Sends no body: an empty body declared as JSON is rejected with 400. */
  startQr: (token: string, idempotencyKey: string) =>
    request(API_PATH.bookingQr(token), qrSchema, { method: METHOD.post, idempotencyKey }),
  login: (pin: string) => request(API_PATH.session, anyBody, { method: METHOD.post, body: { pin } }),
  logout: () => request(API_PATH.session, anyBody, { method: METHOD.delete }),
  board: (date?: string) => request(API_PATH.board(date), boardSchema),
  verify: (token: string) => request(API_PATH.verify(token), verifySchema),
  checkIn: (token: string) => request(API_PATH.checkIn(token), checkInSchema, { method: METHOD.post }),
  resolveFlag: (id: string, note: string) =>
    request(API_PATH.resolveFlag(id), anyBody, { method: METHOD.post, body: { note } }),
};
