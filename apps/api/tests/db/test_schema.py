"""Migration 0001: the tables of spec §6 and their invariants, kept per business.

Port of apps/server/test/schema.test.ts, plus what the multi-business schema adds. Until Task 5's
migration grants pialy_app its privileges, rows are written as pialy_owner (`owner_db`) inside
`tenant(ctx)` transactions, which set app.business_id exactly as the app's do. Every violation
is asserted by its error class (the SQLSTATE) and by the constraint's name, so no test can pass
on a different rule than the one it names. Fixtures are synthetic.
"""

import hmac
import secrets
from collections.abc import Callable, Iterator, Mapping
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from importlib.resources import files
from pathlib import Path
from typing import Protocol
from uuid import UUID, uuid4

import psycopg
import pytest
from agent_toolkit.audit_log import AuditEvent
from alembic import command
from alembic.config import Config
from psycopg import errors, sql
from psycopg.types.json import Jsonb
from psycopg.types.range import Range
from pydantic import SecretStr

from pialy.config import Settings
from pialy.db.database import Database, PgConnection
from pialy.tenancy.context import OwnerActor, TenantContext

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "migrations"
T0 = datetime(2026, 11, 20, 15, 0, tzinfo=UTC)
SALT = b"schema-tests-only-salt"
CLABE = "123456789012345678"
PHONE = "5512345678"
MASKED_CLABE = "**************5678"
# sha256 of agent-toolkit's audit schema.sql, which migration 0001 runs byte for byte.
AUDIT_SCHEMA_SHA256 = "f79eab4b060b7f174bb184192d94c746b7c8ef9acbe1d76036d6bf049379ae52"

# Tables whose rows belong to one business; Task 5 puts row-level security on each.
TENANT_TABLES = frozenset(
    {
        "resources",
        "bookings",
        "payment_intents",
        "payment_attempts",
        "payment_events",
        "webhook_inbox",
        "idempotency_keys",
        "outbox",
        "flags",
        "memberships",
        "invitations",
        "pey_connections",
    }
)
TABLES = TENANT_TABLES | {"business", "users", "sessions", "rate_limits", "audit_events"}
# Indexes of tenant tables reached before the business is known, so they cannot lead with it.
NOT_LED_BY_BUSINESS = frozenset(
    {
        "pey_connections_pkey",  # a webhook names its connection, which names the business
        "webhook_inbox_pkey",  # keyed by connection (one business each), as the inbox records it
        "memberships_user_idx",  # login lists a user's businesses
        "invitations_token_hash_key",  # accepting an invitation starts from its token
    }
)
MONEY_COLUMNS = frozenset(
    {
        ("business", "deposit_minor"),
        ("payment_intents", "amount_minor"),
        ("payment_intents", "paid_total_minor"),
        ("payment_attempts", "amount_minor"),
        ("payment_events", "amount_minor"),
    }
)

# How the hold assigns a booking number (Task 12): the UPDATE locks the business row until the
# transaction ends, so concurrent holds of one business queue for consecutive numbers, and a
# rolled-back hold gives its number back.
NEXT_BOOKING_NUMBER = """
UPDATE business SET next_booking_number = next_booking_number + 1
WHERE id = %s
RETURNING next_booking_number - 1
"""

# How apply_payment records the refund flag of an orphan payment (Task 11): one per provider event.
INSERT_ORPHAN_FLAG = """
INSERT INTO flags (business_id, kind, provider_event_id, payload)
VALUES (%s, 'unmatched_payment', %s, '{}')
ON CONFLICT (business_id, provider_event_id) WHERE kind = 'unmatched_payment' DO NOTHING
"""

# The only form of a pey payment payload that payment_events.raw holds (built by Tasks 9 and 11):
# pey's own names for the fields a PeyPaymentEvent reads, attemptId lifted out of
# metadata.externalMetadata, and the payer's account masked to its last 4 characters. A payload
# whose metadata is null gives a projection without the key. Values are those of pey's documented
# webhook examples (packages/connector-pey/test/fixtures), which are synthetic; attemptId is a
# Pialy attempt id, a UUID.
ATTEMPT_ID = "6f1c2a3b-0d4e-4f5a-8b6c-7d8e9f0a1b2c"
SANITIZED_METADATA = {
    "clabe": MASKED_CLABE,
    "bankCode": 40012,
    "trackingKey": "0192191042",
    "attemptId": ATTEMPT_ID,
}
SANITIZED_PUSH = {
    "transactionId": "01M3QR5E7XHXMNZDEPFH3JAWS0",
    "amount": 0.01,
    "datePaid": 1790724758,
    "metadata": SANITIZED_METADATA,
}
SANITIZED_QR = {
    "transactionId": "01M3QR8H0RH0XBCKYYD242YXNV",
    "codiQrId": "35a13c183a",
    "amount": 150,
    "datePaid": 1790724818,
    "metadata": SANITIZED_METADATA,
}
# What pey sends that the projection leaves out (synthetic values).
PEY_BODY = SANITIZED_QR | {
    "type": "codi.qr.payment_received",
    "apiKeyId": "01M3QMMR6X9CBVDY1SF3G8QWNW",
    "bankAccountId": "01JBAVWE4NS5TGXHWGMX3KH23Q",
    "concept": "Reserva",
    "numRef": "1",
    "metadata": SANITIZED_METADATA
    | {
        "accountType": 40,
        "description": "Reserva",
        "externalMetadata": {"attemptId": ATTEMPT_ID, "orderId": "12345"},
    },
}


def with_metadata(**fields: object) -> dict[str, object]:
    """The sanitized QR projection with some metadata fields replaced."""
    return SANITIZED_QR | {"metadata": SANITIZED_METADATA | fields}


SCHEMA = """
SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' '
       || is_nullable || ' ' || coalesce(column_default, '')
FROM information_schema.columns WHERE table_schema = 'public'
UNION ALL
SELECT 'constraint ' || conrelid::regclass::text || '.' || conname || ' '
       || pg_get_constraintdef(oid)
FROM pg_constraint WHERE connamespace = 'public'::regnamespace
UNION ALL
SELECT 'index ' || pg_get_indexdef(indexrelid)
FROM pg_index JOIN pg_class ON pg_class.oid = pg_index.indexrelid
WHERE pg_class.relnamespace = 'public'::regnamespace
ORDER BY 1
"""


class OwnedDatabase(Protocol):
    @property
    def owner_url(self) -> str: ...


type Row = dict[str, object]
type DatabaseFactory = Callable[[Path], AbstractContextManager[OwnedDatabase]]
type RunAlembic = Callable[[str, Callable[[Config, str], None], str], None]


@dataclass(frozen=True)
class Seeded:
    """A business with one row of each kind that other rows point at."""

    id: UUID
    resource_id: UUID
    intent_id: UUID
    attempt_id: UUID
    booking_id: UUID
    connection_id: UUID


type Adder = Callable[[PgConnection, Seeded], object]
type CrossAdder = Callable[[PgConnection, Seeded, Seeded], object]
type KeyAdder = Callable[[PgConnection, Seeded, str], object]


def context(business_id: UUID) -> TenantContext:
    return TenantContext(business_id=business_id, actor=OwnerActor(user_id=uuid4()))


def phone_hash(phone: str) -> str:
    """HMAC-SHA256 hex of a 10-digit phone, the only form of it the app stores."""
    return hmac.new(SALT, phone.encode(), sha256).hexdigest()


def token_hash() -> bytes:
    return sha256(secrets.token_bytes(32)).digest()


def insert(conn: PgConnection, table: str, row: Mapping[str, object]) -> None:
    conn.execute(
        sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
            sql.Identifier(table),
            sql.SQL(", ").join(map(sql.Identifier, row)),
            sql.SQL(", ").join(map(sql.Placeholder, row)),
        ),
        row,
    )


@contextmanager
def violates(error: type[psycopg.Error], constraint: str) -> Iterator[None]:
    with pytest.raises(error) as caught:
        yield
    assert caught.value.diag.constraint_name == constraint


def next_booking_number(conn: PgConnection, business_id: UUID) -> int:
    row = conn.execute(NEXT_BOOKING_NUMBER, (business_id,)).fetchone()
    assert row is not None
    number: int = row[0]
    return number


def business_row(business_id: UUID) -> Row:
    return {
        "id": business_id,
        "slug": f"negocio-{business_id.hex[:8]}",
        "name": "Estudio Demo",
        "service_name": "Consulta",
        "service_minutes": 45,
        "slot_minutes": 45,
        "deposit_minor": 1,
        "currency": "MXN",
        "timezone": "America/Mexico_City",
        "hours": Jsonb({"open": "09:00", "close": "19:00"}),
    }


def add_resource(conn: PgConnection, business_id: UUID) -> UUID:
    resource_id = uuid4()
    insert(conn, "resources", {"business_id": business_id, "id": resource_id, "name": "Sala"})
    return resource_id


def add_intent(conn: PgConnection, business_id: UUID, **overrides: object) -> UUID:
    intent_id = uuid4()
    row: Row = {
        "business_id": business_id,
        "id": intent_id,
        "principal_id": business_id,
        "reference": f"booking:{uuid4()}",
        "idempotency_key": str(uuid4()),
        "amount_minor": 1,
        "currency": "MXN",
    }
    insert(conn, "payment_intents", row | overrides)
    return intent_id


def add_attempt(
    conn: PgConnection, business_id: UUID, intent_id: UUID, **overrides: object
) -> UUID:
    attempt_id = uuid4()
    row: Row = {
        "business_id": business_id,
        "id": attempt_id,
        "intent_id": intent_id,
        "rail": "codi_push",
        "provider_ref": str(attempt_id),
        "amount_minor": 1,
        "created_at": T0,
        "expires_at": T0 + timedelta(minutes=6),
    }
    insert(conn, "payment_attempts", row | overrides)
    return attempt_id


def add_booking(
    conn: PgConnection,
    business_id: UUID,
    resource_id: UUID,
    start: datetime,
    end: datetime | None = None,
    *,
    status: str = "holding",
    **overrides: object,
) -> UUID:
    booking_id = uuid4()
    row: Row = {
        "business_id": business_id,
        "id": booking_id,
        "token": secrets.token_urlsafe(32),
        "resource_id": resource_id,
        "slot_start": start,
        "during": Range(start, end or start + timedelta(minutes=45), "[)"),
        "status": status,
        "phone_last4": "5678",
        "phone_hash": secrets.token_hex(32),  # another customer's phone, hashed
    }
    if "number" not in overrides:
        row["number"] = next_booking_number(conn, business_id)
    insert(conn, "bookings", row | overrides)
    return booking_id


def add_connection(conn: PgConnection, business_id: UUID, **overrides: object) -> UUID:
    connection_id = uuid4()
    row: Row = {
        "business_id": business_id,
        "id": connection_id,
        "api_key_enc": b"\x01" + secrets.token_bytes(44),
        "webhook_secret_enc": b"\x01" + secrets.token_bytes(44),
        "key_version": 1,
    }
    insert(conn, "pey_connections", row | overrides)
    return connection_id


def add_event(conn: PgConnection, business_id: UUID, **overrides: object) -> UUID:
    """An orphan payment event unless `intent_id` and `attempt_id` are given."""
    event_id = uuid4()
    row: Row = {
        "business_id": business_id,
        "id": event_id,
        "provider_event_id": f"tx-{uuid4()}",
        "provider_ref": f"qr-{uuid4()}",
        "amount_minor": 1,
        "currency": "MXN",
        "raw": Jsonb({"metadata": {"clabe": MASKED_CLABE, "trackingKey": "TRACK123"}}),
    }
    insert(conn, "payment_events", row | overrides)
    return event_id


def add_flag(conn: PgConnection, business_id: UUID, **overrides: object) -> UUID:
    flag_id = uuid4()
    row: Row = {
        "business_id": business_id,
        "id": flag_id,
        "kind": "unmatched_payment",
        "payload": Jsonb({}),
    }
    insert(conn, "flags", row | overrides)
    return flag_id


def add_webhook(
    conn: PgConnection, business_id: UUID, connection_id: UUID, webhook_id: str
) -> None:
    insert(
        conn,
        "webhook_inbox",
        {
            "business_id": business_id,
            "connection_id": connection_id,
            "webhook_id": webhook_id,
            "event_type": "payment.received",
        },
    )


def add_idempotency_key(conn: PgConnection, business_id: UUID, key: str) -> None:
    insert(
        conn,
        "idempotency_keys",
        {"business_id": business_id, "scope": "hold", "key": key, "request_hash": "req-hash"},
    )


def add_user(conn: PgConnection, email: str | None = None) -> UUID:
    user_id = uuid4()
    insert(
        conn,
        "users",
        {
            "id": user_id,
            "email": email or f"owner-{user_id.hex[:8]}@example.com",
            "password_hash": "$argon2id$synthetic",
        },
    )
    return user_id


def add_membership(conn: PgConnection, business_id: UUID, role: str = "owner") -> None:
    insert(
        conn,
        "memberships",
        {"business_id": business_id, "user_id": add_user(conn), "role": role},
    )


def add_invitation(conn: PgConnection, business_id: UUID, **overrides: object) -> None:
    row: Row = {
        "business_id": business_id,
        "id": uuid4(),
        "email": "staff@example.com",
        "role": "staff",
        "token_hash": token_hash(),
        "expires_at": T0 + timedelta(days=7),
    }
    insert(conn, "invitations", row | overrides)


def add_session(conn: PgConnection, **overrides: object) -> None:
    row: Row = {
        "token_hash": token_hash(),
        "user_id": add_user(conn),
        "expires_at": T0 + timedelta(hours=12),
    }
    insert(conn, "sessions", row | overrides)


def create_business(db: Database, **overrides: object) -> Seeded:
    """A business, its resource, an intent with one attempt, a booking and a pey connection."""
    business_id = uuid4()
    with db.tenant(context(business_id)) as conn:
        insert(conn, "business", business_row(business_id) | overrides)
        resource_id = add_resource(conn, business_id)
        intent_id = add_intent(conn, business_id)
        return Seeded(
            id=business_id,
            resource_id=resource_id,
            intent_id=intent_id,
            attempt_id=add_attempt(conn, business_id, intent_id),
            booking_id=add_booking(
                conn,
                business_id,
                resource_id,
                T0 - timedelta(days=1),
                status="confirmed",
                intent_id=intent_id,
            ),
            connection_id=add_connection(conn, business_id),
        )


def count_bookings_from_t0(conn: PgConnection, resource_id: UUID) -> int:
    row = conn.execute(
        "SELECT count(*) FROM bookings WHERE resource_id = %s AND slot_start >= %s",
        (resource_id, T0),
    ).fetchone()
    assert row is not None
    count: int = row[0]
    return count


# --- bookings exclusion constraint (schema.test.ts) ---


def test_overlapping_active_bookings_on_one_resource_are_rejected(owner_db: Database) -> None:
    business = create_business(owner_db)
    with owner_db.tenant(context(business.id)) as conn:
        add_booking(conn, business.id, business.resource_id, T0)
    with (
        violates(errors.ExclusionViolation, "bookings_no_overlap"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_booking(conn, business.id, business.resource_id, T0 + timedelta(minutes=30))


def test_adjacent_half_open_ranges_are_allowed(owner_db: Database) -> None:
    business = create_business(owner_db)
    with owner_db.tenant(context(business.id)) as conn:
        add_booking(conn, business.id, business.resource_id, T0)
        add_booking(
            conn, business.id, business.resource_id, T0 + timedelta(minutes=45), status="confirmed"
        )
        assert count_bookings_from_t0(conn, business.resource_id) == 2


def test_an_expired_booking_frees_its_slot(owner_db: Database) -> None:
    business = create_business(owner_db)
    with owner_db.tenant(context(business.id)) as conn:
        add_booking(conn, business.id, business.resource_id, T0, status="expired")
        add_booking(conn, business.id, business.resource_id, T0)
        assert count_bookings_from_t0(conn, business.resource_id) == 2


def test_the_same_range_on_another_resource_is_allowed(owner_db: Database) -> None:
    business = create_business(owner_db)
    with owner_db.tenant(context(business.id)) as conn:
        other_resource = add_resource(conn, business.id)
        add_booking(conn, business.id, business.resource_id, T0)
        add_booking(conn, business.id, other_resource, T0)
        assert count_bookings_from_t0(conn, business.resource_id) == 1
        assert count_bookings_from_t0(conn, other_resource) == 1


def test_the_range_round_trips(owner_db: Database) -> None:
    business = create_business(owner_db)
    end = T0 + timedelta(minutes=45)
    with owner_db.tenant(context(business.id)) as conn:
        booking_id = add_booking(conn, business.id, business.resource_id, T0, end)
        row = conn.execute("SELECT during FROM bookings WHERE id = %s", (booking_id,)).fetchone()
    assert row == (Range(T0, end, "[)"),)


# --- one holding booking per phone, now per business ---


def test_a_second_holding_booking_for_one_phone_is_rejected(owner_db: Database) -> None:
    business = create_business(owner_db)
    same_phone = phone_hash("5512345678")
    with owner_db.tenant(context(business.id)) as conn:
        add_booking(conn, business.id, business.resource_id, T0, phone_hash=same_phone)
    with (
        violates(errors.UniqueViolation, "bookings_one_holding_per_phone_idx"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_booking(
            conn,
            business.id,
            business.resource_id,
            T0 + timedelta(hours=2),
            phone_hash=same_phone,
        )


def test_a_phone_may_hold_again_once_it_has_no_holding_booking(owner_db: Database) -> None:
    business = create_business(owner_db)
    same_phone = phone_hash("5512345678")
    with owner_db.tenant(context(business.id)) as conn:
        for day, status in enumerate(("expired", "confirmed", "canceled", "holding")):
            start = T0 + timedelta(days=day)
            add_booking(
                conn, business.id, business.resource_id, start, status=status, phone_hash=same_phone
            )
        assert count_bookings_from_t0(conn, business.resource_id) == 4


def test_same_phone_may_hold_in_two_businesses(owner_db: Database) -> None:
    same_phone = phone_hash("5512345678")
    for business in (create_business(owner_db), create_business(owner_db)):
        with owner_db.tenant(context(business.id)) as conn:
            add_booking(conn, business.id, business.resource_id, T0, phone_hash=same_phone)


# --- booking numbers: per business, seven digits, under the business row lock ---


def test_booking_numbers_are_per_business(owner_db: Database) -> None:
    first, second = create_business(owner_db), create_business(owner_db)
    for business in (first, second):
        with owner_db.tenant(context(business.id)) as conn:
            row = conn.execute(
                "SELECT number FROM bookings WHERE id = %s", (business.booking_id,)
            ).fetchone()
            assert row == (1,)
            assert next_booking_number(conn, business.id) == 2
    with owner_db.tenant(context(second.id)) as conn:
        add_booking(conn, second.id, second.resource_id, T0, number=3)
    with (
        violates(errors.UniqueViolation, "bookings_number_key"),
        owner_db.tenant(context(second.id)) as conn,
    ):
        add_booking(conn, second.id, second.resource_id, T0 + timedelta(hours=1), number=3)


def test_booking_numbers_stop_at_seven_digits_per_business(owner_db: Database) -> None:
    full, other = create_business(owner_db), create_business(owner_db)
    with owner_db.tenant(context(full.id)) as conn:
        conn.execute("UPDATE business SET next_booking_number = 9999999 WHERE id = %s", (full.id,))
        last = next_booking_number(conn, full.id)
        add_booking(conn, full.id, full.resource_id, T0, number=last)
    assert last == 9_999_999
    with (
        violates(errors.CheckViolation, "business_next_booking_number_check"),
        owner_db.tenant(context(full.id)) as conn,
    ):
        next_booking_number(conn, full.id)
    with owner_db.tenant(context(other.id)) as conn:
        assert next_booking_number(conn, other.id) == 2
    for number in (0, 10_000_000):
        with (
            violates(errors.CheckViolation, "bookings_number_check"),
            owner_db.tenant(context(other.id)) as conn,
        ):
            add_booking(conn, other.id, other.resource_id, T0, number=number)


def test_booking_numbers_are_assigned_under_the_business_row_lock(owner_db: Database) -> None:
    business = create_business(owner_db)
    with owner_db.tenant(context(business.id)) as first:
        assert next_booking_number(first, business.id) == 2
        with pytest.raises(errors.LockNotAvailable), owner_db.tenant(context(business.id)) as other:
            other.execute("SET LOCAL lock_timeout = '50ms'")
            next_booking_number(other, business.id)
    with owner_db.tenant(context(business.id)) as conn:
        assert next_booking_number(conn, business.id) == 3


# --- constraints (schema.test.ts), with the statuses of payments-core ---

UNKNOWN_VALUES: list[tuple[str, Adder]] = [
    (
        "bookings_status_check",
        lambda conn, b: add_booking(conn, b.id, b.resource_id, T0, status="weird"),
    ),
    ("payment_intents_status_check", lambda conn, b: add_intent(conn, b.id, status="succeeded")),
    (
        "payment_attempts_status_check",
        lambda conn, b: add_attempt(conn, b.id, b.intent_id, status="awaiting"),
    ),
    (
        "payment_attempts_rail_check",
        lambda conn, b: add_attempt(conn, b.id, b.intent_id, rail="push"),
    ),
    ("flags_kind_check", lambda conn, b: add_flag(conn, b.id, kind="nope")),
    (
        "pey_connections_status_check",
        lambda conn, b: conn.execute(
            "UPDATE pey_connections SET status = 'active' WHERE id = %s", (b.connection_id,)
        ),
    ),
    ("memberships_role_check", lambda conn, b: add_membership(conn, b.id, role="admin")),
    ("invitations_role_check", lambda conn, b: add_invitation(conn, b.id, role="admin")),
]


@pytest.mark.parametrize(
    ("constraint", "add"), UNKNOWN_VALUES, ids=[name for name, _ in UNKNOWN_VALUES]
)
def test_unknown_statuses_kinds_and_roles_are_rejected(
    owner_db: Database, constraint: str, add: Adder
) -> None:
    business = create_business(owner_db)
    with violates(errors.CheckViolation, constraint), owner_db.tenant(context(business.id)) as conn:
        add(conn, business)


def test_known_statuses_kinds_and_roles_are_accepted(owner_db: Database) -> None:
    business = create_business(owner_db)
    with owner_db.tenant(context(business.id)) as conn:
        for hour, status in enumerate(
            ("holding", "confirmed", "checked_in", "expired", "canceled")
        ):
            add_booking(
                conn, business.id, business.resource_id, T0 + timedelta(hours=hour), status=status
            )
        for rail in ("codi_push", "codi_qr"):
            for status in ("requested", "ambiguous", "paid", "expired"):
                add_attempt(conn, business.id, business.intent_id, rail=rail, status=status)
        for kind in ("unmatched_payment", "refund_due", "amount_mismatch"):
            add_flag(conn, business.id, kind=kind)
        for role in ("owner", "staff"):
            add_membership(conn, business.id, role=role)
            add_invitation(conn, business.id, role=role)
        for status, verified_at in (("verified", T0), ("disabled", None), ("pending", None)):
            conn.execute(
                "UPDATE pey_connections SET status = %s, verified_at = %s WHERE id = %s",
                (status, verified_at, business.connection_id),
            )


def test_provider_event_ids_and_webhook_ids_are_unique(owner_db: Database) -> None:
    business = create_business(owner_db)
    with owner_db.tenant(context(business.id)) as conn:
        add_event(conn, business.id, provider_event_id="tx1")
        add_webhook(conn, business.id, business.connection_id, "wh1")
    with (
        violates(errors.UniqueViolation, "payment_events_provider_event_id_key"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_event(conn, business.id, provider_event_id="tx1")
    with (
        violates(errors.UniqueViolation, "webhook_inbox_pkey"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_webhook(conn, business.id, business.connection_id, "wh1")


def test_zero_amount_intents_are_rejected_and_positive_ones_accepted(owner_db: Database) -> None:
    business = create_business(owner_db)
    with (
        violates(errors.CheckViolation, "payment_intents_amount_check"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_intent(conn, business.id, amount_minor=0)
    with owner_db.tenant(context(business.id)) as conn:
        add_intent(conn, business.id, amount_minor=1)


def test_empty_booking_ranges_are_rejected(owner_db: Database) -> None:
    business = create_business(owner_db)
    with (
        violates(errors.CheckViolation, "bookings_during_check"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_booking(conn, business.id, business.resource_id, T0, T0)


@pytest.mark.parametrize(
    "during",
    [
        Range(T0, T0 + timedelta(minutes=45), "[]"),
        Range(T0, T0 + timedelta(minutes=45), "()"),
        Range(T0, None, "[)"),
    ],
    ids=["closed", "open-start", "unbounded"],
)
def test_booking_ranges_are_half_open_and_bounded(
    owner_db: Database, during: Range[datetime]
) -> None:
    # Half-open [start, end) is what lets adjacent bookings share a boundary; an unbounded one
    # would hold the resource forever.
    business = create_business(owner_db)
    with (
        violates(errors.CheckViolation, "bookings_during_check"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_booking(conn, business.id, business.resource_id, T0, during=during)


def test_the_range_must_start_at_slot_start(owner_db: Database) -> None:
    business = create_business(owner_db)
    with (
        violates(errors.CheckViolation, "bookings_during_check"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_booking(
            conn, business.id, business.resource_id, T0, slot_start=T0 + timedelta(minutes=15)
        )


# --- keys are scoped to the business; rows never point into another business ---


def booking_with_token(conn: PgConnection, b: Seeded, token: str) -> None:
    add_booking(conn, b.id, add_resource(conn, b.id), T0, status="confirmed", token=token)


def attempt_with_provider_ref(conn: PgConnection, b: Seeded, ref: str) -> None:
    add_attempt(conn, b.id, add_intent(conn, b.id), provider_ref=ref)


UNIQUE_PER_BUSINESS: list[tuple[str, KeyAdder]] = [
    ("bookings_token_key", booking_with_token),
    ("payment_intents_reference_key", lambda conn, b, v: add_intent(conn, b.id, reference=v)),
    (
        "payment_intents_idempotency_key_key",
        lambda conn, b, v: add_intent(conn, b.id, idempotency_key=v),
    ),
    ("payment_attempts_provider_ref_key", attempt_with_provider_ref),
    (
        "payment_events_provider_event_id_key",
        lambda conn, b, v: add_event(conn, b.id, provider_event_id=v),
    ),
    (
        "flags_one_unmatched_per_event_idx",
        lambda conn, b, v: add_flag(conn, b.id, provider_event_id=v),
    ),
    ("idempotency_keys_pkey", lambda conn, b, v: add_idempotency_key(conn, b.id, v)),
]


@pytest.mark.parametrize(
    ("constraint", "add"), UNIQUE_PER_BUSINESS, ids=[name for name, _ in UNIQUE_PER_BUSINESS]
)
def test_keys_are_unique_within_a_business_and_free_across_businesses(
    owner_db: Database, constraint: str, add: KeyAdder
) -> None:
    mine, theirs = create_business(owner_db), create_business(owner_db)
    with owner_db.tenant(context(mine.id)) as conn:
        add(conn, mine, "key-1")
    with violates(errors.UniqueViolation, constraint), owner_db.tenant(context(mine.id)) as conn:
        add(conn, mine, "key-1")
    with owner_db.tenant(context(theirs.id)) as conn:
        add(conn, theirs, "key-1")


CROSS_BUSINESS: list[tuple[str, CrossAdder]] = [
    (
        "bookings_resource_fkey",
        lambda conn, mine, theirs: add_booking(conn, mine.id, theirs.resource_id, T0),
    ),
    (
        "bookings_intent_fkey",
        lambda conn, mine, theirs: add_booking(
            conn, mine.id, mine.resource_id, T0, intent_id=theirs.intent_id
        ),
    ),
    (
        "payment_attempts_intent_fkey",
        lambda conn, mine, theirs: add_attempt(conn, mine.id, theirs.intent_id),
    ),
    (
        "payment_events_attempt_fkey",
        lambda conn, mine, theirs: add_event(
            conn, mine.id, intent_id=theirs.intent_id, attempt_id=theirs.attempt_id
        ),
    ),
    (
        "flags_booking_fkey",
        lambda conn, mine, theirs: add_flag(conn, mine.id, booking_id=theirs.booking_id),
    ),
    (
        "webhook_inbox_connection_fkey",
        lambda conn, mine, theirs: add_webhook(conn, mine.id, theirs.connection_id, "wh1"),
    ),
]


@pytest.mark.parametrize(
    ("constraint", "add"), CROSS_BUSINESS, ids=[name for name, _ in CROSS_BUSINESS]
)
def test_rows_cannot_point_at_another_business_rows(
    owner_db: Database, constraint: str, add: CrossAdder
) -> None:
    # Foreign key checks bypass row-level security, so the keys themselves carry the business.
    mine, theirs = create_business(owner_db), create_business(owner_db)
    with (
        violates(errors.ForeignKeyViolation, constraint),
        owner_db.tenant(context(mine.id)) as conn,
    ):
        add(conn, mine, theirs)


def test_a_payment_event_matches_an_attempt_of_its_own_intent_or_none(owner_db: Database) -> None:
    business = create_business(owner_db)
    with owner_db.tenant(context(business.id)) as conn:
        other_intent = add_intent(conn, business.id)
        add_event(conn, business.id, intent_id=business.intent_id, attempt_id=business.attempt_id)
    with (
        violates(errors.ForeignKeyViolation, "payment_events_attempt_fkey"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_event(conn, business.id, intent_id=other_intent, attempt_id=business.attempt_id)
    for half_match in ({"intent_id": business.intent_id}, {"attempt_id": business.attempt_id}):
        with (
            violates(errors.CheckViolation, "payment_events_match_check"),
            owner_db.tenant(context(business.id)) as conn,
        ):
            add_event(conn, business.id, **half_match)


def test_one_payment_event_may_raise_several_flags(owner_db: Database) -> None:
    # A late excess payment for a taken slot is refunded twice over (payments-core `excess`, then
    # the booking reaction), and a `duplicate` refund flag may meet a booking reaction's flag.
    business = create_business(owner_db)
    with owner_db.tenant(context(business.id)) as conn:
        for kind in ("refund_due", "refund_due", "amount_mismatch", "unmatched_payment"):
            add_flag(conn, business.id, kind=kind, provider_event_id="tx1")


def test_an_orphan_payment_raises_one_unmatched_flag(owner_db: Database) -> None:
    business = create_business(owner_db)
    with owner_db.tenant(context(business.id)) as conn:
        for _ in range(2):
            conn.execute(INSERT_ORPHAN_FLAG, (business.id, "tx1"))
        row = conn.execute("SELECT count(*) FROM flags WHERE provider_event_id = 'tx1'").fetchone()
        assert row == (1,)
    with (
        violates(errors.UniqueViolation, "flags_one_unmatched_per_event_idx"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_flag(conn, business.id, kind="unmatched_payment", provider_event_id="tx1")


def test_bookings_are_found_by_their_intent(owner_db: Database) -> None:
    # Applying a payment reacts on the booking of the intent it paid.
    with owner_db.system() as conn:
        rows = conn.execute(
            """
            SELECT array_agg(a.attname::text ORDER BY k.position)
            FROM pg_index i
            CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, position)
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
            WHERE i.indrelid = 'bookings'::regclass
            GROUP BY i.indexrelid
            """
        ).fetchall()
    assert ["business_id", "intent_id"] in [columns[:2] for (columns,) in rows]


# --- payment_events.raw: a sanitized projection, never pey's body as received ---


@pytest.mark.parametrize(
    "raw",
    [
        SANITIZED_PUSH,
        SANITIZED_QR,
        {},
        {key: value for key, value in SANITIZED_PUSH.items() if key != "metadata"},
        SANITIZED_QR | {"codiQrId": "AB12CD34EF"},
        with_metadata(bankCode="40012"),
        SANITIZED_QR | {"amount": 1.5},
        SANITIZED_QR | {"transactionId": "01m3qr8h0rh0xbckyyd242yxnv"},
        with_metadata(bankCode="002"),
        with_metadata(trackingKey="A" * 30),
        with_metadata(trackingKey="12345678901234"),
        with_metadata(trackingKey="TRACK1234567890123456"),
        SANITIZED_QR | {"amount": 9_999_999.99, "datePaid": 1_577_836_800},
        SANITIZED_QR | {"datePaid": 4_102_444_799},
        SANITIZED_QR
        | {"transactionId": "txn_2026-AbCdEf0123456789", "codiQrId": "qr_0A1b2C3d4E5f"},
        SANITIZED_QR | {"transactionId": "T" * 64, "codiQrId": "Q" * 64},
        SANITIZED_QR | {"transactionId": "01M3QR8H", "codiQrId": "35a13c18"},
    ],
    ids=[
        "push",
        "qr",
        "empty",
        "null-metadata-omitted",
        "uppercase-qr-id",
        "bank-code-string",
        "pesos-with-centavos",
        "lowercase-ulid",
        "three-digit-bank-code",
        "longest-tracking-key",
        "longest-digits-only-tracking-key",
        "tracking-key-with-letters-and-a-digit-run",
        "largest-amount-first-second-of-2020",
        "last-second-before-2100",
        "new-format-ids",
        "longest-ids",
        "shortest-ids",
    ],
)
def test_payment_events_store_the_sanitized_projection(
    owner_db: Database, raw: dict[str, object]
) -> None:
    business = create_business(owner_db)
    with owner_db.tenant(context(business.id)) as conn:
        add_event(conn, business.id, raw=Jsonb(raw))


@pytest.mark.parametrize(
    "raw",
    [
        SANITIZED_PUSH | {"payerPhone": "5512345678"},
        SANITIZED_PUSH | {"metadata": SANITIZED_METADATA | {"account": CLABE}},
        PEY_BODY,
        SANITIZED_PUSH
        | {"metadata": SANITIZED_METADATA | {"trackingKey": {"phone": "5512345678"}}},
        SANITIZED_PUSH | {"transactionId": ["5512345678"]},
        SANITIZED_PUSH | {"metadata": [CLABE]},
        "5512345678",
    ],
    ids=[
        "phone-key",
        "clabe-key-in-metadata",
        "pey-body",
        "object-under-allowed-key",
        "array-under-allowed-key",
        "metadata-not-an-object",
        "not-an-object",
    ],
)
def test_payment_events_reject_fields_outside_the_projection(
    owner_db: Database, raw: object
) -> None:
    business = create_business(owner_db)
    with (
        violates(errors.CheckViolation, "payment_events_raw_check"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_event(conn, business.id, raw=Jsonb(raw))


# Each field of the projection keeps its documented type and shape, so an allowed key cannot
# carry a phone, a CLABE or anything else. pey's ids are opaque strings: any format is taken but
# digits alone, the shape of a phone or a CLABE. A tracking key may be digits alone, as the
# fixture's is, but not 15 or more of them: the length of a CLABE (18) or a card (15 to 19).
# amount (pesos) and datePaid (Unix seconds) stay within plausible bounds, below the size of a
# phone or a CLABE written as a number.
MALFORMED_FIELDS: list[tuple[str, dict[str, object]]] = [
    ("clabe-in-bank-code", with_metadata(bankCode=CLABE)),
    ("clabe-number-in-bank-code", with_metadata(bankCode=int(CLABE))),
    ("phone-in-bank-code", with_metadata(bankCode="5512345678")),
    ("bank-code-too-short", with_metadata(bankCode=40)),
    ("bank-code-boolean", with_metadata(bankCode=True)),
    ("transaction-id-phone", SANITIZED_QR | {"transactionId": "5512345678"}),
    ("transaction-id-clabe", SANITIZED_QR | {"transactionId": CLABE}),
    ("transaction-id-too-short", SANITIZED_QR | {"transactionId": "tx-0001"}),
    ("transaction-id-too-long", SANITIZED_QR | {"transactionId": "T" * 65}),
    ("transaction-id-other-characters", SANITIZED_QR | {"transactionId": "01M3QR8H.0RH0XBCK"}),
    ("transaction-id-number", SANITIZED_QR | {"transactionId": 1790724818}),
    ("qr-id-phone", SANITIZED_QR | {"codiQrId": "5512345678"}),
    ("qr-id-clabe", SANITIZED_QR | {"codiQrId": CLABE}),
    ("qr-id-too-short", SANITIZED_QR | {"codiQrId": "35a13c1"}),
    ("qr-id-too-long", SANITIZED_QR | {"codiQrId": "Q" * 65}),
    ("qr-id-spaces", SANITIZED_QR | {"codiQrId": "35a13 c183a"}),
    ("qr-id-number", SANITIZED_QR | {"codiQrId": 3513183}),
    ("qr-id-null", SANITIZED_QR | {"codiQrId": None}),
    ("amount-string", SANITIZED_QR | {"amount": "150"}),
    ("amount-zero", SANITIZED_QR | {"amount": 0}),
    ("amount-negative", SANITIZED_QR | {"amount": -1}),
    ("amount-below-a-centavo", SANITIZED_QR | {"amount": 0.001}),
    ("amount-ten-million", SANITIZED_QR | {"amount": 10_000_000}),
    ("amount-phone", SANITIZED_QR | {"amount": int(PHONE)}),
    ("amount-clabe", SANITIZED_QR | {"amount": int(CLABE)}),
    ("date-paid-string", SANITIZED_QR | {"datePaid": "1790724818"}),
    ("date-paid-fraction", SANITIZED_QR | {"datePaid": 1790724818.5}),
    ("date-paid-before-2020", SANITIZED_QR | {"datePaid": 1_577_836_799}),
    ("date-paid-2100", SANITIZED_QR | {"datePaid": 4_102_444_800}),
    ("date-paid-milliseconds", SANITIZED_QR | {"datePaid": 1_790_724_818_000}),
    ("date-paid-phone", SANITIZED_QR | {"datePaid": int(PHONE)}),
    ("date-paid-clabe", SANITIZED_QR | {"datePaid": int(CLABE)}),
    ("tracking-key-boolean", with_metadata(trackingKey=True)),
    ("tracking-key-number", with_metadata(trackingKey=192191042)),
    ("tracking-key-spaces", with_metadata(trackingKey="0192 191042")),
    ("tracking-key-too-long", with_metadata(trackingKey="A" * 31)),
    ("tracking-key-clabe", with_metadata(trackingKey=CLABE)),
    ("tracking-key-card", with_metadata(trackingKey="1234567890123456")),
    ("tracking-key-15-digits", with_metadata(trackingKey="123456789012345")),
    ("attempt-id-not-uuid", with_metadata(attemptId="att_01TESTATTEMPTQR000000001")),
    ("attempt-id-number", with_metadata(attemptId=1)),
    ("attempt-id-uppercase", with_metadata(attemptId=ATTEMPT_ID.upper())),
    ("clabe-number", with_metadata(clabe=5678)),
    ("metadata-null", SANITIZED_QR | {"metadata": None}),
]


@pytest.mark.parametrize(
    "raw", [raw for _, raw in MALFORMED_FIELDS], ids=[name for name, _ in MALFORMED_FIELDS]
)
def test_payment_events_reject_projection_fields_of_another_type_or_shape(
    owner_db: Database, raw: dict[str, object]
) -> None:
    business = create_business(owner_db)
    with (
        violates(errors.CheckViolation, "payment_events_raw_check"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_event(conn, business.id, raw=Jsonb(raw))


# --- money: integer minor units, ISO 4217 currency, payments-core invariants ---


def test_money_columns_are_bigint_minor_units(owner_db: Database) -> None:
    with owner_db.system() as conn:
        rows = conn.execute(
            "SELECT table_name::text, column_name::text, data_type::text"
            " FROM information_schema.columns"
            " WHERE table_schema = 'public' AND column_name LIKE '%\\_minor'"
        ).fetchall()
    assert {(table, column) for table, column, _ in rows} == MONEY_COLUMNS
    assert {data_type for _, _, data_type in rows} == {"bigint"}


def business_in(db: Database, currency: str) -> None:
    create_business(db, currency=currency)


def intent_in(db: Database, currency: str) -> None:
    business = create_business(db)
    with db.tenant(context(business.id)) as conn:
        add_intent(conn, business.id, currency=currency)


def event_in(db: Database, currency: str) -> None:
    business = create_business(db)
    with db.tenant(context(business.id)) as conn:
        add_event(conn, business.id, currency=currency)


CURRENCY_HOLDERS: list[tuple[str, Callable[[Database, str], None]]] = [
    ("business_currency_check", business_in),
    ("payment_intents_currency_check", intent_in),
    ("payment_events_currency_check", event_in),
]


@pytest.mark.parametrize("currency", ["mxn", "MX", "MXNN", "M1N", ""])
@pytest.mark.parametrize(
    ("constraint", "add"), CURRENCY_HOLDERS, ids=[name for name, _ in CURRENCY_HOLDERS]
)
def test_currencies_are_iso_4217_codes(
    owner_db: Database, constraint: str, add: Callable[[Database, str], None], currency: str
) -> None:
    with violates(errors.CheckViolation, constraint):
        add(owner_db, currency)


@pytest.mark.parametrize(
    ("status", "paid_total"),
    [("pending", 0), ("expired", 0), ("partially_paid", 1), ("partially_paid", 99), ("paid", 100)],
)
def test_paid_total_agreeing_with_the_status_is_accepted(
    owner_db: Database, status: str, paid_total: int
) -> None:
    business = create_business(owner_db)
    with owner_db.tenant(context(business.id)) as conn:
        add_intent(conn, business.id, amount_minor=100, status=status, paid_total_minor=paid_total)


@pytest.mark.parametrize(
    ("status", "paid_total"),
    [
        ("pending", 1),
        ("expired", 1),
        ("pending", -1),
        ("partially_paid", 0),
        ("partially_paid", 100),
        ("paid", 99),
        ("paid", 101),
    ],
)
def test_paid_total_disagreeing_with_the_status_is_rejected(
    owner_db: Database, status: str, paid_total: int
) -> None:
    # payments-core: paid_total never exceeds the amount and the status follows from it.
    business = create_business(owner_db)
    with (
        violates(errors.CheckViolation, "payment_intents_paid_total_check"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_intent(conn, business.id, amount_minor=100, status=status, paid_total_minor=paid_total)


def test_the_principal_of_an_intent_is_its_business(owner_db: Database) -> None:
    business, other = create_business(owner_db), create_business(owner_db)
    with (
        violates(errors.CheckViolation, "payment_intents_principal_check"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_intent(conn, business.id, principal_id=other.id)


def test_attempts_take_their_creation_time_from_the_domain(owner_db: Database) -> None:
    # Attempt.created_at comes from the injected Clock and expires_at is checked against it, so
    # the repository persists it and the database supplies no default of its own.
    business = create_business(owner_db)
    later = datetime.now(UTC) + timedelta(days=1)
    with (
        pytest.raises(errors.NotNullViolation) as caught,
        owner_db.tenant(context(business.id)) as conn,
    ):
        insert(
            conn,
            "payment_attempts",
            {
                "business_id": business.id,
                "id": uuid4(),
                "intent_id": business.intent_id,
                "rail": "codi_push",
                "expires_at": later,
            },
        )
    assert caught.value.diag.column_name == "created_at"


def test_attempts_have_a_positive_or_open_amount_and_expire_after_creation(
    owner_db: Database,
) -> None:
    business = create_business(owner_db)
    with owner_db.tenant(context(business.id)) as conn:
        add_attempt(conn, business.id, business.intent_id, rail="codi_qr", amount_minor=None)
    with (
        violates(errors.CheckViolation, "payment_attempts_amount_check"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_attempt(conn, business.id, business.intent_id, amount_minor=0)
    with (
        violates(errors.CheckViolation, "payment_attempts_expiry_check"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_attempt(conn, business.id, business.intent_id, expires_at=T0)


def test_payment_events_carry_a_positive_amount(owner_db: Database) -> None:
    business = create_business(owner_db)
    with (
        violates(errors.CheckViolation, "payment_events_amount_check"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_event(conn, business.id, amount_minor=0)


def test_business_deposit_and_durations_are_positive(owner_db: Database) -> None:
    for column, constraint in (
        ("deposit_minor", "business_deposit_check"),
        ("service_minutes", "business_minutes_check"),
        ("slot_minutes", "business_minutes_check"),
    ):
        with violates(errors.CheckViolation, constraint):
            create_business(owner_db, **{column: 0})


# --- personal data: hashes and last digits only ---


@pytest.mark.parametrize(
    "clabe", [MASKED_CLABE, "******5678", "5678", None], ids=["clabe", "phone", "short", "absent"]
)
def test_payment_events_keep_the_payer_account_masked(
    owner_db: Database, clabe: str | None
) -> None:
    business = create_business(owner_db)
    metadata = {} if clabe is None else {"clabe": clabe}
    with owner_db.tenant(context(business.id)) as conn:
        add_event(conn, business.id, raw=Jsonb({"metadata": metadata}))


@pytest.mark.parametrize(
    "clabe",
    [CLABE, int(CLABE), "5512345678", "1234*5678", "*1234*5678"],
    ids=["clabe", "number", "phone", "inner-star", "partly-masked"],
)
def test_payment_events_reject_an_unmasked_payer_account(
    owner_db: Database, clabe: str | int
) -> None:
    business = create_business(owner_db)
    with (
        violates(errors.CheckViolation, "payment_events_clabe_check"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_event(conn, business.id, raw=Jsonb({"metadata": {"clabe": clabe}}))


@pytest.mark.parametrize(
    ("hashed_phone", "last4", "constraint"),
    [
        ("5512345678", "5678", "bookings_phone_hash_check"),
        (phone_hash("5512345678").upper(), "5678", "bookings_phone_hash_check"),
        (phone_hash("5512345678"), "12345678", "bookings_phone_last4_check"),
        (phone_hash("5512345678"), "56a8", "bookings_phone_last4_check"),
    ],
    ids=["raw-phone", "uppercase-hash", "long-last4", "non-digit-last4"],
)
def test_bookings_store_a_phone_hash_and_last_four_digits_only(
    owner_db: Database, hashed_phone: str, last4: str, constraint: str
) -> None:
    business = create_business(owner_db)
    with (
        violates(errors.CheckViolation, constraint),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_booking(
            conn,
            business.id,
            business.resource_id,
            T0,
            phone_hash=hashed_phone,
            phone_last4=last4,
        )


def test_session_and_invitation_tokens_are_stored_as_sha256_hashes(owner_db: Database) -> None:
    business = create_business(owner_db)
    raw_token = secrets.token_urlsafe(32).encode()
    with (
        violates(errors.CheckViolation, "sessions_token_hash_check"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_session(conn, token_hash=raw_token)
    with (
        violates(errors.CheckViolation, "invitations_token_hash_check"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_invitation(conn, business.id, token_hash=raw_token)


# --- platform tables ---


@pytest.mark.parametrize("slug", ["estudio-demo", "abc", "a1-b2-c3", "x" * 40])
def test_well_formed_slugs_are_accepted(owner_db: Database, slug: str) -> None:
    create_business(owner_db, slug=slug)


@pytest.mark.parametrize(
    "slug", ["ab", "x" * 41, "Estudio", "-abc", "abc-", "a--b", "estudio demo", "estudio_demo"]
)
def test_malformed_slugs_are_rejected(owner_db: Database, slug: str) -> None:
    with violates(errors.CheckViolation, "business_slug_check"):
        create_business(owner_db, slug=slug)


def test_slugs_are_unique(owner_db: Database) -> None:
    create_business(owner_db, slug="estudio-demo")
    with violates(errors.UniqueViolation, "business_slug_key"):
        create_business(owner_db, slug="estudio-demo")


def test_emails_are_unique_ignoring_case(owner_db: Database) -> None:
    with owner_db.system() as conn:
        add_user(conn, "Owner@Example.com")
    with violates(errors.UniqueViolation, "users_email_key"), owner_db.system() as conn:
        add_user(conn, "owner@example.com")


def test_one_pey_connection_per_business(owner_db: Database) -> None:
    business = create_business(owner_db)
    with (
        violates(errors.UniqueViolation, "pey_connections_business_id_key"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        add_connection(conn, business.id)


def test_a_verified_pey_connection_records_when(owner_db: Database) -> None:
    business = create_business(owner_db)
    with (
        violates(errors.CheckViolation, "pey_connections_verified_check"),
        owner_db.tenant(context(business.id)) as conn,
    ):
        conn.execute(
            "UPDATE pey_connections SET status = 'verified' WHERE id = %s",
            (business.connection_id,),
        )


def test_audit_events_is_the_toolkit_table(owner_db: Database) -> None:
    with owner_db.system() as conn:
        rows = conn.execute(
            "SELECT column_name::text FROM information_schema.columns"
            " WHERE table_schema = 'public' AND table_name = 'audit_events'"
            " ORDER BY ordinal_position"
        ).fetchall()
    assert [name for (name,) in rows] == list(AuditEvent.model_fields)


def test_the_audit_schema_0001_runs_is_pinned() -> None:
    # 0001 reads schema.sql from the installed toolkit when it runs, so a toolkit upgrade that
    # edits it would give new databases a different audit table than migrated ones. On a change:
    # review the diff, put it in a new migration, then update the pin.
    schema = files("agent_toolkit.audit_log.adapters").joinpath("schema.sql").read_bytes()
    assert sha256(schema).hexdigest() == AUDIT_SCHEMA_SHA256


# --- the rules every tenant table follows (spec §5b, §12b) ---


def test_every_tenant_table_belongs_to_a_business(owner_db: Database) -> None:
    with owner_db.system() as conn:
        rows = conn.execute(
            """
            SELECT c.relname::text, a.attnotnull, format_type(a.atttypid, a.atttypmod),
                   EXISTS (SELECT 1 FROM pg_constraint f
                           WHERE f.conrelid = c.oid AND f.contype = 'f'
                             AND f.confrelid = 'business'::regclass
                             AND f.conkey = ARRAY[a.attnum])
            FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
            WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
              AND a.attname = 'business_id' AND NOT a.attisdropped
            """
        ).fetchall()
    assert {table for table, *_ in rows} == TENANT_TABLES
    assert {tuple(rest) for _, *rest in rows} == {(True, "uuid", True)}


def test_tenant_table_indexes_lead_with_the_business(owner_db: Database) -> None:
    with owner_db.system() as conn:
        rows = conn.execute(
            """
            SELECT i.indexrelid::regclass::text, a.attname::text
            FROM pg_index i
            JOIN pg_class c ON c.oid = i.indrelid
            LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
            WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(%s)
            """,
            (list(TENANT_TABLES),),
        ).fetchall()
    assert len(rows) > len(TENANT_TABLES)
    assert {index for index, first in rows if first != "business_id"} == NOT_LED_BY_BUSINESS


# --- the migration itself (spec §12b: forward-only, tested empty and with data) ---


def schema(conn: PgConnection) -> list[str]:
    return [line for (line,) in conn.execute(SCHEMA).fetchall()]


def version(conn: PgConnection) -> str:
    row = conn.execute("SELECT version_num FROM alembic_version").fetchone()
    assert row is not None
    revision: str = row[0]
    return revision


def test_upgrading_an_empty_database_creates_every_table(
    migrated_database: OwnedDatabase,
) -> None:
    with psycopg.connect(migrated_database.owner_url) as conn:
        tables = conn.execute(
            "SELECT tablename::text FROM pg_tables WHERE schemaname = 'public'"
        ).fetchall()
        extensions = conn.execute("SELECT extname::text FROM pg_extension").fetchall()
        assert version(conn) == "0001"
    assert {name for (name,) in tables} == TABLES | {"alembic_version"}
    assert ("btree_gist",) in extensions


def seed_every_table(db: Database) -> UUID:
    """One business with at least one row in every table; returns its id."""
    business = create_business(db)
    with db.tenant(context(business.id)) as conn:
        add_event(conn, business.id, intent_id=business.intent_id, attempt_id=business.attempt_id)
        add_flag(conn, business.id, booking_id=business.booking_id)
        add_webhook(conn, business.id, business.connection_id, "wh1")
        add_idempotency_key(conn, business.id, "key-1")
        insert(
            conn,
            "outbox",
            {
                "business_id": business.id,
                "id": uuid4(),
                "topic": f"board:{business.id}",
                "payload": Jsonb({"type": "booking", "status": "confirmed"}),
            },
        )
        add_membership(conn, business.id)
        add_session(conn)
        add_invitation(conn, business.id)
        insert(conn, "rate_limits", {"key": "hold:ip:203.0.113.7", "window_start": T0, "count": 1})
        insert(
            conn,
            "audit_events",
            {
                "seq": 1,
                "actor_id": "seed",
                "actor_kind": "system",
                "action": "test.seeded",
                "subject": str(business.id),
                "payload_hash": "a" * 64,
                "decision": None,
                "at": T0,
                "prev_hash": "0" * 64,
                "hash": "b" * 64,
            },
        )
    return business.id


def row_counts(db: Database, business_id: UUID) -> dict[str, int]:
    counts: dict[str, int] = {}
    with db.tenant(context(business_id)) as conn:
        for table in sorted(TABLES):
            row = conn.execute(
                sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(table))
            ).fetchone()
            assert row is not None
            counts[table] = row[0]
    return counts


@contextmanager
def owner_database(owner_url: str) -> Iterator[Database]:
    database = Database(Settings(env="test", database_url=SecretStr(owner_url)))
    database.open(wait=True)
    try:
        yield database
    finally:
        database.close()


@pytest.fixture(scope="module")
def fresh_owner_url(database_at: DatabaseFactory) -> Iterator[str]:
    """A database of this module's own at head, so upgrading it again touches no other test."""
    with database_at(MIGRATIONS_DIR) as database:
        yield database.owner_url


def test_upgrading_again_is_a_no_op_that_keeps_the_data(
    fresh_owner_url: str, alembic_as_owner: RunAlembic
) -> None:
    with owner_database(fresh_owner_url) as database:
        business_id = seed_every_table(database)
        counts = row_counts(database, business_id)
        with database.system() as conn:
            before = schema(conn)
        alembic_as_owner(fresh_owner_url, command.upgrade, "head")
        assert row_counts(database, business_id) == counts
        with database.system() as conn:
            assert schema(conn) == before
            assert version(conn) == "0001"
    assert min(counts.values()) >= 1, "the fixture data must reach every table"


def test_downgrading_is_refused(fresh_owner_url: str, alembic_as_owner: RunAlembic) -> None:
    with owner_database(fresh_owner_url) as database:
        with database.system() as conn:
            before = schema(conn)
        with pytest.raises(NotImplementedError, match="forward-only"):
            alembic_as_owner(fresh_owner_url, command.downgrade, "base")
        with database.system() as conn:
            assert schema(conn) == before
            assert version(conn) == "0001"
