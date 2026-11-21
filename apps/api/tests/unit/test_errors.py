import sys
import types

import pytest

from pialy.config import Settings
from pialy.observability.errors import init_error_reporting, scrub_event
from pialy.observability.logging import redact

PHONE = "5512345678"
EMAIL = "a@b.mx"
TOKEN = "3f9a" * 8
BOOKING_TOKEN = "Zx9QbW1kT2tlbl9TZWNyZXQ"
# SDK identifiers, each of a shape the redaction would rewrite if it reached them.
EVENT_ID = "47f4e4aaa0f147dc81fed2f53d876854"  # uuid4 hex: a 32-character token
TRACE_ID = "2bd22504edb64baebf766517d3de813f"
SPAN_ID = "1234567890abcdef"  # 10 digits in a row
PARENT_SPAN_ID = "a170d50753f5ea30"
CHILD_SPAN_ID = "5512345678901234"
RELEASE = "0123456789abcdef0123456789abcdef01234567"  # a git SHA
PUBLIC_KEY = "f" * 32  # the DSN's public key
TIMESTAMP = "2026-11-21T09:00:36.772088Z"
THREAD_ID = "8422760832"


def dig(value: object, *path: str | int) -> object:
    for step in path:
        if isinstance(step, int):
            assert isinstance(value, list)
            value = value[step]
        else:
            assert isinstance(value, dict)
            value = value[step]
    return value


def trace_context() -> dict[str, object]:
    return {
        "trace_id": TRACE_ID,
        "span_id": SPAN_ID,
        "parent_span_id": PARENT_SPAN_ID,
        "op": "http.server",
        "description": f"lookup {PHONE}",
        "data": {"thread.id": THREAD_ID, "thread.name": "MainThread"},
        "dynamic_sampling_context": {
            "trace_id": TRACE_ID,
            "release": RELEASE,
            "public_key": PUBLIC_KEY,
            "transaction": f"/c/{BOOKING_TOKEN}",
        },
    }


def error_event() -> dict[str, object]:
    """The shape sentry-sdk 2.75 hands to `before_send` (captured locally, values synthetic)."""
    return {
        "event_id": EVENT_ID,
        "timestamp": TIMESTAMP,
        "release": RELEASE,
        "dist": "7",
        "environment": "production",
        "level": "error",
        "platform": "python",
        "transaction": "/api/b/{slug}/bookings/{token}",
        "contexts": {"trace": trace_context()},
        "request": {
            "method": "GET",
            "url": f"http://testserver/api/b/panaderia/bookings/{BOOKING_TOKEN}",
            "query_string": f"phone={PHONE}&mail={EMAIL}",
        },
        "exception": {
            "values": [
                {
                    "type": "ValueError",
                    "value": f"no booking for {PHONE} ({EMAIL})",
                    "stacktrace": {
                        "frames": [
                            {"function": "hold", "lineno": 17, "vars": {"token": f"'{TOKEN}'"}}
                        ]
                    },
                }
            ]
        },
        "breadcrumbs": {
            "values": [
                {
                    "timestamp": TIMESTAMP,
                    "type": "log",
                    "category": "pialy.http",
                    "level": "warning",
                    "message": f"retry for {EMAIL}",
                    "data": {},
                }
            ]
        },
        "extra": {"event_id": PHONE, "release": EMAIL},  # user data under SDK names stays scrubbed
    }


def test_the_sdk_identifiers_in_the_fixture_would_not_survive_redaction() -> None:
    for identifier in (EVENT_ID, TRACE_ID, SPAN_ID, CHILD_SPAN_ID, RELEASE, PUBLIC_KEY, THREAD_ID):
        assert redact(identifier) != identifier


def test_scrub_event_keeps_sdk_identifiers_and_scrubs_user_content() -> None:
    scrubbed = scrub_event(error_event(), {})
    assert scrubbed["event_id"] == EVENT_ID
    assert scrubbed["timestamp"] == TIMESTAMP
    assert scrubbed["release"] == RELEASE
    assert scrubbed["dist"] == "7"
    trace = dig(scrubbed, "contexts", "trace")
    assert dig(trace, "trace_id") == TRACE_ID
    assert dig(trace, "span_id") == SPAN_ID
    assert dig(trace, "parent_span_id") == PARENT_SPAN_ID
    assert dig(trace, "data", "thread.id") == THREAD_ID
    assert dig(trace, "dynamic_sampling_context", "trace_id") == TRACE_ID
    assert dig(trace, "dynamic_sampling_context", "release") == RELEASE
    assert dig(trace, "dynamic_sampling_context", "public_key") == PUBLIC_KEY
    assert dig(scrubbed, "breadcrumbs", "values", 0, "timestamp") == TIMESTAMP

    assert dig(trace, "description") == "lookup [digits]"
    assert dig(trace, "dynamic_sampling_context", "transaction") == "/c/Zx9Q…"
    assert dig(scrubbed, "request", "url") == "http://testserver/api/b/panaderia/bookings/Zx9Q…"
    assert dig(scrubbed, "request", "query_string") == "phone=[digits]&mail=[email]"
    assert dig(scrubbed, "exception", "values", 0, "value") == "no booking for [digits] ([email])"
    assert dig(scrubbed, "exception", "values", 0, "stacktrace", "frames", 0, "vars") == {
        "token": "'[token]'"
    }
    assert dig(scrubbed, "breadcrumbs", "values", 0, "message") == "retry for [email]"
    assert scrubbed["extra"] == {"event_id": "[digits]", "release": "[email]"}
    for leaked in (PHONE, EMAIL, TOKEN, BOOKING_TOKEN):
        assert leaked not in str(scrubbed)


def test_scrub_event_keeps_span_identifiers_of_a_transaction() -> None:
    transaction: dict[str, object] = {
        "type": "transaction",
        "event_id": EVENT_ID,
        "start_timestamp": TIMESTAMP,
        "timestamp": TIMESTAMP,
        "release": RELEASE,
        "contexts": {"trace": trace_context()},
        "spans": [
            {
                "trace_id": TRACE_ID,
                "span_id": CHILD_SPAN_ID,
                "parent_span_id": SPAN_ID,
                "start_timestamp": TIMESTAMP,
                "timestamp": TIMESTAMP,
                "op": "db",
                "description": f"hold slot for '{PHONE}'",
                "data": {"thread.id": THREAD_ID},
            }
        ],
    }
    scrubbed = scrub_event(transaction, {})
    assert scrubbed["start_timestamp"] == TIMESTAMP
    assert dig(scrubbed, "spans", 0) == {
        "trace_id": TRACE_ID,
        "span_id": CHILD_SPAN_ID,
        "parent_span_id": SPAN_ID,
        "start_timestamp": TIMESTAMP,
        "timestamp": TIMESTAMP,
        "op": "db",
        "description": "hold slot for '[digits]'",
        "data": {"thread.id": THREAD_ID},
    }


def test_scrub_event_truncates_a_token_in_the_query_string() -> None:
    event: dict[str, object] = {
        "request": {"query_string": f"token={BOOKING_TOKEN}&phone={PHONE}"},
    }
    scrubbed = scrub_event(event, {})
    assert dig(scrubbed, "request", "query_string") == "token=Zx9Q…&phone=[digits]"


def test_scrub_event_keeps_file_and_module_names_of_frames() -> None:
    frames: list[dict[str, object]] = [
        {
            "filename": "starlette/_exception_handler.py",
            "abs_path": "/app/.venv/lib/python3.13/site-packages/starlette/_exception_handler.py",
            "module": "starlette._exception_handler",
            "function": "wrapped_app",
            "lineno": 42,
        },
        {
            "filename": "pialy/http/security_headers.py",
            "abs_path": "/app/src/pialy/http/security_headers.py",
            "module": "pialy.http.security_headers",
            "function": "send_with_headers",
            "lineno": 32,
        },
    ]
    event: dict[str, object] = {
        "exception": {"values": [{"type": "RuntimeError", "stacktrace": {"frames": frames}}]}
    }
    scrubbed = scrub_event(event, {})
    assert dig(scrubbed, "exception", "values", 0, "stacktrace", "frames") == frames


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


class RaisingStr:
    def __str__(self) -> str:
        raise RuntimeError("no text for you")


def test_scrub_event_never_raises_on_odd_values() -> None:
    event: dict[str, object] = {
        "message": f"call {PHONE}",
        "extra": {"raising": RaisingStr(), "big": 10**5000, 10**5000: "big key"},
        "list": [RaisingStr(), 10**5000, 3],
    }
    scrubbed = scrub_event(event, {})
    assert scrubbed["message"] == "call [digits]"
    assert scrubbed["extra"] == {
        "raising": "[unrepresentable]",
        "big": "[unrepresentable]",
        "[unrepresentable]": "big key",
    }
    assert scrubbed["list"] == ["[unrepresentable]", "[unrepresentable]", 3]


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
    assert call["before_send_transaction"] is scrub_event


def test_dsn_without_the_extra_fails_loudly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "sentry_sdk", None)
    with pytest.raises(RuntimeError, match="sentry"):
        init_error_reporting(settings(monkeypatch, SENTRY_DSN="https://key@example.invalid/1"))
