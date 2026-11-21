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
from pialy.observability.logging import (
    bind_route,
    redact,
    request_id,
    start_request_context,
)

REQUEST_ID_HEADER = "X-Request-Id"
_VALID_REQUEST_ID = re.compile(r"[A-Za-z0-9-]{8,64}")
_LONG_DIGIT_RUN = re.compile(r"\d{10,}")

logger = logging.getLogger("pialy.http")


def route_of(scope: Scope) -> str:
    """The route template once routed (`/api/bookings/{token}`), else the raw path.

    Only for log lines: the JSON formatter redacts it, like every other logged value.
    """
    path = getattr(scope.get("route"), "path", None)
    return path if isinstance(path, str) else str(scope["path"])


def _is_canonical_uuid(value: str) -> bool:
    try:  # `uuid.UUID` also accepts braces, a URN prefix and no hyphens: compare the canonical form
        return str(uuid.UUID(value)) == value.lower()
    except ValueError:
        return False


def _is_safe_request_id(value: str) -> bool:
    if not _VALID_REQUEST_ID.fullmatch(value) or redact(value) != value:
        return False
    # `redact` joins digit groups across at most 3 hyphens; `5512----345678` still hides a phone.
    return _is_canonical_uuid(value) or not _LONG_DIGIT_RUN.search(value.replace("-", ""))


def resolve_request_id(incoming: str | None) -> str:
    """The client's `X-Request-Id` if it is safe to log and echo, else a fresh UUID.

    The header is untrusted and ends up in every log line and in the response, so it is validated
    and, if malformed, safely replaced (OWASP Logging Cheat Sheet). Besides the shape check, an id
    that log redaction would change (a token of 32 or more characters, a chain of 10 or more
    digits) is replaced, and so is one with a run of 10 or more digits once hyphens are removed.
    A canonical UUID is always kept: it is an identifier, `redact` lets it through too, and about
    1 in 11 random UUIDs has such a run of decimal digits.
    """
    if incoming is not None and _is_safe_request_id(incoming):
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
        start_request_context()
        bind_route(lambda: route_of(scope))
        started = False
        status = 500

        async def send_with_id(message: Message) -> None:
            nonlocal started, status
            if message["type"] == "http.response.start":
                started = True
                status = message["status"]
                MutableHeaders(scope=message)[REQUEST_ID_HEADER] = rid
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        except Exception:
            logger.exception("unhandled error")
            if started:
                raise
            await problem_response(500)(scope, receive, send_with_id)
        finally:
            logger.info("%s %s %d", scope["method"], route_of(scope), status)
