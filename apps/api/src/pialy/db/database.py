"""Connection pools and the transactions every query runs in (spec §5b, §12b).

The service connects as `pialy_app`: not a superuser, not a table owner, no BYPASSRLS.
Tenant rows are reached only inside `tenant(ctx)`, whose transaction starts by setting
`app.business_id` with `set_config(..., true)`: the value lives for that transaction only, so a
pooled connection never carries it into the next one, and row-level security reads it.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from uuid import UUID

from psycopg import Connection
from psycopg.rows import TupleRow
from psycopg_pool import ConnectionPool

from pialy.config import Settings
from pialy.tenancy.context import TenantContext

POOL_MIN_SIZE = 2
POOL_MAX_SIZE = 10
LOCK_POOL_MIN_SIZE = 1
LOCK_POOL_MAX_SIZE = 4
CONNECT_TIMEOUT_SECONDS = 5

type PgConnection = Connection[TupleRow]


def _set_time_limits(connection: PgConnection) -> None:
    """Session limits for every pooled connection, set once when the pool opens it."""
    with connection.transaction():
        connection.execute("SET statement_timeout = '5s'")
        connection.execute("SET lock_timeout = '2s'")
        connection.execute("SET idle_in_transaction_session_timeout = '15s'")


def _release_advisory_locks(connection: PgConnection) -> None:
    """Safety net: a lock connection goes back to the pool holding no session lock."""
    connection.execute("SELECT pg_advisory_unlock_all()")


class Database:
    def __init__(self, settings: Settings) -> None:
        conninfo = settings.database_url.get_secret_value()
        self._pool: ConnectionPool[PgConnection] = ConnectionPool(
            conninfo,
            kwargs={"connect_timeout": CONNECT_TIMEOUT_SECONDS},
            min_size=POOL_MIN_SIZE,
            max_size=POOL_MAX_SIZE,
            open=False,
            configure=_set_time_limits,
            name="pialy",
        )
        # Session-level advisory locks outlive transactions, so these connections autocommit
        # and never sit idle in a transaction while a lock is held.
        self._lock_pool: ConnectionPool[PgConnection] = ConnectionPool(
            conninfo,
            kwargs={"connect_timeout": CONNECT_TIMEOUT_SECONDS, "autocommit": True},
            min_size=LOCK_POOL_MIN_SIZE,
            max_size=LOCK_POOL_MAX_SIZE,
            open=False,
            configure=_set_time_limits,
            reset=_release_advisory_locks,
            name="pialy-locks",
        )

    @property
    def max_size(self) -> int:
        """The most connections the main pool holds; request threads must not exceed it."""
        return self._pool.max_size

    def open(self, wait: bool = False) -> None:
        """Start both pools. With `wait`, raise unless their first connections arrive in time."""
        self._pool.open(wait=wait)
        self._lock_pool.open(wait=wait)

    def close(self) -> None:
        self._pool.close()
        self._lock_pool.close()

    @contextmanager
    def tenant(self, ctx: TenantContext) -> Iterator[PgConnection]:
        """One transaction inside `ctx`'s business; policies hide every other business."""
        with self._transaction() as connection:
            connection.execute(
                "SELECT set_config('app.business_id', %s, true)", (str(ctx.business_id),)
            )
            yield connection

    @contextmanager
    def user(self, user_id: UUID) -> Iterator[PgConnection]:
        """One transaction as `user_id` and no business: their memberships, at login."""
        with self._transaction() as connection:
            connection.execute("SELECT set_config('app.user_id', %s, true)", (str(user_id),))
            yield connection

    @contextmanager
    def system(self, timeout: float | None = None) -> Iterator[PgConnection]:
        """One transaction with no business: only definer functions and non-tenant tables.

        `timeout` bounds the wait for a pooled connection (the pool's default otherwise).
        """
        with self._transaction(timeout) as connection:
            yield connection

    @contextmanager
    def lock_connection(self) -> Iterator[PgConnection]:
        """An autocommit connection of its own, for session-level advisory locks."""
        with self._lock_pool.connection() as connection:
            yield connection

    @contextmanager
    def _transaction(self, timeout: float | None = None) -> Iterator[PgConnection]:
        # transaction() commits on success, rolls back on error, and forbids commit() inside,
        # so no statement of the block can run outside the settings made at its start.
        with self._pool.connection(timeout=timeout) as connection, connection.transaction():
            yield connection
