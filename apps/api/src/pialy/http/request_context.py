"""Request id and unexpected-error handling, as pure ASGI middleware.

Pure ASGI (not BaseHTTPMiddleware) so streaming responses such as SSE are not buffered and
context variables set here reach the route. Unexpected errors are caught here, inside the
security headers middleware, so the 500 problem carries the request id and the headers too.
"""

import logging
import re
import uuid

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from pialy.http.problems import problem_response
from pialy.observability.logging import request_id

REQUEST_ID_HEADER = "X-Request-Id"
_VALID_REQUEST_ID = re.compile(r"[A-Za-z0-9-]{8,64}")

logger = logging.getLogger("pialy.http")


def resolve_request_id(incoming: str | None) -> str:
    if incoming is not None and _VALID_REQUEST_ID.fullmatch(incoming):
        return incoming
    return str(uuid.uuid4())


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        rid = resolve_request_id(Headers(scope=scope).get(REQUEST_ID_HEADER))
        request_id.set(rid)
        started = False

        async def send_with_id(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                MutableHeaders(scope=message)[REQUEST_ID_HEADER] = rid
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        except Exception:
            logger.exception("unhandled error")
            if started:
                raise
            await problem_response(500)(scope, receive, send_with_id)
