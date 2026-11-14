import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export interface TimeRange {
  readonly start: Date;
  readonly end: Date;
}

/** `tstzrange`, half-open `[start,end)`. */
export const tstzrange = customType<{ data: TimeRange; driverData: string }>({
  dataType: () => 'tstzrange',
  toDriver: ({ start, end }) => `[${start.toISOString()},${end.toISOString()})`,
  fromDriver: (value) => {
    const match = /^[[(]"?([^",]+)"?,"?([^",]+)"?[\])]$/.exec(value);
    if (!match?.[1] || !match[2]) throw new Error('Unparseable tstzrange from database');
    return { start: new Date(match[1]), end: new Date(match[2]) };
  },
});

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const tstz = (name: string) => timestamp(name, { withTimezone: true });

/** 7 digits at most: the number doubles as the rail's `numRef`. Exhaustion fails loudly. */
export const bookingNumberSeq = pgSequence('booking_number_seq', {
  startWith: 1,
  minValue: 1,
  maxValue: 9_999_999,
  cycle: false,
});

export const business = pgTable('business', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  serviceName: text('service_name').notNull(),
  serviceMinutes: integer('service_minutes').notNull(),
  depositMinor: integer('deposit_minor').notNull(),
  currency: text('currency').notNull().default('MXN'),
  slotMinutes: integer('slot_minutes').notNull(),
  timezone: text('timezone').notNull().default('America/Mexico_City'),
  hours: jsonb('hours').notNull(),
  createdAt: createdAt(),
});

export const resources = pgTable('resources', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => business.id),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const paymentIntents = pgTable(
  'payment_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reference: text('reference').notNull().unique(),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull().default('MXN'),
    status: text('status').notNull().default('requires_payment'),
    succeededAt: tstz('succeeded_at'),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'payment_intents_status_check',
      sql`${t.status} IN ('requires_payment','processing','succeeded','expired','canceled')`,
    ),
    check('payment_intents_amount_check', sql`${t.amountMinor} > 0`),
  ],
);

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    number: integer('number')
      .notNull()
      .unique()
      .default(sql`nextval('booking_number_seq')`),
    token: text('token').notNull().unique(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => business.id),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => resources.id),
    intentId: uuid('intent_id').references(() => paymentIntents.id),
    slotStart: tstz('slot_start').notNull(),
    during: tstzrange('during').notNull(),
    status: text('status').notNull().default('holding'),
    customerName: text('customer_name'),
    phoneLast4: char('phone_last4', { length: 4 }).notNull(),
    phoneHash: text('phone_hash').notNull(),
    late: boolean('late').notNull().default(false),
    holdExpiresAt: tstz('hold_expires_at'),
    confirmedAt: tstz('confirmed_at'),
    checkedInAt: tstz('checked_in_at'),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'bookings_status_check',
      sql`${t.status} IN ('holding','confirmed','checked_in','expired','canceled')`,
    ),
    check(
      'bookings_during_check',
      sql`NOT isempty(${t.during}) AND lower(${t.during}) = ${t.slotStart}`,
    ),
    index('bookings_phone_hash_idx').on(t.phoneHash),
    index('bookings_status_hold_expires_idx').on(t.status, t.holdExpiresAt),
    uniqueIndex('bookings_one_holding_per_phone_idx').on(t.phoneHash).where(sql`${t.status} = 'holding'`),
  ],
);

export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => paymentIntents.id),
    mode: text('mode').notNull(),
    providerTxId: text('provider_tx_id'),
    providerQrId: text('provider_qr_id'),
    codiId: text('codi_id'),
    status: text('status').notNull().default('awaiting'),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('payment_attempts_mode_check', sql`${t.mode} IN ('push','qr')`),
    check(
      'payment_attempts_status_check',
      sql`${t.status} IN ('awaiting','succeeded','expired','failed')`,
    ),
    index('payment_attempts_intent_idx').on(t.intentId),
    index('payment_attempts_provider_tx_idx').on(t.providerTxId),
    index('payment_attempts_provider_qr_idx').on(t.providerQrId),
  ],
);

export const paymentEvents = pgTable('payment_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  attemptId: uuid('attempt_id').references(() => paymentAttempts.id),
  intentId: uuid('intent_id').references(() => paymentIntents.id),
  providerTxId: text('provider_tx_id').notNull().unique(),
  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull().default('MXN'),
  trackingKey: text('tracking_key'),
  late: boolean('late').notNull().default(false),
  raw: jsonb('raw').notNull(),
  createdAt: createdAt(),
});

export const webhookInbox = pgTable('webhook_inbox', {
  webhookId: text('webhook_id').primaryKey(),
  eventType: text('event_type').notNull(),
  receivedAt: tstz('received_at').notNull().defaultNow(),
  processedAt: tstz('processed_at'),
  outcome: text('outcome'),
});

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').notNull(),
    scope: text('scope').notNull(),
    requestHash: text('request_hash').notNull(),
    responseCode: integer('response_code'),
    responseBody: jsonb('response_body'),
    recoveryPoint: text('recovery_point'),
    lockedAt: tstz('locked_at'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.key, t.scope] })],
);

export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    topic: text('topic').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
    publishedAt: tstz('published_at'),
  },
  (t) => [index('outbox_unpublished_idx').on(t.createdAt).where(sql`${t.publishedAt} IS NULL`)],
);

export const flags = pgTable(
  'flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    bookingId: uuid('booking_id').references(() => bookings.id),
    payload: jsonb('payload').notNull(),
    note: text('note'),
    resolvedAt: tstz('resolved_at'),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'flags_kind_check',
      sql`${t.kind} IN ('unmatched_payment','refund_due','amount_mismatch')`,
    ),
  ],
);
