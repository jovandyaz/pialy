"""The service never runs as a role that row-level security does not bind (spec §5b)."""

import logging
from collections.abc import Iterator
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg_pool import PoolTimeout

from pialy.clock import system_clock
from pialy.db.database import Database, PrivilegedRoleError
from pialy.main import create_app
from tests.db.support import ThrowawayDatabase, app_settings

PASSWORD_MARKER = "privileged-role-marker"


@pytest.fixture(params=["SUPERUSER", "BYPASSRLS"])
def privileged_url(
    request: pytest.FixtureRequest, admin_url: str, migrated_database: ThrowawayDatabase
) -> Iterator[str]:
    """The URL of a role made for the test with one attribute that bypasses row-level security."""
    attribute: str = request.param
    role = f"pialy_test_{attribute.lower()}_{uuid4().hex[:8]}"
    password = f"{PASSWORD_MARKER}-{uuid4().hex}"
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(
            sql.SQL("CREATE ROLE {} LOGIN {} PASSWORD {}").format(
                sql.Identifier(role), sql.SQL(attribute), sql.Literal(password)
            )
        )
    try:
        yield make_conninfo(migrated_database.app_url, user=role, password=password)
    finally:
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(role)))


def test_the_app_refuses_to_start_as_a_privileged_role(privileged_url: str) -> None:
    app = create_app(app_settings(privileged_url), system_clock)
    with pytest.raises(PrivilegedRoleError) as refused, TestClient(app):
        pass
    message = str(refused.value)
    assert "superuser or has BYPASSRLS" in message
    assert PASSWORD_MARKER not in message
    assert privileged_url not in message


def test_the_app_starts_as_pialy_app(migrated_database: ThrowawayDatabase) -> None:
    app = create_app(app_settings(migrated_database.app_url), system_clock)
    with TestClient(app) as client:
        assert client.get("/healthz").status_code == 200


def test_the_pools_serve_no_connection_of_a_privileged_role(
    privileged_url: str, caplog: pytest.LogCaptureFixture
) -> None:
    # Startup checks once; the pools check every connection they open, so a role that is only
    # reachable later (the database was down at startup) is refused all the same.
    caplog.set_level(logging.WARNING, logger="psycopg.pool")
    database = Database(app_settings(privileged_url))
    database.open()
    try:
        with pytest.raises(PoolTimeout), database.system(timeout=1):
            pass
        with pytest.raises(PoolTimeout), database.lock_connection():
            pass
    finally:
        database.close()
    assert "superuser or has BYPASSRLS" in caplog.text
    assert PASSWORD_MARKER not in caplog.text
