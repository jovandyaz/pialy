import time
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, ExitStack
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg import errors, sql
from psycopg.conninfo import make_conninfo
from psycopg_pool import PoolTimeout

from pialy.db.database import (
    SESSION_LIMITS,
    Database,
    PgConnection,
    SessionLimitsError,
    _vet_connection,
)
from pialy.db.locks import advisory_key
from pialy.tenancy.context import OwnerActor, TenantContext
from tests.db.support import ThrowawayDatabase, app_settings, database_at_url

# A transaction-local setting reads as '' (not NULL) on that connection once it has ended,
# hence nullif, as the policies of Task 5 do.
BUSINESS_SETTING = "SELECT nullif(current_setting('app.business_id', true), '')"
USER_SETTING = "SELECT nullif(current_setting('app.user_id', true), '')"
TIME_LIMITS = (
    "SELECT current_setting('statement_timeout'), current_setting('lock_timeout'),"
    " current_setting('idle_in_transaction_session_timeout')"
)
# What a checkout must find whatever the connection's last user set for its session.
SESSION_STATE = (
    "SELECT nullif(current_setting('app.business_id', true), ''),"
    " current_setting('statement_timeout'), current_setting('lock_timeout'),"
    " current_setting('idle_in_transaction_session_timeout')"
)
CLEAN_SESSION = (None, "5s", "2s", "15s")
# Who a checkout runs as: 'none' is the role setting when no SET ROLE is in effect.
SESSION_ROLE = "SELECT current_user, current_setting('role')"
# A returned connection is reset in the background before the pool serves it again.
RETURN_DEADLINE_SECONDS = 5.0

type Checkout = Callable[[], AbstractContextManager[PgConnection]]


def owner_context(business_id: UUID) -> TenantContext:
    return TenantContext(business_id=business_id, actor=OwnerActor(user_id=uuid4()))


def rows_until_served_again(checkout: Checkout, query: str, backend_pid: int) -> set[object]:
    """`query`'s row on every checkout until the pool serves `backend_pid` again.

    The pool serves its idle connections in turn, so that one comes back after a few checkouts.
    One that never comes back fails the test: a discarded connection proves nothing about what a
    reused one keeps.
    """
    rows: set[object] = set()
    deadline = time.monotonic() + RETURN_DEADLINE_SECONDS
    while time.monotonic() < deadline:
        with checkout() as connection:
            rows.add(connection.execute(query).fetchone())
            if connection.info.backend_pid == backend_pid:
                return rows
    pytest.fail(f"the pool did not serve backend {backend_pid} again", pytrace=False)


def test_tenant_transaction_sets_business_setting_locally(db: Database) -> None:
    business_id = uuid4()
    with db.tenant(owner_context(business_id)) as connection:
        assert connection.execute(BUSINESS_SETTING).fetchone() == (str(business_id),)
        backend_pid = connection.info.backend_pid
    assert rows_until_served_again(db.system, BUSINESS_SETTING, backend_pid) == {(None,)}


def test_user_transaction_sets_user_setting_locally(db: Database) -> None:
    user_id = uuid4()
    with db.user(user_id) as connection:
        assert connection.execute(USER_SETTING).fetchone() == (str(user_id),)
        assert connection.execute(BUSINESS_SETTING).fetchone() == (None,)
        backend_pid = connection.info.backend_pid
    assert rows_until_served_again(db.system, USER_SETTING, backend_pid) == {(None,)}


def test_tenant_transaction_cannot_be_committed_midway(db: Database) -> None:
    # Every statement in the block runs in the one transaction that carries the business.
    business_id = uuid4()
    with db.tenant(owner_context(business_id)) as connection:
        with pytest.raises(psycopg.ProgrammingError):
            connection.commit()
        assert connection.execute(BUSINESS_SETTING).fetchone() == (str(business_id),)


def test_tenant_transaction_rolls_back_on_error(db: Database) -> None:
    # A session-level setting survives a commit but not a rollback.
    probe = "SELECT nullif(current_setting('app.probe', true), '')"
    with pytest.raises(RuntimeError), db.tenant(owner_context(uuid4())) as connection:
        connection.execute("SELECT set_config('app.probe', 'kept', false)")
        backend_pid = connection.info.backend_pid
        raise RuntimeError("boom")
    assert rows_until_served_again(db.system, probe, backend_pid) == {(None,)}


def test_session_settings_do_not_outlive_their_checkout(db: Database) -> None:
    # set_config(..., false) or SET in a committed transaction lasts for the session; the pool
    # resets it, and the time limits are what the reset returns to.
    with db.tenant(owner_context(uuid4())) as connection:
        connection.execute("SELECT set_config('app.business_id', %s, false)", (str(uuid4()),))
        connection.execute("SET statement_timeout = '1min'")
        connection.execute("SET lock_timeout = 0")
        backend_pid = connection.info.backend_pid
    assert rows_until_served_again(db.system, SESSION_STATE, backend_pid) == {CLEAN_SESSION}


def test_lock_connection_settings_do_not_outlive_their_checkout(db: Database) -> None:
    with db.lock_connection() as connection:
        connection.execute("SELECT set_config('app.business_id', %s, false)", (str(uuid4()),))
        connection.execute("SET idle_in_transaction_session_timeout = 0")
        backend_pid = connection.info.backend_pid
    rows = rows_until_served_again(db.lock_connection, SESSION_STATE, backend_pid)
    assert rows == {CLEAN_SESSION}


def test_the_time_limits_join_the_startup_options_of_the_url(
    migrated_database: ThrowawayDatabase,
) -> None:
    # The URL's own options stay; the service's limits come after them, so they prevail.
    options = "-c work_mem=8MB -c statement_timeout=1min"
    with database_at_url(make_conninfo(migrated_database.app_url, options=options)) as database:
        for checkout in (database.system, database.lock_connection):
            with checkout() as connection:
                limits = connection.execute(TIME_LIMITS).fetchone()
                work_mem = connection.execute("SELECT current_setting('work_mem')").fetchone()
            assert (limits, work_mem) == (("5s", "2s", "15s"), ("8MB",))


@pytest.mark.parametrize(
    "options",
    [
        pytest.param("", id="dropped"),  # as a pooler that drops the startup options would
        pytest.param(f"{SESSION_LIMITS} -c statement_timeout=1min", id="statement"),
        pytest.param(f"{SESSION_LIMITS} -c lock_timeout=0", id="lock"),
        pytest.param(f"{SESSION_LIMITS} -c idle_in_transaction_session_timeout=1h", id="idle"),
    ],
)
def test_a_connection_without_the_time_limits_is_refused_and_closed(
    migrated_database: ThrowawayDatabase, options: str
) -> None:
    with psycopg.connect(migrated_database.app_url, options=options) as connection:
        with pytest.raises(SessionLimitsError, match="time limits"):
            _vet_connection(connection)
        assert connection.closed


def test_startup_refuses_a_session_without_the_time_limits(
    migrated_database: ThrowawayDatabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The service's options never reach the server, as behind a pooler that drops them.
    monkeypatch.setattr("pialy.db.database.SESSION_LIMITS", "")
    database = Database(app_settings(migrated_database.app_url))
    with pytest.raises(SessionLimitsError):
        database.vet_connection()


def terminate(url: str, backend_pid: int) -> None:
    """End a backend from the server side, as a restart or an idle cutoff would."""
    with psycopg.connect(url, autocommit=True) as connection:
        connection.execute("SELECT pg_terminate_backend(%s)", (backend_pid,))
        deadline = time.monotonic() + RETURN_DEADLINE_SECONDS
        while time.monotonic() < deadline:
            gone = connection.execute(
                "SELECT NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = %s)", (backend_pid,)
            ).fetchone()
            if gone == (True,):
                return
            time.sleep(0.05)
    pytest.fail(f"backend {backend_pid} did not end", pytrace=False)


@pytest.fixture
def member_role(admin_url: str) -> Iterator[str]:
    """A role made for the test that pialy_app is a member of, so it may SET ROLE to it."""
    role = f"pialy_test_member_{uuid4().hex[:8]}"
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE ROLE {}").format(sql.Identifier(role)))
        admin.execute(sql.SQL("GRANT {} TO pialy_app").format(sql.Identifier(role)))
    try:
        yield role
    finally:
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(role)))


@pytest.mark.parametrize("pool", ["main", "locks"])
def test_a_session_role_does_not_outlive_its_checkout(
    migrated_database: ThrowawayDatabase, member_role: str, pool: str
) -> None:
    # RESET ALL leaves role and session_authorization as they are (both NO_RESET_ALL).
    with database_at_url(migrated_database.app_url) as database:
        checkout: Checkout = database.system if pool == "main" else database.lock_connection
        with checkout() as connection:
            connection.execute(sql.SQL("SET ROLE {}").format(sql.Identifier(member_role)))
            assert connection.execute(SESSION_ROLE).fetchone() == (member_role, member_role)
            backend_pid = connection.info.backend_pid
        rows = rows_until_served_again(checkout, SESSION_ROLE, backend_pid)
    assert rows == {("pialy_app", "none")}


@pytest.mark.parametrize("pool", ["main", "locks"])
def test_a_connection_the_server_dropped_is_never_served(
    db: Database, migrated_database: ThrowawayDatabase, pool: str
) -> None:
    checkout: Checkout = db.system if pool == "main" else db.lock_connection
    with checkout() as connection:
        dropped = connection.info.backend_pid
    # The pool resets a returned connection in the background (milliseconds); the server drops
    # this one only once it sits idle in the pool, as after a restart.
    time.sleep(0.5)
    terminate(migrated_database.app_url, dropped)
    for _ in range(2 * db.max_size):  # more checkouts than the pool holds connections
        with checkout() as connection:
            assert connection.execute("SELECT 1").fetchone() == (1,)
            assert connection.info.backend_pid != dropped


def test_statement_timeout_applies(db: Database) -> None:
    with pytest.raises(errors.QueryCanceled), db.system() as connection:
        connection.execute("SELECT pg_sleep(6)")


def test_every_connection_carries_the_time_limits(db: Database) -> None:
    with db.system() as connection:
        assert connection.execute(TIME_LIMITS).fetchone() == ("5s", "2s", "15s")
    with db.lock_connection() as connection:
        assert connection.execute(TIME_LIMITS).fetchone() == ("5s", "2s", "15s")


def test_app_role_cannot_bypass_rls(db: Database) -> None:
    with db.system() as connection:
        row = connection.execute(
            "SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user"
        ).fetchone()
    assert row == ("pialy_app", False, False)


def test_app_role_owns_nothing_and_cannot_create_tables(db: Database) -> None:
    with db.system() as connection:
        owned = connection.execute(
            "SELECT count(*) FROM pg_class WHERE relowner = 'pialy_app'::regrole"
        ).fetchone()
        assert owned == (0,)
        with pytest.raises(errors.InsufficientPrivilege):
            connection.execute("CREATE TABLE public.intruder (n int)")


def test_lock_connection_holds_session_locks_outside_transactions(db: Database) -> None:
    key = advisory_key("sweeper", f"test-{uuid4()}")
    with db.lock_connection() as connection:
        assert connection.autocommit
        assert connection.execute("SELECT pg_try_advisory_lock(%s)", (key,)).fetchone() == (True,)
        with db.system() as other:
            taken = other.execute("SELECT pg_try_advisory_xact_lock(%s)", (key,)).fetchone()
            assert taken == (False,)
        connection.execute("SELECT pg_advisory_unlock(%s)", (key,))


def test_lock_connection_returns_to_the_pool_without_its_locks(db: Database) -> None:
    key = advisory_key("relay", f"test-{uuid4()}")
    with db.lock_connection() as connection:
        connection.execute("SELECT pg_advisory_lock(%s)", (key,))  # never unlocked
    deadline = time.monotonic() + 2
    while True:
        with db.system() as other:
            free = other.execute("SELECT pg_try_advisory_xact_lock(%s)", (key,)).fetchone()
        if free == (True,) or time.monotonic() > deadline:
            break
        time.sleep(0.05)
    assert free == (True,)


def seconds_to_time_out(
    connect: Callable[[], AbstractContextManager[object]], holders: int
) -> float:
    """Hold `holders` connections from `connect`, then time how long one more waits."""
    with ExitStack() as held:
        for _ in range(holders):
            held.enter_context(connect())
        started = time.monotonic()
        with pytest.raises(PoolTimeout), connect():
            pass
        return time.monotonic() - started


# Room above a timeout for a loaded test machine; psycopg's default wait (30 s) stays far out.
WALL_CLOCK_SLACK_SECONDS = 5


def test_waiting_for_a_connection_is_bounded(db: Database) -> None:
    # A request gives up after 3 s instead of psycopg's default 30 s (Review Focus 3).
    waited = seconds_to_time_out(db.system, holders=10)
    assert 3 <= waited < 3 + WALL_CLOCK_SLACK_SECONDS


def test_waiting_for_a_lock_connection_is_bounded_by_lock_timeout(db: Database) -> None:
    waited = seconds_to_time_out(db.lock_connection, holders=4)
    assert 2 <= waited < 2 + WALL_CLOCK_SLACK_SECONDS
