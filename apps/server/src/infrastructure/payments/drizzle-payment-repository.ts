import {
  AttemptMode,
  AttemptStatus,
  InsertResult,
  IntentStatus,
  money,
  type AttemptLookup,
  type AttemptMatch,
  type Money,
  type PaymentAttempt,
  type PaymentIntent,
  type PaymentRepository,
} from '@pialy/payments';
import { and, eq, ne, type SQL } from 'drizzle-orm';
import type { DbTx } from '../db/client.js';
import { paymentAttempts, paymentEvents, paymentIntents } from '../db/schema.js';

type IntentRow = typeof paymentIntents.$inferSelect;
type AttemptRow = typeof paymentAttempts.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPPORTED_CURRENCY = 'MXN';
/** Fetching two rows is enough to tell a unique match from an ambiguous one. */
const AMBIGUITY_PROBE = 2;

export function createDrizzlePaymentRepository(tx: DbTx): PaymentRepository {
  return {
    async findAttemptByRef(lookup) {
      const found = await findAttemptKeys(tx, lookup);
      if (found === null) return null;
      // Lock first, then read the attempt: a read joined to the lock could see a stale attempt.
      const [intent] = await tx
        .select()
        .from(paymentIntents)
        .where(eq(paymentIntents.id, found.intentId))
        .for('update');
      const [attempt] = await tx.select().from(paymentAttempts).where(eq(paymentAttempts.id, found.id));
      if (!intent || !attempt) throw new Error(`attempt ${found.id} vanished while it was being locked`);
      return toMatch(intent, attempt);
    },

    async hasOtherAwaiting(intentId, exceptAttemptId) {
      const rows = await tx
        .select({ id: paymentAttempts.id })
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.intentId, intentId),
            ne(paymentAttempts.id, exceptAttemptId),
            eq(paymentAttempts.status, AttemptStatus.Awaiting),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async insertPaymentEvent(event) {
      const inserted = await tx
        .insert(paymentEvents)
        .values({
          providerTxId: event.providerTxId,
          intentId: event.intentId,
          attemptId: event.attemptId,
          amountMinor: event.amount.amountMinor,
          currency: event.amount.currency,
          trackingKey: event.trackingKey ?? null,
          late: event.late,
          raw: event.raw,
        })
        .onConflictDoNothing({ target: paymentEvents.providerTxId })
        .returning({ id: paymentEvents.id });
      return inserted.length === 0 ? InsertResult.Duplicate : InsertResult.Inserted;
    },

    async saveIntent(intent) {
      const saved = await tx
        .update(paymentIntents)
        .set({ status: intent.status, succeededAt: intent.succeededAt })
        .where(eq(paymentIntents.id, intent.id))
        .returning({ id: paymentIntents.id });
      if (saved.length === 0) throw new Error(`intent ${intent.id} does not exist`);
    },

    async saveAttempt(attempt) {
      const saved = await tx
        .update(paymentAttempts)
        .set({
          status: attempt.status,
          providerTxId: attempt.provider.transactionId ?? null,
          providerQrId: attempt.provider.qrId ?? null,
          codiId: attempt.provider.codiId ?? null,
        })
        .where(eq(paymentAttempts.id, attempt.id))
        .returning({ id: paymentAttempts.id });
      if (saved.length === 0) throw new Error(`attempt ${attempt.id} does not exist`);
    },
  };
}

async function findAttemptKeys(
  tx: DbTx,
  lookup: AttemptLookup,
): Promise<{ id: string; intentId: string } | null> {
  const condition = lookupCondition(lookup);
  if (condition === null) return null;
  const rows = await tx
    .select({ id: paymentAttempts.id, intentId: paymentAttempts.intentId })
    .from(paymentAttempts)
    .where(condition)
    .limit(AMBIGUITY_PROBE);
  if (rows.length > 1) throw new Error(`more than one attempt matches ${JSON.stringify(lookup)}`);
  return rows[0] ?? null;
}

/** `null` when the key cannot belong to one of our attempts. */
function lookupCondition(lookup: AttemptLookup): SQL | null {
  if ('transactionId' in lookup) return eq(paymentAttempts.providerTxId, lookup.transactionId);
  if ('qrId' in lookup) return eq(paymentAttempts.providerQrId, lookup.qrId);
  // Attempt ids are uuids; anything else in the rail's metadata would make Postgres reject the query.
  return UUID.test(lookup.attemptId) ? eq(paymentAttempts.id, lookup.attemptId) : null;
}

function toMatch(intent: IntentRow, attempt: AttemptRow): AttemptMatch {
  return {
    intent: {
      id: intent.id,
      reference: intent.reference,
      amount: toMoney(intent.amountMinor, intent.currency),
      status: oneOf(IntentStatus, intent.status, 'intent status'),
      succeededAt: intent.succeededAt,
    } satisfies PaymentIntent,
    attempt: {
      id: attempt.id,
      intentId: attempt.intentId,
      mode: oneOf(AttemptMode, attempt.mode, 'attempt mode'),
      status: oneOf(AttemptStatus, attempt.status, 'attempt status'),
      expiresAt: attempt.expiresAt,
      provider: {
        ...(attempt.providerTxId === null ? {} : { transactionId: attempt.providerTxId }),
        ...(attempt.providerQrId === null ? {} : { qrId: attempt.providerQrId }),
        ...(attempt.codiId === null ? {} : { codiId: attempt.codiId }),
      },
    } satisfies PaymentAttempt,
  };
}

function toMoney(amountMinor: number, currency: string): Money {
  if (currency !== SUPPORTED_CURRENCY) throw new Error(`unsupported currency ${currency}`);
  return money(amountMinor);
}

function oneOf<T extends string>(allowed: Readonly<Record<string, T>>, value: string, what: string): T {
  const match = Object.values(allowed).find((candidate) => candidate === value);
  if (match === undefined) throw new Error(`unknown ${what} ${value}`);
  return match;
}
