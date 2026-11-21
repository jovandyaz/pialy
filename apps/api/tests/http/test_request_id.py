"""An incoming `X-Request-Id` is untrusted: it is logged and echoed, so it must not carry PII."""

import json
import re
import uuid

import pytest
from fastapi.testclient import TestClient

from pialy.clock import system_clock
from pialy.config import Settings
from pialy.http.request_context import resolve_request_id
from pialy.main import create_app
from pialy.observability.logging import configure_logging

PHONE = "5512345678"
FRESH_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")


@pytest.mark.parametrize(
    "incoming",
    [
        PHONE,
        "123456789012345678",  # a CLABE
        "55-1234-5678",  # a phone with hyphens
        "0121-8001-2345-6789-12",  # a CLABE with hyphens
        "req-5512345678-x",
        "5512345678abc",
        f"{PHONE}-0000-0000-0000-000000000000",  # 36 characters, but not a UUID's 8-4-4-4-12
        "12345678123412341234123456789012",  # 32 digits without hyphens: not the canonical form
    ],
)
def test_incoming_ids_with_a_run_of_10_or_more_digits_are_replaced(incoming: str) -> None:
    resolved = resolve_request_id(incoming)
    assert resolved != incoming
    assert FRESH_UUID.fullmatch(resolved)


@pytest.mark.parametrize(
    "incoming",
    [
        "abc-12345678",  # 8 digits
        "req-ABCdef123456",
        "551234567",  # 9 digits
        "55-1234-567",  # 9 digits once the hyphens are gone
        "12345-6789-abcd",
        "12345678-1234-1234-1234-123456789012",  # canonical UUID whose last group is 12 digits
        "3F2504E0-4F89-11D3-9A0C-0305E82C3301",  # upper case
        "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    ],
)
def test_other_well_formed_incoming_ids_are_kept(incoming: str) -> None:
    assert resolve_request_id(incoming) == incoming


@pytest.mark.parametrize(
    "incoming",
    [
        "3f9a" * 8,  # 32 hex characters: a token, not an id
        "AbCdEfGhIjKlMnOpQrStUvWxYz012345",  # 32 characters, 6 digits: a token too
        "5512----345678",  # 10 digits spread by hyphens too wide for `redact` to join
    ],
)
def test_incoming_ids_that_redaction_would_change_are_replaced(incoming: str) -> None:
    resolved = resolve_request_id(incoming)
    assert resolved != incoming
    assert FRESH_UUID.fullmatch(resolved)


def test_a_32_hex_request_id_is_neither_echoed_nor_logged(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], json_logs: None
) -> None:
    token = "3f9a" * 8
    monkeypatch.setenv("ENV", "test")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/none")
    configure_logging("INFO")
    with TestClient(create_app(Settings(), system_clock, lambda: True)) as client:
        response = client.get("/healthz", headers={"X-Request-Id": token})
    assert FRESH_UUID.fullmatch(response.headers["x-request-id"])
    assert token not in capsys.readouterr().out


def test_uuids_are_always_kept_even_when_their_digits_run_long() -> None:
    # About 1 in 11 UUIDs has a run of 10 or more decimal digits (hyphens removed): they are
    # identifiers, not PII, and must not be replaced. Name-based ids keep the test deterministic.
    ids = [str(uuid.uuid5(uuid.NAMESPACE_DNS, str(number))) for number in range(2_000)]
    with_long_runs = [value for value in ids if re.search(r"\d{10,}", value.replace("-", ""))]
    assert len(with_long_runs) > 50  # the case under test really occurs
    assert all(resolve_request_id(value) == value for value in ids)


def test_a_missing_or_malformed_id_gets_a_fresh_uuid() -> None:
    assert FRESH_UUID.fullmatch(resolve_request_id(None))
    assert FRESH_UUID.fullmatch(resolve_request_id("short"))


def test_a_phone_sent_as_request_id_is_neither_echoed_nor_logged(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], json_logs: None
) -> None:
    monkeypatch.setenv("ENV", "test")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/none")
    configure_logging("INFO")
    app = create_app(Settings(), system_clock, lambda: True)
    with TestClient(app) as client:
        response = client.get("/nope", headers={"X-Request-Id": PHONE})
    rid = response.headers["x-request-id"]
    assert FRESH_UUID.fullmatch(rid)
    assert response.json()["requestId"] == rid
    assert PHONE not in response.text
    assert PHONE not in str(response.headers)
    out = capsys.readouterr().out
    assert PHONE not in out
    app_lines = [json.loads(line) for line in out.splitlines() if '"pialy.http"' in line]
    assert app_lines
    assert all(line["request_id"] == rid for line in app_lines)
