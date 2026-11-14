import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  AttemptMode,
  IntentStatus,
  RailRejectedError,
  RailUnavailableError,
  startAttempt,
  type Clock,
  type Money,
  type PaymentAttempt,
  type PaymentIntent,
  type RailConnector,
} from '@pialy/payments';
import { HOLD_SECONDS } from '../domain/booking.js';
import { normalizeMxPhone, phoneLast4 } from '../domain/phone.js';
import { bookableSlot, type Slot } from '../domain/slots.js';
import type { BookableBusiness } from './business.js';

export const HOLD_SCOPE = 'hold';
export const PUSH_CONCEPT = 'Anticipo Estudio Demo';
export const PUSH_FAILED_DETAIL = 'No pudimos enviar la solicitud. Intenta de nuevo o paga con QR.';
export const PUSH_FAILED_TYPE = 'urn:pialy:problem:push-failed';

/**
 * A request that still holds its key after this long is taken as dead. The slowest pey create
 * call (3 tries of 8 s plus backoff) ends well before it.
 */
export const IN_FLIGHT_TIMEOUT_MS = 60_000;

const TOKEN_BYTES = 16;
const MS_PER_SECOND = 1000;

/** HTTP statuses a hold answers with once its key is finished. */
export const HoldStatus = { Held: 201, PushFailed: 502 } as const;

export interface HeldBody {
  readonly token: string;
  readonly holdExpiresAt: string;
}

export interface PushFailedProblem {
  readonly type: string;
  readonly title: string;
  readonly status: typeof HoldStatus.PushFailed;
  readonly detail: string;
}

/** What `POST /api/bookings` answers; stored on the idempotency key and replayed as is. */
export type HoldResponse =
  | { readonly status: typeof HoldStatus.Held; readonly body: HeldBody }
  | { readonly status: typeof HoldStatus.PushFailed; readonly body: PushFailedProblem };

export const PUSH_FAILED: HoldResponse = {
  status: HoldStatus.PushFailed,
  body: { type: PUSH_FAILED_TYPE, title: 'Bad Gateway', status: HoldStatus.PushFailed, detail: PUSH_FAILED_DETAIL },
};

/** The key was already used for a different request. */
export class IdempotencyKeyReusedError extends Error {
  override readonly name = 'IdempotencyKeyReusedError';

  constructor() {
    super('idempotency key was already used with a different request');
  }
}

/** Another request with the same key is still running. */
export class IdempotencyKeyInFlightError extends Error {
  override readonly name = 'IdempotencyKeyInFlightError';

  constructor() {
    super('a request with this idempotency key is still in flight');
  }
}

export interface NewHold {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly now: Date;
  /** A key locked before this instant belongs to a request that died. */
  readonly staleBefore: Date;
  readonly business: BookableBusiness;
  readonly slot: Slot;
  readonly intent: PaymentIntent;
  readonly attempt: PaymentAttempt;
  readonly booking: {
    readonly id: string;
    readonly token: string;
    readonly customerName: string | null;
    readonly phoneLast4: string;
    readonly phoneHash: string;
    readonly holdExpiresAt: Date;
  };
  /** The answer once the push is sent; staged on the key so a recovery can rebuild the hold. */
  readonly response: HoldResponse;
}

export interface HoldRef {
  readonly idempotencyKey: string;
  readonly bookingId: string;
  readonly attemptId: string;
}

export type BeganHold =
  | { readonly kind: 'started'; readonly hold: HoldRef; readonly bookingNumber: number }
  | { readonly kind: 'replay'; readonly response: HoldResponse }
  /** The request that created this hold died before it finished; whether its push went out is unknown. */
  | { readonly kind: 'abandoned'; readonly hold: HoldRef };

/** The atomic phases around the rail call (Brandur's idempotency keys); each method is one transaction. */
export interface HoldRepository {
  /**
   * Claims the key and, for a new key, creates intent `processing`, booking `holding` and attempt
   * `awaiting` with recovery point `hold_created`. Throws {@link SlotTakenError},
   * {@link IdempotencyKeyReusedError} or {@link IdempotencyKeyInFlightError}.
   */
  begin(hold: NewHold): Promise<BeganHold>;
  /** Stores the rail's ids on the attempt and finishes the key with the staged response. */
  recordPush(hold: HoldRef, charge: { readonly transactionId: string; readonly codiId: string }): Promise<HoldResponse>;
  /**
   * Fails the attempt (kept, so a late payment still matches it), expires the booking and finishes
   * the key with `failed`; answers the staged response instead when the attempt was already paid.
   */
  failPush(hold: HoldRef, failed: HoldResponse): Promise<HoldResponse>;
}

/** Structured logger; pino and Fastify's request logger fit. */
export interface HoldLogger {
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

export interface HoldSlotDeps {
  readonly holds: HoldRepository;
  readonly rail: Pick<RailConnector, 'createPushCharge'>;
  readonly clock: Clock;
  readonly business: BookableBusiness;
  /** Fixed server side; no request carries an amount. */
  readonly deposit: Money;
  readonly phoneHashSalt: string;
  readonly log: HoldLogger;
}

export interface HoldSlotInput {
  readonly slotStart: Date;
  /** As typed by the customer. Lives only in memory, for the rail call. */
  readonly phone: string;
  readonly customerName?: string | undefined;
  readonly idempotencyKey: string;
}

/**
 * Holds a slot for {@link HOLD_SECONDS} and asks the customer's bank for the deposit by CoDi push.
 * The same key with the same request answers the stored response without a second push. Throws
 * {@link InvalidPhoneError}, {@link SlotNotOfferedError}, {@link SlotTakenError} and the key errors.
 */
export async function holdSlotAndCharge(deps: HoldSlotDeps, input: HoldSlotInput): Promise<HoldResponse> {
  const now = deps.clock.now();
  const phone10 = normalizeMxPhone(input.phone);
  const slot = bookableSlot(input.slotStart, deps.business, deps.business.timezone, now);
  const phoneHash = hashPhone(deps.phoneHashSalt, phone10);
  const customerName = input.customerName?.trim() || null;

  const begun = await deps.holds.begin(
    newHold(deps, input.idempotencyKey, now, slot, {
      phoneHash,
      phoneLast4: phoneLast4(phone10),
      customerName,
      requestHash: fingerprint(slot, phoneHash, customerName),
    }),
  );
  switch (begun.kind) {
    case 'replay':
      return begun.response;
    case 'abandoned':
      deps.log.warn({ bookingId: begun.hold.bookingId, attemptId: begun.hold.attemptId }, 'ending an abandoned hold');
      return deps.holds.failPush(begun.hold, PUSH_FAILED);
    case 'started':
      return sendPush(deps, begun.hold, begun.bookingNumber, phone10);
  }
}

/** HMAC-SHA256 of the 10-digit number, hex: lets a phone be matched without storing it. */
export function hashPhone(salt: string, phone10: string): string {
  return createHmac('sha256', salt).update(phone10).digest('hex');
}

interface Customer {
  readonly phoneHash: string;
  readonly phoneLast4: string;
  readonly customerName: string | null;
  readonly requestHash: string;
}

function newHold(deps: HoldSlotDeps, idempotencyKey: string, now: Date, slot: Slot, customer: Customer): NewHold {
  const holdExpiresAt = new Date(now.getTime() + HOLD_SECONDS * MS_PER_SECOND);
  const bookingId = randomUUID();
  const { intent, attempt } = startAttempt(
    {
      id: randomUUID(),
      reference: `booking:${bookingId}`,
      amount: deps.deposit,
      status: IntentStatus.RequiresPayment,
      succeededAt: null,
    },
    AttemptMode.Push,
    randomUUID(),
    holdExpiresAt,
  );
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return {
    idempotencyKey,
    requestHash: customer.requestHash,
    now,
    staleBefore: new Date(now.getTime() - IN_FLIGHT_TIMEOUT_MS),
    business: deps.business,
    slot,
    intent,
    attempt,
    booking: {
      id: bookingId,
      token,
      customerName: customer.customerName,
      phoneLast4: customer.phoneLast4,
      phoneHash: customer.phoneHash,
      holdExpiresAt,
    },
    response: { status: HoldStatus.Held, body: { token, holdExpiresAt: holdExpiresAt.toISOString() } },
  };
}

async function sendPush(deps: HoldSlotDeps, hold: HoldRef, bookingNumber: number, phone10: string): Promise<HoldResponse> {
  let charge: { transactionId: string; codiId: string };
  try {
    charge = await deps.rail.createPushCharge({
      amount: deps.deposit,
      phone10,
      concept: PUSH_CONCEPT,
      expiresInSec: HOLD_SECONDS,
      numRef: String(bookingNumber),
      metadata: { bookingId: hold.bookingId, attemptId: hold.attemptId },
    });
  } catch (error) {
    // The call may have reached the bank, so pushing again could charge twice: the hold ends here.
    logPushFailure(deps.log, hold, error);
    return deps.holds.failPush(hold, PUSH_FAILED);
  }
  return deps.holds.recordPush(hold, charge);
}

function logPushFailure(log: HoldLogger, hold: HoldRef, error: unknown): void {
  const context = { err: error, bookingId: hold.bookingId, attemptId: hold.attemptId };
  if (error instanceof RailRejectedError || error instanceof RailUnavailableError) {
    log.warn(context, 'codi push failed');
  } else {
    log.error(context, 'codi push failed unexpectedly');
  }
}

function fingerprint(slot: Slot, phoneHash: string, customerName: string | null): string {
  return createHash('sha256').update(JSON.stringify([slot.start.toISOString(), phoneHash, customerName])).digest('hex');
}
