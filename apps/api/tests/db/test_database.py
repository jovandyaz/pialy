import time
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, ExitStack, contextmanager
from typing import Protocol
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg import errors
from psycopg.conninfo import make_conninfo
from psycopg_pool import PoolTimeout
from pydantic import SecretStr

from pialy.config import Settings
from pialy.db.database import Database, PgConnection
from pialy.db.locks import advisory_key
from pialy.tenancy.context import OwnerActor, TenantContext

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
# A returned connection is reset in the background before the pool serves it again.
RETURN_DEADLINE_SECONDS = 5.0

type Checkout = Callable[[], AbstractContextManager[PgConnection]]


class AppUrl(Protocol):
    @property
    def app_url(self) -> str: ...


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


@contextmanager
def database_for(url: str) -> Iterator[Database]:
    database = Database(Settings(env="test", database_url=SecretStr(url)))
    database.open(wait=True)
    try:
        yield database
    finally:
        database.close()


def test_the_time_limits_join_the_startup_options_of_the_url(
    db: Database, migrated_database: AppUrl
) -> None:
    # The URL's own options stay; the service's limits come after them, so they prevail.
    options = "-c work_mem=8MB -c statement_timeout=1min"
    with database_for(make_conninfo(migrated_database.app_url, options=options)) as database:
        for checkout in (database.system, database.lock_connection):
            with checkout() as connection:
                limits = connection.execute(TIME_LIMITS).fetchone()
                work_mem = connection.execute("SELECT current_setting('work_mem')").fetchone()
            assert (limits, work_mem) == (("5s", "2s", "15s"), ("8MB",))


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


def test_waiting_for_a_connection_is_bounded(db: Database) -> None:
    # A request gives up after 3 s instead of psycopg's default 30 s (Review Focus 3).
    waited = seconds_to_time_out(db.system, holders=10)
    assert 3 <= waited < 4


def test_waiting_for_a_lock_connection_is_bounded_by_lock_timeout(db: Database) -> None:
    waited = seconds_to_time_out(db.lock_connection, holders=4)
    assert 2 <= waited < 3
