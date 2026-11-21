import json
import logging
import re
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from pialy.clock import system_clock
from pialy.config import Settings
from pialy.http.problems import ProblemError
from pialy.main import create_app
from pialy.observability.logging import bind, configure_logging
from pialy.observability.readiness import database_readiness

CSP = "default-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'"
UNREACHABLE_DB = "postgresql://u:p@127.0.0.1:1/none"
PHONE = "5512345678"


def make_app(
    monkeypatch: pytest.MonkeyPatch,
    env: str = "test",
    readiness: Callable[[], bool] | None = None,
) -> FastAPI:
    monkeypatch.setenv("ENV", env)
    monkeypatch.setenv("DATABASE_URL", UNREACHABLE_DB)
    if env == "production":
        monkeypatch.setenv("PEY_BASE_URL", "https://pey.example.invalid")
        monkeypatch.setenv("PUBLIC_ORIGIN", "https://pialy.example.invalid")
        monkeypatch.setenv("PHONE_HASH_SALT", "s" * 16)
        monkeypatch.setenv("SESSION_SECRET", "s" * 32)
        monkeypatch.setenv("AUDIT_HMAC_KEY", "a" * 32)
        monkeypatch.setenv("CREDENTIALS_ENC_KEY", "A" * 43 + "=")
    app = create_app(Settings(), system_clock, readiness)

    @app.get("/boom")
    def boom() -> None:
        raise RuntimeError(f"secret internal detail {PHONE}")

    @app.get("/bookings/{token}")
    def booking(token: str) -> dict[str, str]:
        bind(business_id="biz-1")
        logging.getLogger("handler").info("looked up")
        return {"ok": "yes"}

    @app.get("/teapot")
    def teapot() -> None:
        raise ProblemError(418, "urn:pialy:problem:teapot", "I'm a teapot", "short and stout")

    return app


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    with TestClient(make_app(monkeypatch), raise_server_exceptions=False) as test_client:
        yield test_client


def test_healthz_reports_ok(client: TestClient) -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def readiness_failures(capsys: pytest.CaptureFixture[str]) -> list[dict[str, str]]:
    parsed = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line]
    return [line for line in parsed if line["message"].startswith("readiness check failed")]


def test_readyz_is_503_when_database_is_unreachable(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    json_logs: None,
    migrations_at_head: Path,
) -> None:
    # The migrations have a head, so only the unreachable database can make the check fail.
    readiness = database_readiness(UNREACHABLE_DB, migrations_at_head)
    configure_logging("INFO")
    with TestClient(make_app(monkeypatch, readiness=readiness)) as test_client:
        response = test_client.get("/readyz")
    assert response.status_code == 503
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["status"] == 503
    [failure] = readiness_failures(capsys)
    assert failure["message"] == "readiness check failed: OperationalError"


def test_readyz_logs_only_the_error_type_never_the_connection_string(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], json_logs: None
) -> None:
    # libpq quotes the connection string, password included, in its parse errors.
    readiness = database_readiness("postgresql://u:dsn-marker-pw@[bad/db")
    configure_logging("INFO")
    with TestClient(make_app(monkeypatch, readiness=readiness)) as test_client:
        assert test_client.get("/readyz").status_code == 503
    out = capsys.readouterr().out
    assert "dsn-marker-pw" not in out
    [failure] = [json.loads(line) for line in out.splitlines() if "readiness" in line]
    assert failure["message"] == "readiness check failed: ProgrammingError"
    assert failure["level"] == "ERROR"
    assert "exc" not in failure


def test_readyz_is_200_with_a_passing_check(monkeypatch: pytest.MonkeyPatch) -> None:
    with TestClient(make_app(monkeypatch, readiness=lambda: True)) as test_client:
        response = test_client.get("/readyz")
    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


def test_a_falsy_readiness_check_is_still_used(monkeypatch: pytest.MonkeyPatch) -> None:
    class FalsyCheck:
        def __bool__(self) -> bool:
            return False

        def __call__(self) -> bool:
            return True

    with TestClient(make_app(monkeypatch, readiness=FalsyCheck())) as test_client:
        assert test_client.get("/readyz").status_code == 200


def test_readyz_is_503_when_the_check_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def failing() -> bool:
        raise OSError("down")

    with TestClient(make_app(monkeypatch, readiness=failing)) as test_client:
        assert test_client.get("/readyz").status_code == 503


def test_sets_security_headers(client: TestClient) -> None:
    headers = client.get("/healthz").headers
    assert headers["content-security-policy"] == CSP
    assert headers["x-content-type-options"] == "nosniff"
    assert headers["referrer-policy"] == "no-referrer"
    assert "strict-transport-security" not in headers


def test_sets_hsts_in_production_only(monkeypatch: pytest.MonkeyPatch) -> None:
    with TestClient(make_app(monkeypatch, env="production")) as prod:
        headers = prod.get("/healthz").headers
    assert headers["strict-transport-security"] == "max-age=31536000"


def test_security_headers_also_on_problems_and_errors(client: TestClient) -> None:
    for path in ("/nope", "/boom"):
        headers = client.get(path).headers
        assert headers["content-security-policy"] == CSP
        assert headers["x-request-id"]


def test_rfc9457_for_unknown_route(client: TestClient) -> None:
    response = client.get("/nope")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json() == {
        "type": "about:blank",
        "title": "Not Found",
        "status": 404,
        "requestId": response.headers["x-request-id"],
    }


def test_problem_error_renders_its_fields(client: TestClient) -> None:
    response = client.get("/teapot")
    assert response.status_code == 418
    assert response.json() == {
        "type": "urn:pialy:problem:teapot",
        "title": "I'm a teapot",
        "status": 418,
        "detail": "short and stout",
        "requestId": response.headers["x-request-id"],
    }


def test_method_not_allowed_is_a_problem(client: TestClient) -> None:
    response = client.post("/healthz")
    assert response.status_code == 405
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.headers["allow"] == "GET"


def test_validation_errors_are_422_problems_without_input_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = make_app(monkeypatch)

    @app.get("/items/{count}")
    def items(count: int) -> dict[str, int]:
        return {"count": count}

    with TestClient(app) as test_client:
        response = test_client.get(f"/items/{PHONE}x")
    body = response.json()
    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")
    assert PHONE not in response.text
    assert body["errors"] == [{"loc": ["path", "count"], "type": "int_parsing"}]


def test_hides_details_of_unexpected_errors(client: TestClient) -> None:
    response = client.get("/boom")
    assert response.status_code == 500
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json() == {
        "type": "about:blank",
        "title": "Internal Server Error",
        "status": 500,
        "requestId": response.headers["x-request-id"],
    }
    assert "secret internal detail" not in response.text
    assert "RuntimeError" not in response.text


def test_logs_unexpected_errors_redacted_with_the_request_id(
    client: TestClient, capsys: pytest.CaptureFixture[str], json_logs: None
) -> None:
    configure_logging("INFO")
    response = client.get("/boom")
    out = capsys.readouterr().out
    assert PHONE not in out
    errors = [json.loads(line) for line in out.splitlines() if '"ERROR"' in line]
    assert errors
    assert errors[0]["request_id"] == response.headers["x-request-id"]
    assert "RuntimeError" in errors[0]["exc"]


def test_request_id_header_and_problem_field_match(client: TestClient) -> None:
    response = client.get("/nope")
    request_id = response.headers["x-request-id"]
    assert response.json()["requestId"] == request_id
    assert re.fullmatch(r"[0-9a-f-]{36}", request_id)


def test_accepts_a_well_formed_incoming_request_id(client: TestClient) -> None:
    response = client.get("/nope", headers={"X-Request-Id": "abc-12345678"})
    assert response.headers["x-request-id"] == "abc-12345678"
    assert response.json()["requestId"] == "abc-12345678"


@pytest.mark.parametrize("bad", ["short", "has space 12345678", "x" * 65, "evilé-12345678"])
def test_replaces_a_malformed_incoming_request_id(client: TestClient, bad: str) -> None:
    response = client.get("/nope", headers=[(b"x-request-id", bad.encode("latin-1"))])
    assert response.headers["x-request-id"] != bad
    assert re.fullmatch(r"[0-9a-f-]{36}", response.headers["x-request-id"])


def log_lines(capsys: pytest.CaptureFixture[str]) -> list[dict[str, str]]:
    out = capsys.readouterr().out
    parsed = [json.loads(line) for line in out.splitlines() if line]
    # The test client logs its own "HTTP Request" lines; keep the app's.
    return [line for line in parsed if line["logger"] in ("pialy.http", "handler")]


def test_error_line_carries_request_id_route_and_bound_business(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], json_logs: None
) -> None:
    app = make_app(monkeypatch)

    @app.get("/stores/{store}/boom")
    def store_boom(store: str) -> None:
        bind(business_id="biz-9")  # runs in a threadpool copy of the context
        raise RuntimeError("nope")

    configure_logging("INFO")
    with TestClient(app, raise_server_exceptions=False) as test_client:
        response = test_client.get("/stores/abc/boom")
    rid = response.headers["x-request-id"]
    error, access = log_lines(capsys)
    assert error["level"] == "ERROR"
    assert access["level"] == "INFO"
    for line in (error, access):
        assert line["request_id"] == rid
        assert line["route"] == "/stores/{store}/boom"
        assert line["business_id"] == "biz-9"
    assert access["message"] == "GET /stores/{store}/boom 500"


def test_request_line_and_handler_line_carry_route_and_request_id(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], json_logs: None
) -> None:
    configure_logging("INFO")
    with TestClient(make_app(monkeypatch)) as test_client:
        response = test_client.get("/bookings/Zx9QbW1kT2tlbl9TZWNyZXQ")
    handler, access = log_lines(capsys)
    for line in (handler, access):
        assert line["route"] == "/bookings/{token}"
        assert line["request_id"] == response.headers["x-request-id"]
        assert line["business_id"] == "biz-1"
    assert access["message"] == "GET /bookings/{token} 200"
    assert "Zx9QbW1k" not in json.dumps([handler, access])


def test_unrouted_request_logs_the_redacted_raw_path(
    client: TestClient, capsys: pytest.CaptureFixture[str], json_logs: None
) -> None:
    configure_logging("INFO")
    client.get("/api/bookings/Zx9QbW1kT2tlbl9TZWNyZXQ/nope")
    [access] = log_lines(capsys)
    assert access["route"] == "/api/bookings/Zx9Q…/nope"
    assert access["message"] == "GET /api/bookings/Zx9Q…/nope 404"
