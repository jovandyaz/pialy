"""Tables of spec §6 and their invariants, every tenant row keyed by its business.

Revision ID: 0001
Revises:
Create Date: 2026-11-21

Rules the tables follow (tests/db/test_schema.py checks each one):
- A tenant table has `business_id uuid NOT NULL REFERENCES business (id)`, its keys and indexes
  lead with it, and its unique keys hold within one business. Foreign key checks bypass
  row-level security, so a row points at another table through `(business_id, id)` and can never
  name a row of another business.
- Money is `bigint` minor units with a three-letter uppercase ISO 4217 code, and repeats the
  payments-core invariants: amounts are positive, `paid_total_minor` never exceeds the amount and
  agrees with the status.
- Personal data is stored as hashes and last digits only: the phone as an HMAC-SHA256 hex digest
  and its last 4 digits, session and invitation tokens as SHA-256 digests. Of pey's payment
  payload only an allowlisted projection is kept, each field of its documented type and shape,
  the payer's account masked to its last 4 characters.
- Text columns are `text` with a CHECK, never `char(n)` (wiki.postgresql.org, "Don't Do This").
- Constraints are NOT DEFERRABLE (the default), as `INSERT ... ON CONFLICT` arbiters must be.

Row-level security, grants and definer functions come in 0002; the agent's tables in layer 2.
"""

from decimal import Decimal
from importlib.resources import files

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

CURRENCY = r"~ '^[A-Z]{3}$'"

# Shapes of the fields payment_events.raw keeps from pey's payment payload (docs.pey.mx, API
# 2026-10-20), matched against their text (`#>>`). A value outside them fails the insert with
# 23514 rather than being stored; relaxing a shape takes a new revision.
# transactionId and codiQrId: ids pey assigns (today a ULID and the 10 hex digits of the CoDi
# QR), taken as opaque strings so that pey changing their format never drops a payment. Digits
# alone are refused: that is the shape of a phone or a CLABE.
PROVIDER_ID = r"^[0-9A-Za-z_-]{8,64}$"
DIGITS_ONLY = r"^[0-9]+$"
# amount: pesos as pey sends them, to the centavo, under 10 million: far above any CoDi payment
# and below a 10-digit phone written as a number.
AMOUNT_BELOW = 10_000_000
# datePaid: integer Unix seconds (pey's fixtures: 1790724818 is 2026-09-29), from 2020-01-01 up
# to 2100-01-01. Milliseconds, or a phone (5512345678 is in 2144) or a CLABE as a number, fall out.
DATE_PAID_FROM = 1_577_836_800
DATE_PAID_BELOW = 4_102_444_800
# metadata.bankCode: the payer's bank, by its 3-digit code (as in a CLABE) or 5-digit SPEI one.
BANK_CODE = r"^[0-9]{3,5}$"
# metadata.trackingKey: the SPEI clave de rastreo, up to 30 alphanumeric characters
# (banxico.org.mx/cep). A 10-digit key has the shape of a phone and is accepted all the same;
# 15 digits or more alone are refused, the length of a CLABE (18) or a card number (15 to 19).
TRACKING_KEY = r"^[0-9A-Za-z]{1,30}$"
ACCOUNT_NUMBER = r"^[0-9]{15,}$"
# metadata.attemptId: the id pialy gave the attempt, a UUID in canonical (lowercase) form.
UUID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"


def member(
    path: str, types: tuple[str, ...], shape: str | None = None, unless: str | None = None
) -> str:
    """SQL that holds when raw has nothing at path, or a value of a JSON type in types whose
    text matches shape and not unless. A JSON null is neither, so it fails."""
    value = f"raw #> '{{{path}}}'"
    text = f"raw #>> '{{{path}}}'"
    kinds = ", ".join(f"'{kind}'" for kind in types)
    tests = [f"{text} ~ '{shape}'"] if shape else []
    tests += [f"{text} !~ '{unless}'"] if unless else []
    matches = " AND ".join(tests) or "true"
    return f"CASE WHEN jsonb_typeof({value}) IN ({kinds}) THEN {matches} ELSE {value} IS NULL END"


def number(key: str, least: Decimal | int, below: int, places: int) -> str:
    """SQL that holds when raw has no key, or a number from least up to (not including) below,
    with at most places decimals. CASE keeps the cast, which raises on a non-number, guarded."""
    value = f"(raw -> '{key}')::numeric"
    return (
        f"CASE jsonb_typeof(raw -> '{key}') WHEN 'number' THEN {value} >= {least}"
        f" AND {value} < {below} AND {value} = trunc({value}, {places})"
        f" ELSE raw -> '{key}' IS NULL END"
    )


STATEMENTS = (
    # Trusted since PostgreSQL 13, so the database owner may create it without a superuser.
    "CREATE EXTENSION IF NOT EXISTS btree_gist",
    rf"""
    CREATE TABLE business (
        id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        slug                text        NOT NULL
            CONSTRAINT business_slug_key UNIQUE
            CONSTRAINT business_slug_check
                CHECK (slug ~ '^[a-z0-9](-?[a-z0-9])*$' AND length(slug) BETWEEN 3 AND 40),
        name                text        NOT NULL,
        service_name        text        NOT NULL,
        service_minutes     integer     NOT NULL,
        slot_minutes        integer     NOT NULL,
        deposit_minor       bigint      NOT NULL
            CONSTRAINT business_deposit_check CHECK (deposit_minor > 0),
        currency            text        NOT NULL DEFAULT 'MXN'
            CONSTRAINT business_currency_check CHECK (currency {CURRENCY}),
        timezone            text        NOT NULL DEFAULT 'America/Mexico_City',
        hours               jsonb       NOT NULL,
        accepting_bookings  boolean     NOT NULL DEFAULT false,
        -- The next booking number to hand out, taken under this row's lock. Numbers have at most
        -- 7 digits because the number doubles as the rail's numeric reference, so 10000000 means
        -- every number is used and the next hold fails here instead of wrapping around.
        next_booking_number integer     NOT NULL DEFAULT 1
            CONSTRAINT business_next_booking_number_check
                CHECK (next_booking_number BETWEEN 1 AND 10000000),
        created_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT business_minutes_check CHECK (service_minutes > 0 AND slot_minutes > 0)
    )
    """,
    """
    CREATE TABLE resources (
        business_id uuid        NOT NULL
            CONSTRAINT resources_business_id_fkey REFERENCES business (id),
        id          uuid        NOT NULL DEFAULT gen_random_uuid(),
        name        text        NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT resources_pkey PRIMARY KEY (business_id, id)
    )
    """,
    # payments-core PaymentIntent; its applied_event_ids are the payment_events of the intent.
    rf"""
    CREATE TABLE payment_intents (
        business_id      uuid        NOT NULL
            CONSTRAINT payment_intents_business_id_fkey REFERENCES business (id),
        id               uuid        NOT NULL DEFAULT gen_random_uuid(),
        principal_id     uuid        NOT NULL,
        reference        text        NOT NULL,
        idempotency_key  text        NOT NULL,
        amount_minor     bigint      NOT NULL
            CONSTRAINT payment_intents_amount_check CHECK (amount_minor > 0),
        currency         text        NOT NULL
            CONSTRAINT payment_intents_currency_check CHECK (currency {CURRENCY}),
        status           text        NOT NULL DEFAULT 'pending'
            CONSTRAINT payment_intents_status_check
                CHECK (status IN ('pending', 'partially_paid', 'paid', 'expired')),
        paid_total_minor bigint      NOT NULL DEFAULT 0,
        late             boolean     NOT NULL DEFAULT false,
        created_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payment_intents_pkey PRIMARY KEY (business_id, id),
        CONSTRAINT payment_intents_reference_key UNIQUE (business_id, reference),
        CONSTRAINT payment_intents_idempotency_key_key UNIQUE (business_id, idempotency_key),
        CONSTRAINT payment_intents_principal_check CHECK (principal_id = business_id),
        -- Unknown statuses are payment_intents_status_check's to reject, hence ELSE.
        CONSTRAINT payment_intents_paid_total_check CHECK (
            CASE status
                WHEN 'paid' THEN paid_total_minor = amount_minor
                WHEN 'partially_paid' THEN paid_total_minor > 0 AND paid_total_minor < amount_minor
                ELSE paid_total_minor = 0
            END
        )
    )
    """,
    # payments-core Attempt. Its amount is in the intent's currency (a payments-core invariant),
    # so it has no currency of its own; NULL means the payer sets it (open QR). failed_at feeds
    # the API's `failed`, which payments-core has no status for. created_at is the Attempt's, from
    # the injected Clock (expires_at is checked against it), so the database supplies no default.
    """
    CREATE TABLE payment_attempts (
        business_id  uuid        NOT NULL
            CONSTRAINT payment_attempts_business_id_fkey REFERENCES business (id),
        id           uuid        NOT NULL DEFAULT gen_random_uuid(),
        intent_id    uuid        NOT NULL,
        rail         text        NOT NULL
            CONSTRAINT payment_attempts_rail_check CHECK (rail IN ('codi_push', 'codi_qr')),
        provider_ref text,
        codi_id      text,
        amount_minor bigint
            CONSTRAINT payment_attempts_amount_check CHECK (amount_minor > 0),
        status       text        NOT NULL DEFAULT 'requested'
            CONSTRAINT payment_attempts_status_check
                CHECK (status IN ('requested', 'ambiguous', 'paid', 'expired')),
        failed_at    timestamptz,
        created_at   timestamptz NOT NULL,
        expires_at   timestamptz NOT NULL,
        CONSTRAINT payment_attempts_pkey PRIMARY KEY (business_id, id),
        CONSTRAINT payment_attempts_intent_fkey FOREIGN KEY (business_id, intent_id)
            REFERENCES payment_intents (business_id, id),
        -- Target of payment_events_attempt_fkey; also lists an intent's attempts.
        CONSTRAINT payment_attempts_intent_attempt_key UNIQUE (business_id, intent_id, id),
        -- A payment is matched to its attempt by this reference, so it names one attempt.
        CONSTRAINT payment_attempts_provider_ref_key UNIQUE (business_id, provider_ref),
        CONSTRAINT payment_attempts_expiry_check CHECK (expires_at > created_at)
    )
    """,
    """
    CREATE TABLE bookings (
        business_id     uuid        NOT NULL
            CONSTRAINT bookings_business_id_fkey REFERENCES business (id),
        id              uuid        NOT NULL DEFAULT gen_random_uuid(),
        number          integer     NOT NULL
            CONSTRAINT bookings_number_check CHECK (number BETWEEN 1 AND 9999999),
        token           text        NOT NULL,
        resource_id     uuid        NOT NULL,
        intent_id       uuid,
        slot_start      timestamptz NOT NULL,
        during          tstzrange   NOT NULL,
        status          text        NOT NULL DEFAULT 'holding'
            CONSTRAINT bookings_status_check
                CHECK (status IN ('holding', 'confirmed', 'checked_in', 'expired', 'canceled')),
        customer_name   text,
        phone_last4     text        NOT NULL
            CONSTRAINT bookings_phone_last4_check CHECK (phone_last4 ~ '^[0-9]{4}$'),
        phone_hash      text        NOT NULL
            CONSTRAINT bookings_phone_hash_check CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
        late            boolean     NOT NULL DEFAULT false,
        hold_expires_at timestamptz,
        confirmed_at    timestamptz,
        checked_in_at   timestamptz,
        created_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT bookings_pkey PRIMARY KEY (business_id, id),
        CONSTRAINT bookings_resource_fkey FOREIGN KEY (business_id, resource_id)
            REFERENCES resources (business_id, id),
        CONSTRAINT bookings_intent_fkey FOREIGN KEY (business_id, intent_id)
            REFERENCES payment_intents (business_id, id),
        CONSTRAINT bookings_number_key UNIQUE (business_id, number),
        CONSTRAINT bookings_token_key UNIQUE (business_id, token),
        CONSTRAINT bookings_during_check CHECK (
            NOT isempty(during)
            AND lower(during) = slot_start
            AND lower_inc(during) AND NOT upper_inc(during) AND NOT upper_inf(during)
        ),
        CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
            business_id WITH =, resource_id WITH =, during WITH &&
        ) WHERE (status IN ('holding', 'confirmed', 'checked_in'))
    )
    """,
    """
    CREATE UNIQUE INDEX bookings_one_holding_per_phone_idx
        ON bookings (business_id, phone_hash) WHERE status = 'holding'
    """,
    """
    CREATE INDEX bookings_holding_expiry_idx
        ON bookings (business_id, hold_expires_at) WHERE status = 'holding'
    """,
    # Applying a payment reacts on the booking of the intent it paid.
    "CREATE INDEX bookings_intent_idx ON bookings (business_id, intent_id)",
    # A payment pey reported: matched to an attempt of its intent, or an orphan (neither).
    rf"""
    CREATE TABLE payment_events (
        business_id       uuid        NOT NULL
            CONSTRAINT payment_events_business_id_fkey REFERENCES business (id),
        id                uuid        NOT NULL DEFAULT gen_random_uuid(),
        intent_id         uuid,
        attempt_id        uuid,
        provider_event_id text        NOT NULL,
        provider_ref      text        NOT NULL,
        amount_minor      bigint      NOT NULL
            CONSTRAINT payment_events_amount_check CHECK (amount_minor > 0),
        currency          text        NOT NULL
            CONSTRAINT payment_events_currency_check CHECK (currency {CURRENCY}),
        -- The SPEI clave de rastreo raw keeps as metadata.trackingKey, under the same rule.
        tracking_key      text
            CONSTRAINT payment_events_tracking_key_check CHECK (
                tracking_key IS NULL
                OR (tracking_key ~ '{TRACKING_KEY}' AND tracking_key !~ '{ACCOUNT_NUMBER}')
            ),
        late              boolean     NOT NULL DEFAULT false,
        raw               jsonb       NOT NULL,
        created_at        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payment_events_pkey PRIMARY KEY (business_id, id),
        CONSTRAINT payment_events_provider_event_id_key UNIQUE (business_id, provider_event_id),
        CONSTRAINT payment_events_match_check CHECK ((intent_id IS NULL) = (attempt_id IS NULL)),
        CONSTRAINT payment_events_attempt_fkey FOREIGN KEY (business_id, intent_id, attempt_id)
            REFERENCES payment_attempts (business_id, intent_id, id),
        -- metadata.clabe is the payer's account (or phone): only its last 4 characters stay.
        CONSTRAINT payment_events_clabe_check
            CHECK (raw #>> '{{metadata,clabe}}' ~ '^\**.{{0,4}}$'),
        -- raw is a projection of pey's payload, never the body as received: the fields a
        -- PeyPaymentEvent reads, under pey's names (attemptId lifted out of externalMetadata),
        -- each of its documented type and shape, so none can carry a phone or a CLABE. A field
        -- pey sends as null (metadata may be) is left out. amount stays as pey sends it, pesos
        -- with up to 2 decimals; amount_minor is the value pialy uses. CASE orders the tests,
        -- as deleting keys from a non-object and casting a non-number raise instead of
        -- returning false.
        CONSTRAINT payment_events_raw_check CHECK (
            CASE
                WHEN jsonb_typeof(raw) <> 'object'
                    OR jsonb_typeof(coalesce(raw -> 'metadata', '{{}}')) <> 'object' THEN false
                ELSE (raw - ARRAY['transactionId', 'codiQrId', 'amount', 'datePaid', 'metadata'])
                        = '{{}}'
                    AND (coalesce(raw -> 'metadata', '{{}}')
                        - ARRAY['clabe', 'bankCode', 'trackingKey', 'attemptId']) = '{{}}'
                    AND {member("transactionId", ("string",), PROVIDER_ID, DIGITS_ONLY)}
                    AND {member("codiQrId", ("string",), PROVIDER_ID, DIGITS_ONLY)}
                    AND {number("amount", Decimal("0.01"), AMOUNT_BELOW, 2)}
                    AND {number("datePaid", DATE_PAID_FROM, DATE_PAID_BELOW, 0)}
                    AND {member("metadata,clabe", ("string",))}
                    AND {member("metadata,bankCode", ("string", "number"), BANK_CODE)}
                    AND {member("metadata,trackingKey", ("string",), TRACKING_KEY, ACCOUNT_NUMBER)}
                    AND {member("metadata,attemptId", ("string",), UUID)}
            END
        )
    )
    """,
    "CREATE INDEX payment_events_intent_idx ON payment_events (business_id, intent_id)",
    """
    CREATE TABLE pey_connections (
        id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id        uuid        NOT NULL
            CONSTRAINT pey_connections_business_id_fkey REFERENCES business (id)
            CONSTRAINT pey_connections_business_id_key UNIQUE,
        api_key_enc        bytea       NOT NULL,
        webhook_secret_enc bytea       NOT NULL,
        key_version        integer     NOT NULL,
        status             text        NOT NULL DEFAULT 'pending'
            CONSTRAINT pey_connections_status_check
                CHECK (status IN ('pending', 'verified', 'disabled')),
        verified_at        timestamptz,
        created_at         timestamptz NOT NULL DEFAULT now(),
        -- Target of webhook_inbox_connection_fkey.
        CONSTRAINT pey_connections_business_connection_key UNIQUE (business_id, id),
        CONSTRAINT pey_connections_verified_check
            CHECK (status <> 'verified' OR verified_at IS NOT NULL)
    )
    """,
    """
    CREATE TABLE webhook_inbox (
        business_id   uuid        NOT NULL
            CONSTRAINT webhook_inbox_business_id_fkey REFERENCES business (id),
        connection_id uuid        NOT NULL,
        webhook_id    text        NOT NULL,
        event_type    text        NOT NULL,
        received_at   timestamptz NOT NULL DEFAULT now(),
        processed_at  timestamptz,
        outcome       text,
        CONSTRAINT webhook_inbox_pkey PRIMARY KEY (connection_id, webhook_id),
        CONSTRAINT webhook_inbox_connection_fkey FOREIGN KEY (business_id, connection_id)
            REFERENCES pey_connections (business_id, id)
    )
    """,
    """
    CREATE TABLE idempotency_keys (
        business_id    uuid        NOT NULL
            CONSTRAINT idempotency_keys_business_id_fkey REFERENCES business (id),
        scope          text        NOT NULL,
        key            text        NOT NULL,
        request_hash   text        NOT NULL,
        response_code  integer,
        response_body  jsonb,
        recovery_point text,
        locked_at      timestamptz,
        created_at     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT idempotency_keys_pkey PRIMARY KEY (business_id, scope, key)
    )
    """,
    # seq gives the relay insert order, which uuids do not; commit order may differ.
    """
    CREATE TABLE outbox (
        business_id  uuid        NOT NULL
            CONSTRAINT outbox_business_id_fkey REFERENCES business (id),
        id           uuid        NOT NULL DEFAULT gen_random_uuid(),
        seq          bigint      GENERATED ALWAYS AS IDENTITY,
        topic        text        NOT NULL,
        payload      jsonb       NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz,
        CONSTRAINT outbox_pkey PRIMARY KEY (business_id, id)
    )
    """,
    """
    CREATE INDEX outbox_unpublished_idx
        ON outbox (business_id, seq) WHERE published_at IS NULL
    """,
    """
    CREATE TABLE flags (
        business_id       uuid        NOT NULL
            CONSTRAINT flags_business_id_fkey REFERENCES business (id),
        id                uuid        NOT NULL DEFAULT gen_random_uuid(),
        kind              text        NOT NULL
            CONSTRAINT flags_kind_check
                CHECK (kind IN ('unmatched_payment', 'refund_due', 'amount_mismatch')),
        booking_id        uuid,
        provider_event_id text,
        payload           jsonb       NOT NULL,
        note              text,
        resolved_at       timestamptz,
        created_at        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT flags_pkey PRIMARY KEY (business_id, id),
        CONSTRAINT flags_booking_fkey FOREIGN KEY (business_id, booking_id)
            REFERENCES bookings (business_id, id)
    )
    """,
    # An orphan payment has no intent to remember its event by, so its refund flag is
    # deduplicated by provider_event_id. A matched payment may raise several flags of the other
    # kinds (an excess refund, then a refund for a slot taken meanwhile).
    """
    CREATE UNIQUE INDEX flags_one_unmatched_per_event_idx
        ON flags (business_id, provider_event_id) WHERE kind = 'unmatched_payment'
    """,
    """
    CREATE TABLE users (
        id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        email         text        NOT NULL,
        password_hash text        NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now()
    )
    """,
    # Case-insensitive uniqueness through an expression index (PostgreSQL docs, 11.7); look
    # users up by lower(email) so the index serves the query.
    "CREATE UNIQUE INDEX users_email_key ON users (lower(email))",
    """
    CREATE TABLE memberships (
        business_id uuid        NOT NULL
            CONSTRAINT memberships_business_id_fkey REFERENCES business (id),
        user_id     uuid        NOT NULL
            CONSTRAINT memberships_user_id_fkey REFERENCES users (id),
        role        text        NOT NULL
            CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'staff')),
        created_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT memberships_pkey PRIMARY KEY (business_id, user_id)
    )
    """,
    "CREATE INDEX memberships_user_idx ON memberships (user_id)",
    """
    CREATE TABLE sessions (
        token_hash bytea       PRIMARY KEY
            CONSTRAINT sessions_token_hash_check CHECK (octet_length(token_hash) = 32),
        user_id    uuid        NOT NULL
            CONSTRAINT sessions_user_id_fkey REFERENCES users (id),
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE invitations (
        business_id uuid        NOT NULL
            CONSTRAINT invitations_business_id_fkey REFERENCES business (id),
        id          uuid        NOT NULL DEFAULT gen_random_uuid(),
        email       text        NOT NULL,
        role        text        NOT NULL
            CONSTRAINT invitations_role_check CHECK (role IN ('owner', 'staff')),
        token_hash  bytea       NOT NULL
            CONSTRAINT invitations_token_hash_key UNIQUE
            CONSTRAINT invitations_token_hash_check CHECK (octet_length(token_hash) = 32),
        expires_at  timestamptz NOT NULL,
        accepted_at timestamptz,
        created_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT invitations_pkey PRIMARY KEY (business_id, id)
    )
    """,
    """
    CREATE TABLE rate_limits (
        key          text        NOT NULL,
        window_start timestamptz NOT NULL,
        count        integer     NOT NULL,
        CONSTRAINT rate_limits_pkey PRIMARY KEY (key, window_start)
    )
    """,
)


def upgrade() -> None:
    for statement in STATEMENTS:
        op.execute(statement)
    # The audit log is agent-toolkit's own table (PostgresAuditStore), created from the schema
    # file it ships, byte for byte: exec_driver_sql, unlike op.execute, reads nothing in it as a
    # bound parameter.
    schema = files("agent_toolkit.audit_log.adapters").joinpath("schema.sql")
    op.get_bind().exec_driver_sql(schema.read_text(encoding="utf-8"))


def downgrade() -> None:
    raise NotImplementedError(
        "migrations are forward-only (spec §12b): undo a change with a new revision"
    )
