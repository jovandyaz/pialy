"""The request context (id, bound fields, route) belongs to one request and ends with it."""

import asyncio
import json
import logging
from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from starlette.types import Message, Scope

from pialy.clock import system_clock
from pialy.config import Settings
from pialy.main import create_app
from pialy.observability.logging import bind, configure_logging, request_id


def make_app(monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    monkeypatch.setenv("ENV", "test")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/none")
    return create_app(Settings(), system_clock, lambda: True)


def log_lines(capsys: pytest.CaptureFixture[str], logger: str) -> list[dict[str, object]]:
    parsed = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line]
    return [line for line in parsed if line["logger"] == logger]


def test_overlapping_requests_keep_their_own_id_and_bound_fields(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], json_logs: None
) -> None:
    app = make_app(monkeypatch)
    both_inside = asyncio.Barrier(2)

    @app.get("/who")
    async def who(request: Request) -> dict[str, str]:
        bind(caller=request.headers["x-caller"])
        await both_inside.wait()  # each request is in flight while the other binds and logs
        logging.getLogger("handler").info("handled")
        return {"ok": "yes"}

    async def run() -> None:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            await asyncio.gather(
                *(
                    client.get("/who", headers={"X-Request-Id": f"req-{n}0000000", "X-Caller": n})
                    for n in ("1", "2")
                )
            )

    configure_logging("INFO")
    asyncio.run(run())
    handled = log_lines(capsys, "handler")
    assert sorted((line["request_id"], line["caller"]) for line in handled) == [
        ("req-10000000", "1"),
        ("req-20000000", "2"),
    ]


def test_the_context_is_reset_once_the_request_ends(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], json_logs: None
) -> None:
    app = make_app(monkeypatch)

    @app.get("/bind")
    async def bind_route() -> dict[str, str]:
        bind(caller="1")
        return {"ok": "yes"}

    async def run() -> str:
        # ASGITransport runs the app in the caller's task: a value the middleware does not reset
        # would still be set here, and would tag every later line of this task.
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            await client.get("/bind", headers={"X-Request-Id": "req-30000000"})
        logging.getLogger("after").info("after the request")
        return request_id.get()

    configure_logging("INFO")
    assert asyncio.run(run()) == "-"
    [after] = log_lines(capsys, "after")
    assert after["request_id"] == "-"
    assert "caller" not in after
    assert "route" not in after


def test_an_error_after_the_response_started_is_logged_as_aborted(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], json_logs: None
) -> None:
    app = make_app(monkeypatch)

    @app.get("/broken-stream")
    async def broken_stream() -> StreamingResponse:
        async def chunks() -> AsyncIterator[bytes]:
            yield b"one\n"
            raise RuntimeError("the stream broke")

        return StreamingResponse(chunks(), media_type="text/event-stream")

    scope: Scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/broken-stream",
        "raw_path": b"/broken-stream",
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 50000),
        "server": ("testserver", 80),
    }
    sent: list[Message] = []

    async def receive() -> Message:
        await asyncio.Event().wait()  # the client stays connected
        raise AssertionError("unreachable")

    async def send(message: Message) -> None:
        sent.append(message)

    configure_logging("INFO")
    with pytest.raises(RuntimeError, match="the stream broke"):
        asyncio.run(app(scope, receive, send))  # re-raised: the 200 already went out
    assert sent[0]["status"] == 200
    error, access = log_lines(capsys, "pialy.http")
    assert error["level"] == "ERROR"
    assert access["message"] == "GET /broken-stream"
    assert access["status"] == "aborted"
