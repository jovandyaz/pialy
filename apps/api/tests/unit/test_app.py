from datetime import timedelta

import pytest
from anyio import to_thread
from fastapi.testclient import TestClient
from psycopg_pool import PoolClosed, PoolTimeout

from pialy.clock import system_clock
from pialy.config import Settings
from pialy.db.database import Database
from pialy.main import create_app

UNREACHABLE_DB = "postgresql://u:p@127.0.0.1:1/none"


def test_system_clock_is_aware_utc() -> None:
    now = system_clock()
    assert now.utcoffset() == timedelta(0)


def test_create_app_has_only_the_health_routes_and_its_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ENV", "test")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@localhost/db")
    settings = Settings()
    app = create_app(settings, system_clock)
    assert app.title == "pialy"
    assert sorted(app.openapi()["paths"]) == ["/healthz", "/readyz"]
    with TestClient(app) as client:  # the generated docs are switched off, not just unlisted
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert client.get(path).status_code == 404
    assert app.state.settings is settings
    assert app.state.clock is system_clock


def test_threadpool_is_no_larger_than_the_connection_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENV", "test")
    monkeypatch.setenv("DATABASE_URL", UNREACHABLE_DB)
    app = create_app(Settings(), system_clock, readiness=lambda: True)

    @app.get("/threads")
    async def threads() -> dict[str, float]:
        return {"total": to_thread.current_default_thread_limiter().total_tokens}

    with TestClient(app) as client:
        assert client.get("/threads").json() == {"total": 10}
    assert app.state.database.max_size == 10


def test_database_opens_with_the_app_and_closes_on_shutdown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ENV", "test")
    monkeypatch.setenv("DATABASE_URL", UNREACHABLE_DB)
    app = create_app(Settings(), system_clock, readiness=lambda: True)
    database: Database = app.state.database
    # Open: the pool takes requests, it just cannot reach this database.
    with TestClient(app), pytest.raises(PoolTimeout), database.system(timeout=0.2):
        pass
    with pytest.raises(PoolClosed), database.system(timeout=0.2):
        pass
