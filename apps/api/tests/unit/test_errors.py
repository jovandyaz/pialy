import sys
import types

import pytest

from pialy.config import Settings
from pialy.observability.errors import init_error_reporting, scrub_event

PHONE = "5512345678"


def settings(monkeypatch: pytest.MonkeyPatch, **env: str) -> Settings:
    monkeypatch.setenv("ENV", "test")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@localhost/db")
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    return Settings()


def test_scrub_event_redacts_every_string_in_the_event() -> None:
    event: dict[str, object] = {
        "message": f"call {PHONE}",
        "exception": {"values": [{"value": f"bad {PHONE}", "stacktrace": {"lineno": 3}}]},
    }
    scrubbed = scrub_event(event, {})
    assert PHONE not in str(scrubbed)
    assert scrubbed["exception"] == {
        "values": [{"value": "bad [digits]", "stacktrace": {"lineno": 3}}]
    }


def test_scrub_event_redacts_dict_keys_and_non_string_values() -> None:
    event: dict[str, object] = {
        "exception": {
            "values": [
                {
                    "stacktrace": {
                        "frames": [
                            {
                                "lineno": 3,
                                "vars": {
                                    "phone": int(PHONE),
                                    "ratio": 0.5,
                                    "count": 3,
                                    "ok": True,
                                    "nothing": None,
                                    PHONE: "by key",
                                    "a@b.mx": "by email key",
                                },
                            }
                        ]
                    }
                }
            ]
        }
    }
    scrubbed = scrub_event(event, {})
    assert PHONE not in str(scrubbed)
    assert "a@b.mx" not in str(scrubbed)
    exception = scrubbed["exception"]
    assert isinstance(exception, dict)
    frame = exception["values"][0]["stacktrace"]["frames"][0]
    assert frame["lineno"] == 3
    assert frame["vars"] == {
        "phone": "[digits]",
        "ratio": 0.5,
        "count": 3,
        "ok": True,
        "nothing": None,
        "[email]": "by email key",
        "[digits]": "by key",
    }


def test_scrub_event_recurses_into_tuples_and_keeps_their_type() -> None:
    event: dict[str, object] = {
        "extra": (f"call {PHONE}", [int(PHONE), {"k": (int(PHONE),)}], 7),
    }
    scrubbed = scrub_event(event, {})
    assert scrubbed["extra"] == ("call [digits]", ["[digits]", {"k": ("[digits]",)}], 7)


def test_no_dsn_does_not_import_sentry(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "sentry_sdk", None)  # an import would raise
    init_error_reporting(settings(monkeypatch))


def test_dsn_initialises_sentry_without_pii(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []
    fake = types.ModuleType("sentry_sdk")
    fake.init = lambda **kwargs: calls.append(kwargs)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "sentry_sdk", fake)
    init_error_reporting(settings(monkeypatch, SENTRY_DSN="https://key@example.invalid/1"))
    [call] = calls
    assert call["dsn"] == "https://key@example.invalid/1"
    assert call["send_default_pii"] is False
    assert call["before_send"] is scrub_event


def test_dsn_without_the_extra_fails_loudly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "sentry_sdk", None)
    with pytest.raises(RuntimeError, match="sentry"):
        init_error_reporting(settings(monkeypatch, SENTRY_DSN="https://key@example.invalid/1"))
