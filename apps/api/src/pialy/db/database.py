"""Connection pools and the transactions every query runs in (spec §5b, §12b).

The service connects as `pialy_app`: not a superuser, not a table owner, no BYPASSRLS.
Tenant rows are reached only inside `tenant(ctx)`, whose transaction starts by setting
`app.business_id` with `set_config(..., true)`: the value lives for that transaction only, and
row-level security reads it. A connection goes back to its pool reset to its session defaults,
so nothing set for the session (even by mistake) reaches the next checkout.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from uuid import UUID

from psycopg import Connection
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import TupleRow
from psycopg_pool import ConnectionPool

from pialy.config import Settings
from pialy.tenancy.context import TenantContext

POOL_MIN_SIZE = 2
POOL_MAX_SIZE = 10
LOCK_POOL_MIN_SIZE = 1
LOCK_POOL_MAX_SIZE = 4
CONNECT_TIMEOUT_SECONDS = 5
# Session limits of every pooled connection.
STATEMENT_TIMEOUT_SECONDS = 5
LOCK_TIMEOUT_SECONDS = 2
IDLE_IN_TRANSACTION_TIMEOUT_SECONDS = 15
# Longest wait for a pooled connection before PoolTimeout (psycopg's default is 30 s), so a
# request fails fast when the pool is exhausted or the database is down.
POOL_TIMEOUT_SECONDS = 3.0
# Waiting for a lock connection is bounded like waiting for the lock itself (lock_timeout).
LOCK_POOL_TIMEOUT_SECONDS = float(LOCK_TIMEOUT_SECONDS)
# The limits as startup options (`-c name=value`, libpq's `options`), so they are the session's
# defaults: what RESET ALL returns to, unlike a SET run after connecting.
SESSION_LIMITS = (
    f"-c statement_timeout={STATEMENT_TIMEOUT_SECONDS}s"
    f" -c lock_timeout={LOCK_TIMEOUT_SECONDS}s"
    f" -c idle_in_transaction_session_timeout={IDLE_IN_TRANSACTION_TIMEOUT_SECONDS}s"
)

type PgConnection = Connection[TupleRow]


def _with_session_limits(conninfo: str) -> str:
    """`conninfo` with SESSION_LIMITS after its own startup options, which it keeps."""
    own = conninfo_to_dict(conninfo).get("options")
    return make_conninfo(conninfo, options=f"{own} {SESSION_LIMITS}" if own else SESSION_LIMITS)


def _reset_session(connection: PgConnection) -> None:
    """A connection goes back to its pool as it came: session defaults, no session lock."""
    with connection.transaction():
        connection.execute("RESET ALL")
        connection.execute("SELECT pg_advisory_unlock_all()")


class Database:
    def __init__(self, settings: Settings) -> None:
        conninfo = _with_session_limits(settings.database_url.get_secret_value())
        self._pool: ConnectionPool[PgConnection] = ConnectionPool(
            conninfo,
            kwargs={"connect_timeout": CONNECT_TIMEOUT_SECONDS},
            min_size=POOL_MIN_SIZE,
            max_size=POOL_MAX_SIZE,
            open=False,
            reset=_reset_session,
            timeout=POOL_TIMEOUT_SECONDS,
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
            reset=_reset_session,
            timeout=LOCK_POOL_TIMEOUT_SECONDS,
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

        `timeout` bounds the wait for a pooled connection (POOL_TIMEOUT_SECONDS otherwise).
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
