from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from pialy.clock import system_clock
from pialy.config import Settings
from pialy.main import create_app


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
