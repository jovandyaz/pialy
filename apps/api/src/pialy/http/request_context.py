"""Request id and unexpected-error handling, as pure ASGI middleware.

Pure ASGI (not BaseHTTPMiddleware) so streaming responses such as SSE are not buffered and
context variables set here reach the route. Unexpected errors are caught here, inside the
security headers middleware, so the 500 problem carries the request id and the headers too.
"""

import logging
import uuid

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from pialy.http.problems import problem_response
from pialy.observability.logging import bind_route, log_fields, request_context

REQUEST_ID_HEADER = "X-Request-Id"

logger = logging.getLogger("pialy.http")


def route_of(scope: Scope) -> str:
    """The route template once routed (`/api/bookings/{token}`), else the raw path.

    Only for log lines: the JSON formatter redacts it, like every other logged value.
    """
    path = getattr(scope.get("route"), "path", None)
    return path if isinstance(path, str) else str(scope["path"])


def _is_canonical_uuid(value: str) -> bool:
    try:  # `uuid.UUID` also accepts braces, a URN prefix, no hyphens and upper case
        return str(uuid.UUID(value)) == value
    except ValueError:
        return False


def resolve_request_id(incoming: str | None) -> str:
    """The client's `X-Request-Id` if it is a canonical lowercase UUID, else a fresh uuid4.

    The header is untrusted and ends up in every log line and in the response, so it is validated
    and otherwise replaced (OWASP Logging Cheat Sheet). A canonical UUID is an identifier that
    carries nothing else, and `redact` lets it through; any other shape (a token, 32 hex
    characters, an upper-case UUID) is replaced rather than judged.
    """
    if incoming is not None and _is_canonical_uuid(incoming):
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
        with request_context(rid):
            bind_route(lambda: route_of(scope))
            await self._handle(scope, receive, send, rid)

    async def _handle(self, scope: Scope, receive: Receive, send: Send, rid: str) -> None:
        started = False
        finished = False
        status = 500  # what the client gets when nothing was sent

        async def send_with_id(message: Message) -> None:
            nonlocal started, finished, status
            if message["type"] == "http.response.start":
                started = True
                status = message["status"]
                MutableHeaders(scope=message)[REQUEST_ID_HEADER] = rid
            await send(message)
            # ASGI: a body with `more_body` False (its default) completes the response.
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                finished = True

        try:
            await self.app(scope, receive, send_with_id)
        except Exception:
            logger.exception("unhandled error")
            if started:
                raise  # the status line already went out: nothing else can be sent
            await problem_response(500)(scope, receive, send_with_id)
        finally:
            # Started but not finished: an error, a cancellation or a client that left mid-stream.
            # The status is a field: in the text it would merge with a path ending in digits.
            fields: dict[str, int | bool] = {"status": status}
            if started and not finished:
                fields["aborted"] = True
            logger.info("%s %s", scope["method"], route_of(scope), extra=log_fields(**fields))
