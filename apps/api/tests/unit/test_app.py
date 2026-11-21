from datetime import timedelta

import pytest

from pialy.clock import system_clock
from pialy.config import Settings
from pialy.main import create_app


def test_system_clock_is_aware_utc() -> None:
    now = system_clock()
    assert now.utcoffset() == timedelta(0)


def test_create_app_returns_app_without_routes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENV", "test")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@localhost/db")
    app = create_app(Settings(), system_clock)
    assert app.title == "pialy"
