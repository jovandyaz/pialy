"""Real-Postgres fixtures, under the two-role model.

TEST_DATABASE_URL is an admin (superuser) URL; `pnpm api:test` points it at the
docker-compose.test.yml Postgres. Without it these tests are skipped. The session gets its own
throwaway database owned by `pialy_owner`, migrated to head as `pialy_owner`, and served to the
tests as `pialy_app` (not superuser, not owner, no BYPASSRLS). The database is dropped at the end.
The two roles are cluster-wide and their passwords are reset to the synthetic ones below, so the
fixtures refuse (fail, not skip) a cluster that is not on this machine unless
PIALY_TEST_DB_DISPOSABLE=1 marks it disposable, as for a CI job that reaches its Postgres service
container by label. Loopback alone cannot tell the test cluster from a local dev one.
"""

import ipaddress
import os
from collections.abc import Callable, Iterator, Mapping
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from alembic import command
from alembic.config import Config
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from pydantic import SecretStr

from pialy.config import Settings
from pialy.db.database import Database

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "migrations"
SKIP_REASON = (
    "TEST_DATABASE_URL is not set: run `pnpm api:test` with docker-compose.test.yml up, "
    "or export it with an admin URL"
)
# Synthetic, test-only passwords; the roles live in the throwaway test cluster only.
ROLE_PASSWORDS = {"pialy_owner": "pialy-owner-test-only", "pialy_app": "pialy-app-test-only"}
ROLES_LOCK_KEY = 7_400_231  # serializes role setup between test sessions sharing a cluster
DISPOSABLE_OPT_IN = "PIALY_TEST_DB_DISPOSABLE"

type AppDatabaseFactory = Callable[[Path], AbstractContextManager[str]]


@dataclass(frozen=True)
class ThrowawayDatabase:
    name: str
    owner_url: str
    app_url: str


def ensure_roles(admin_url: str) -> None:
    """Create the two roles if missing and (re)assert their attributes and passwords."""
    with psycopg.connect(admin_url) as connection:
        connection.execute("SELECT pg_advisory_xact_lock(%s)", (ROLES_LOCK_KEY,))
        for role, password in ROLE_PASSWORDS.items():
            exists = connection.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (role,))
            if exists.fetchone() is None:
                connection.execute(sql.SQL("CREATE ROLE {}").format(sql.Identifier(role)))
            connection.execute(
                sql.SQL(
                    "ALTER ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
                    " PASSWORD {}"
                ).format(sql.Identifier(role), sql.Literal(password))
            )


def migrate(owner_url: str, migrations_dir: Path) -> None:
    """`alembic upgrade head` as the owner, through migrations/env.py like the deploy does."""
    config = Config()  # no ini file, so env.py leaves the test run's logging alone
    config.set_main_option("script_location", str(migrations_dir))
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("MIGRATION_DATABASE_URL", owner_url)
        command.upgrade(config, "head")


def grant_version_read(owner_url: str) -> None:
    """Let pialy_app read alembic_version for /readyz.

    Stand-in until Task 5's migration grants it; then this goes and the migration is tested.
    """
    with psycopg.connect(owner_url) as connection:
        if connection.execute("SELECT to_regclass('alembic_version')").fetchone() != (None,):
            connection.execute("GRANT SELECT ON alembic_version TO pialy_app")


def truncate_tables(owner_url: str) -> None:
    """Empty every table but alembic_version, as the owner (TRUNCATE is not subject to RLS)."""
    with psycopg.connect(owner_url) as connection:
        rows = connection.execute(
            "SELECT tablename FROM pg_tables"
            " WHERE schemaname = 'public' AND tablename <> 'alembic_version'"
        ).fetchall()
        if rows:
            tables = sql.SQL(", ").join(sql.Identifier(name) for (name,) in rows)
            connection.execute(sql.SQL("TRUNCATE {} RESTART IDENTITY CASCADE").format(tables))


@contextmanager
def throwaway_database(admin_url: str, migrations_dir: Path) -> Iterator[ThrowawayDatabase]:
    """A new database owned by pialy_owner, at head of `migrations_dir`, dropped on exit."""
    ensure_roles(admin_url)
    name = f"pialy_test_{uuid4().hex[:12]}"
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {} OWNER pialy_owner").format(sql.Identifier(name)))
    try:
        database = ThrowawayDatabase(
            name=name,
            owner_url=make_conninfo(
                admin_url, dbname=name, user="pialy_owner", password=ROLE_PASSWORDS["pialy_owner"]
            ),
            app_url=make_conninfo(
                admin_url, dbname=name, user="pialy_app", password=ROLE_PASSWORDS["pialy_app"]
            ),
        )
        migrate(database.owner_url, migrations_dir)
        grant_version_read(database.owner_url)
        yield database
    finally:
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


def app_settings(app_url: str) -> Settings:
    return Settings(env="test", database_url=SecretStr(app_url))


def _is_on_this_machine(host: str) -> bool:
    if host in ("", "localhost") or host.startswith("/"):  # no host or a path: a Unix socket
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _refuse_unless_disposable(admin_url: str, environ: Mapping[str, str]) -> None:
    """Fail unless the cluster is on this machine or explicitly marked disposable."""
    if environ.get(DISPOSABLE_OPT_IN) == "1":
        return
    params = conninfo_to_dict(admin_url)
    hosts = [
        host.strip()
        for key in ("host", "hostaddr")
        for host in str(params.get(key) or "").split(",")
    ]
    remote = sorted({host for host in hosts if not _is_on_this_machine(host)})
    if remote:
        pytest.fail(
            f"TEST_DATABASE_URL points at {', '.join(remote)}, not at this machine. The db "
            "fixtures reset the pialy_owner and pialy_app passwords cluster-wide, so they only run "
            "against localhost, 127.0.0.1 or ::1, or a cluster marked disposable with "
            f"{DISPOSABLE_OPT_IN}=1.",
            pytrace=False,
        )


@pytest.fixture(scope="session")
def refuse_unless_disposable() -> Callable[[str, Mapping[str, str]], None]:
    return _refuse_unless_disposable


@pytest.fixture(scope="session")
def admin_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip(SKIP_REASON)
    _refuse_unless_disposable(url, os.environ)
    return url


@pytest.fixture(scope="session")
def migrated_database(admin_url: str) -> Iterator[ThrowawayDatabase]:
    with throwaway_database(admin_url, MIGRATIONS_DIR) as database:
        yield database


@pytest.fixture(scope="session")
def app_database(migrated_database: ThrowawayDatabase) -> Iterator[Database]:
    database = Database(app_settings(migrated_database.app_url))
    database.open(wait=True)
    try:
        yield database
    finally:
        database.close()


@pytest.fixture
def db(app_database: Database, migrated_database: ThrowawayDatabase) -> Database:
    """The session's Database as pialy_app, with every table emptied before the test."""
    truncate_tables(migrated_database.owner_url)
    return app_database


@pytest.fixture(scope="session")
def app_database_at(admin_url: str) -> AppDatabaseFactory:
    """A further throwaway database at head of the given migrations; yields pialy_app's URL."""

    @contextmanager
    def factory(migrations_dir: Path) -> Iterator[str]:
        with throwaway_database(admin_url, migrations_dir) as database:
            yield database.app_url

    return factory
