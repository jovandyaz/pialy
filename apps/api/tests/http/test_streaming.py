"""A streamed response crosses the whole middleware stack without being buffered."""

import asyncio
import re
from collections.abc import AsyncIterator

import pytest
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from starlette.datastructures import Headers
from starlette.types import Message, Scope

from pialy.clock import system_clock
from pialy.config import Settings
from pialy.main import create_app

CHUNK_WAIT_SECONDS = 2


def stream_app(monkeypatch: pytest.MonkeyPatch, first_chunk_sent: asyncio.Event) -> FastAPI:
    monkeypatch.setenv("ENV", "test")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/none")
    app = create_app(Settings(), system_clock, lambda: True)

    @app.get("/stream")
    async def stream() -> StreamingResponse:
        async def chunks() -> AsyncIterator[bytes]:
            yield b"one\n"
            # Resumes only once the client side has received chunk one: a middleware that
            # buffers the body would never deliver it, and the wait would time out.
            await asyncio.wait_for(first_chunk_sent.wait(), timeout=CHUNK_WAIT_SECONDS)
            yield b"two\n"
            yield b"three\n"

        return StreamingResponse(chunks(), media_type="text/event-stream")

    return app


async def drive(app: FastAPI, first_chunk_sent: asyncio.Event) -> list[Message]:
    scope: Scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/stream",
        "raw_path": b"/stream",
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
        if message["type"] == "http.response.body" and message["body"] == b"one\n":
            first_chunk_sent.set()

    await app(scope, receive, send)
    return sent


def test_chunks_reach_the_client_one_by_one_with_headers_and_request_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def run() -> list[Message]:
        first_chunk_sent = asyncio.Event()
        return await drive(stream_app(monkeypatch, first_chunk_sent), first_chunk_sent)

    sent = asyncio.run(run())

    start, *bodies = sent
    assert start["type"] == "http.response.start"
    assert start["status"] == 200
    headers = Headers(raw=start["headers"])
    assert headers["content-type"].startswith("text/event-stream")
    assert re.fullmatch(r"[0-9a-f-]{36}", headers["x-request-id"])
    assert headers["x-content-type-options"] == "nosniff"
    assert "content-security-policy" in headers
    assert [body["body"] for body in bodies] == [b"one\n", b"two\n", b"three\n", b""]
    assert [body["more_body"] for body in bodies] == [True, True, True, False]
