"""The request context (id, bound fields, route) belongs to one request and ends with it."""

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.responses import FileResponse, StreamingResponse
from starlette.types import Message, Scope

from pialy.clock import system_clock
from pialy.config import Settings
from pialy.main import create_app
from pialy.observability.logging import bind, configure_logging, request_id

FIRST_ID = "00000000-0000-4000-8000-000000000001"
SECOND_ID = "00000000-0000-4000-8000-000000000002"
THIRD_ID = "00000000-0000-4000-8000-000000000003"


def make_app(monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    monkeypatch.setenv("ENV", "test")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/none")
    return create_app(Settings(), system_clock, lambda: True)


def http_scope(path: str) -> Scope:
    return {
        "type": "http",
        "asgi": {"version": "3.0"},  # spec 2.0-2.3, as uvicorn: Starlette watches for disconnects
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 50000),
        "server": ("testserver", 80),
    }


async def connected() -> Message:
    await asyncio.Event().wait()  # the client stays connected
    raise AssertionError("unreachable")


def add_endless_stream(app: FastAPI) -> None:
    @app.get("/endless")
    async def endless() -> StreamingResponse:
        async def chunks() -> AsyncIterator[bytes]:
            yield b"one\n"
            await asyncio.Event().wait()  # never ends on its own

        return StreamingResponse(chunks(), media_type="text/event-stream")


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
                    client.get("/who", headers={"X-Request-Id": rid, "X-Caller": caller})
                    for rid, caller in ((FIRST_ID, "1"), (SECOND_ID, "2"))
                )
            )

    configure_logging("INFO")
    asyncio.run(run())
    handled = log_lines(capsys, "handler")
    assert sorted((line["request_id"], line["caller"]) for line in handled) == [
        (FIRST_ID, "1"),
        (SECOND_ID, "2"),
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
            await client.get("/bind", headers={"X-Request-Id": THIRD_ID})
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

    sent: list[Message] = []

    async def send(message: Message) -> None:
        sent.append(message)

    configure_logging("INFO")
    with pytest.raises(RuntimeError, match="the stream broke"):
        asyncio.run(app(http_scope("/broken-stream"), connected, send))  # the 200 already went out
    assert sent[0]["status"] == 200
    error, access = log_lines(capsys, "pialy.http")  # one access line, not a second one
    assert error["level"] == "ERROR"
    assert access["message"] == "GET /broken-stream"
    assert access["status"] == 200  # always the status that went out, as an int
    assert access["aborted"] is True


def test_a_cancelled_stream_is_logged_as_aborted(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], json_logs: None
) -> None:
    # A cancellation (server shutdown, a timeout around the app) is not an `Exception`.
    app = make_app(monkeypatch)
    add_endless_stream(app)

    async def run() -> None:
        first_chunk_sent = asyncio.Event()

        async def send(message: Message) -> None:
            if message["type"] == "http.response.body" and message["body"] == b"one\n":
                first_chunk_sent.set()

        task = asyncio.create_task(app(http_scope("/endless"), connected, send))
        await asyncio.wait_for(first_chunk_sent.wait(), timeout=2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    configure_logging("INFO")
    asyncio.run(run())
    [access] = log_lines(capsys, "pialy.http")  # no error line: nothing failed
    assert access["message"] == "GET /endless"
    assert access["status"] == 200
    assert access["aborted"] is True


def test_a_stream_the_client_left_is_logged_as_aborted(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], json_logs: None
) -> None:
    # Starlette stops the stream on `http.disconnect` and returns normally, without the last body.
    app = make_app(monkeypatch)
    add_endless_stream(app)

    async def run() -> None:
        client_left = asyncio.Event()

        async def receive() -> Message:
            await asyncio.wait_for(client_left.wait(), timeout=2)
            return {"type": "http.disconnect"}

        async def send(message: Message) -> None:
            if message["type"] == "http.response.body" and message["body"] == b"one\n":
                client_left.set()

        await app(http_scope("/endless"), receive, send)

    configure_logging("INFO")
    asyncio.run(run())
    [access] = log_lines(capsys, "pialy.http")
    assert access["status"] == 200
    assert access["aborted"] is True


def test_a_stream_that_ends_is_not_aborted(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], json_logs: None
) -> None:
    app = make_app(monkeypatch)

    @app.get("/short-stream")
    async def short_stream() -> StreamingResponse:
        async def chunks() -> AsyncIterator[bytes]:
            yield b"one\n"
            yield b"two\n"

        return StreamingResponse(chunks(), media_type="text/event-stream")

    async def send(message: Message) -> None:
        return None

    configure_logging("INFO")
    asyncio.run(app(http_scope("/short-stream"), connected, send))
    [access] = log_lines(capsys, "pialy.http")
    assert access["status"] == 200
    assert "aborted" not in access


def test_an_error_after_the_response_finished_is_logged_but_not_as_aborted(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], json_logs: None
) -> None:
    app = make_app(monkeypatch)

    def fail() -> None:
        raise RuntimeError("the background task broke")

    @app.get("/then-fail")
    async def then_fail(tasks: BackgroundTasks) -> dict[str, str]:
        tasks.add_task(fail)  # runs once the whole response went out
        return {"ok": "yes"}

    sent: list[Message] = []

    async def send(message: Message) -> None:
        sent.append(message)

    configure_logging("INFO")
    with pytest.raises(RuntimeError, match="the background task broke"):
        asyncio.run(app(http_scope("/then-fail"), connected, send))
    assert sent[-1]["type"] == "http.response.body"
    assert "more_body" not in sent[-1]  # left out: ASGI's default, False, ends the response
    error, access = log_lines(capsys, "pialy.http")
    assert error["level"] == "ERROR"
    assert access["status"] == 200
    assert "aborted" not in access


def test_a_file_sent_with_the_pathsend_extension_is_not_aborted(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    json_logs: None,
    tmp_path: Path,
) -> None:
    # With `http.response.pathsend` the server sends the file itself: that message ends the
    # response, there is no body message with `more_body` False after it.
    app = make_app(monkeypatch)
    file = tmp_path / "report.txt"
    file.write_text("synthetic")

    @app.get("/file")
    async def serve_file() -> FileResponse:
        return FileResponse(file)

    sent: list[Message] = []

    async def send(message: Message) -> None:
        sent.append(message)

    scope = http_scope("/file")
    scope["extensions"] = {"http.response.pathsend": {}}
    configure_logging("INFO")
    asyncio.run(app(scope, connected, send))
    assert [message["type"] for message in sent] == [
        "http.response.start",
        "http.response.pathsend",
    ]
    [access] = log_lines(capsys, "pialy.http")
    assert access["status"] == 200
    assert "aborted" not in access


def test_a_request_cancelled_before_its_response_started_is_logged_as_aborted(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], json_logs: None
) -> None:
    app = make_app(monkeypatch)
    in_handler = asyncio.Event()

    @app.get("/slow")
    async def slow() -> dict[str, str]:
        in_handler.set()
        await asyncio.Event().wait()  # never answers on its own
        return {"ok": "yes"}

    sent: list[Message] = []

    async def send(message: Message) -> None:
        sent.append(message)

    async def run() -> None:
        task = asyncio.create_task(app(http_scope("/slow"), connected, send))
        await asyncio.wait_for(in_handler.wait(), timeout=2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    configure_logging("INFO")
    asyncio.run(run())
    assert sent == []  # nothing went out
    [access] = log_lines(capsys, "pialy.http")
    assert access["status"] == 500  # the default, as nothing was sent
    assert access["aborted"] is True
