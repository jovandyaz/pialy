import json
import logging
from collections.abc import Iterator

import pytest

from pialy.observability.logging import (
    bind,
    configure_logging,
    log_event,
    redact,
    request_id,
)

PHONE = "5512345678"
EMAIL = "a@b.mx"
TOKEN = "3f9a" * 8  # 32 hex characters
CLABE = "123456789012345678"
BOOKING_TOKEN = "Zx9QbW1kT2tlbl9TZWNyZXQ"


@pytest.fixture(autouse=True)
def _restore_root(json_logs: None) -> None:
    return None


@pytest.fixture
def context() -> Iterator[None]:
    token = request_id.set("req-12345678")
    yield
    request_id.reset(token)


def lines(capsys: pytest.CaptureFixture[str]) -> list[dict[str, object]]:
    out = capsys.readouterr().out
    return [json.loads(line) for line in out.splitlines() if line]


def test_redacts_phone_email_token_key_and_clabe(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("INFO")
    secret_text = f"tel {PHONE} mail {EMAIL} tok {TOKEN} clabe {CLABE}"
    try:
        raise ValueError(secret_text)
    except ValueError as error:
        logging.getLogger("x").error("failed: %s", secret_text, exc_info=error)
    out = capsys.readouterr().out
    for leaked in (PHONE, EMAIL, TOKEN, CLABE, "123456789012"):
        assert leaked not in out
    assert "tel" in out
    assert "[digits]" in out
    assert "[email]" in out
    assert "[token]" in out


def test_redacts_exception_text_with_traceback(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("INFO")
    try:
        raise RuntimeError(f"boom {PHONE}")
    except RuntimeError:
        logging.getLogger("x").exception("unhandled")
    [line] = lines(capsys)
    assert PHONE not in json.dumps(line)
    assert "RuntimeError" in str(line["exc"])


def test_truncates_booking_token_in_url_to_4_chars() -> None:
    assert redact(f"GET /api/bookings/{BOOKING_TOKEN}/events 200") == (
        "GET /api/bookings/Zx9Q…/events 200"
    )
    assert redact(f"GET /c/{BOOKING_TOKEN}?x=1") == "GET /c/Zx9Q…?x=1"
    assert redact("GET /api/slots?date=2026-11-15") == "GET /api/slots?date=2026-11-15"


def test_every_line_carries_request_id_and_business_id(
    capsys: pytest.CaptureFixture[str], context: None
) -> None:
    configure_logging("INFO")
    bind(business_id="biz-1", route="/api/slots")
    logging.getLogger("x").info("one")
    log_event("payment.applied", amount=1, currency="MXN")
    first, second = lines(capsys)
    for line in (first, second):
        assert line["request_id"] == "req-12345678"
        assert line["business_id"] == "biz-1"
        assert line["route"] == "/api/slots"
    assert second["event"] == "payment.applied"
    assert second["amount"] == 1
    assert second["message"] == "payment.applied"


def test_event_fields_are_redacted_and_cannot_override_base_keys(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("INFO")
    log_event("x.happened", note=f"call {PHONE}", level="DEBUG")
    [line] = lines(capsys)
    assert PHONE not in json.dumps(line)
    assert line["level"] == "INFO"


def test_level_filters_and_rejects_unknown(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("warning")
    logging.getLogger("x").info("hidden")
    assert capsys.readouterr().out == ""
    with pytest.raises(ValueError, match="log level"):
        configure_logging("LOUD")


def test_uvicorn_loggers_flow_through_the_redacting_handler(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("INFO")
    logging.getLogger("uvicorn.access").info(f"GET /api/bookings/{BOOKING_TOKEN} 200")
    [line] = lines(capsys)
    assert BOOKING_TOKEN not in json.dumps(line)
