"""Connection pools and the transactions every query runs in (spec §5b, §12b).

The service connects as `pialy_app`: not a superuser, not a table owner, no BYPASSRLS.
Tenant rows are reached only inside `tenant(ctx)`, whose transaction starts by setting
`app.business_id` with `set_config(..., true)`: the value lives for that transaction only, and
row-level security reads it. A connection goes back to its pool reset to its login role and its
session defaults, so nothing set for the session (even by mistake) reaches the next checkout.

A role that row-level security does not bind (a superuser, BYPASSRLS) would see every business,
and a session without the time limits could hold a connection or a lock without bound: startup
refuses either, and the pools serve no such connection.
"""

import logging
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from uuid import UUID

import psycopg
from psycopg import Connection
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import TupleRow
from psycopg_pool import ConnectionPool

from pialy.config import Settings
from pialy.tenancy.context import TenantContext

logger = logging.getLogger("pialy.db")

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
# The limits by parameter, in milliseconds: the unit pg_settings keeps all three in.
SESSION_LIMITS_MS: Mapping[str, int] = {
    "statement_timeout": STATEMENT_TIMEOUT_SECONDS * 1000,
    "lock_timeout": LOCK_TIMEOUT_SECONDS * 1000,
    "idle_in_transaction_session_timeout": IDLE_IN_TRANSACTION_TIMEOUT_SECONDS * 1000,
}
# The limits as startup options (`-c name=value`, libpq's `options`), so they are the session's
# defaults: what RESET ALL returns to, unlike a SET run after connecting.
SESSION_LIMITS = " ".join(f"-c {name}={ms}ms" for name, ms in SESSION_LIMITS_MS.items())
# What vetting a connection reads, in one query: whether its role bypasses row-level security,
# and the limits its session carries, in milliseconds by name. Its one parameter: those names.
SESSION_CHECK_SQL = (
    "SELECT rolsuper OR rolbypassrls,"
    " (SELECT json_object_agg(name, setting::int) FROM pg_settings WHERE name = ANY(%s))"
    " FROM pg_roles WHERE rolname = current_user"
)

type PgConnection = Connection[TupleRow]


class PrivilegedRoleError(RuntimeError):
    """The database role is one row-level security does not bind (spec §5b)."""

    def __init__(self) -> None:
        super().__init__(
            "the database role is a superuser or has BYPASSRLS, so row-level security would not"
            " hold: connect as pialy_app"
        )


class SessionLimitsError(RuntimeError):
    """The session does not carry SESSION_LIMITS, the time limits the service connects with."""

    def __init__(self) -> None:
        super().__init__(
            "the database session does not carry the service's time limits (statement_timeout,"
            " lock_timeout, idle_in_transaction_session_timeout): something between the service"
            " and Postgres, such as a pooler, may be dropping the startup options"
        )


def _vet_connection(connection: PgConnection) -> None:
    """Raise unless RLS binds the role of `connection` and its session carries SESSION_LIMITS.

    PrivilegedRoleError for the role, SessionLimitsError for the limits, and `connection` is
    closed on any failure, the query's own included. Startup runs it on a connection of its own,
    and each pool as `configure`: a connection it raises on is never added to the pool, and the
    pool does not close it.
    """
    try:
        with connection.transaction():
            row = connection.execute(SESSION_CHECK_SQL, (list(SESSION_LIMITS_MS),)).fetchone()
        if row is None or row[0] is not False:
            raise PrivilegedRoleError
        if row[1] != SESSION_LIMITS_MS:
            raise SessionLimitsError
    except BaseException:
        connection.close()
        raise


def _with_session_limits(conninfo: str) -> str:
    """`conninfo` with SESSION_LIMITS after its own startup options, which it keeps."""
    own = conninfo_to_dict(conninfo).get("options")
    return make_conninfo(conninfo, options=f"{own} {SESSION_LIMITS}" if own else SESSION_LIMITS)


def _reset_session(connection: PgConnection) -> None:
    """A connection goes back to its pool as it came: its login role, session defaults, no lock.

    DISCARD ALL's sequence (postgresql.org/docs/current/sql-discard.html) without what pialy
    does not use (cursors, prepared statements, LISTEN, temporary tables): RESET ALL leaves
    `role` and `session_authorization` alone, so SET SESSION AUTHORIZATION DEFAULT comes first.
    DISCARD ALL itself cannot run in the transaction the reset needs on the main pool.
    """
    with connection.transaction():
        connection.execute("SET SESSION AUTHORIZATION DEFAULT")
        connection.execute("RESET ALL")
        connection.execute("SELECT pg_advisory_unlock_all()")


class Database:
    def __init__(self, settings: Settings) -> None:
        self._conninfo = conninfo = _with_session_limits(settings.database_url.get_secret_value())
        # Both pools vet each connection they open (its role and time limits) and check it
        # before serving it (one empty query), so one the server dropped while it sat idle (a
        # restart, an idle cutoff) is replaced, not handed out.
        self._pool: ConnectionPool[PgConnection] = ConnectionPool(
            conninfo,
            kwargs={"connect_timeout": CONNECT_TIMEOUT_SECONDS},
            min_size=POOL_MIN_SIZE,
            max_size=POOL_MAX_SIZE,
            open=False,
            configure=_vet_connection,
            check=ConnectionPool.check_connection,
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
            configure=_vet_connection,
            check=ConnectionPool.check_connection,
            reset=_reset_session,
            timeout=LOCK_POOL_TIMEOUT_SECONDS,
            name="pialy-locks",
        )

    @property
    def max_size(self) -> int:
        """The most connections the main pool holds; request threads must not exceed it."""
        return self._pool.max_size

    def vet_connection(self) -> None:
        """Raise PrivilegedRoleError or SessionLimitsError where the pools would refuse.

        For startup, on a connection of its own. A database it cannot reach is logged, by the
        error's type only, and left to readiness: the pools vet every connection they open.
        """
        try:
            connection = psycopg.connect(self._conninfo, connect_timeout=CONNECT_TIMEOUT_SECONDS)
        except psycopg.Error as error:
            # The type only: libpq's message, raised or logged, can quote the connection string.
            logger.warning("database connection not vetted at startup: %s", type(error).__name__)
            return
        with connection:
            _vet_connection(connection)

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
