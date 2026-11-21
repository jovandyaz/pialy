"""JSON logs on stdout with redaction of personal data and secrets.

Every line carries the request id and the fields bound for the request. The redaction
filter runs on the message, the exception text and the event fields, so a phone, an email,
a token or a CLABE inside an exception message never reaches the output.
"""

import json
import logging
import re
import sys
from collections.abc import Callable, Mapping
from contextvars import ContextVar
from datetime import UTC, datetime

request_id: ContextVar[str] = ContextVar("request_id", default="-")
# One mutable dict per request: a handler running in a threadpool (copied context) binds into
# the same object the middleware reads for its own lines.
_bound: ContextVar[dict[str, str] | None] = ContextVar("bound_log_fields", default=None)
_route: ContextVar[Callable[[], str] | None] = ContextVar("log_route", default=None)

_EVENT_LOGGER = logging.getLogger("pialy.events")
_EVENT_ATTR = "pialy_event"
_FIELDS_ATTR = "pialy_fields"
_UVICORN_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")

LOGGED_TOKEN_CHARS = 4
# A booking token is a bearer secret for its pass: these paths carry one right after the prefix.
_TOKEN_IN_PATH = re.compile(r"(/(?:api/bookings|api/verify|c|negocio/verificar)/)([^/?#\s]+)")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_TOKEN = re.compile(r"[A-Za-z0-9_-]{32,}")
_DIGITS = re.compile(r"\d{10,}")
# A 10-digit phone with an optional +52/52 prefix, grouped 2-4-4 or 3-3-4 (area code optionally in
# parentheses) and separated by single spaces, dots or dashes. Only these shapes, so a date, an
# ISO timestamp, an IP address or a small number is never taken for a phone.
_SEP = r"[ .-]?"
_PHONE = re.compile(
    rf"(?<!\d)(?:\+?52{_SEP})?"
    rf"(?:(?:\(\d{{2}}\)|\d{{2}}){_SEP}\d{{4}}{_SEP}\d{{4}}"
    rf"|(?:\(\d{{3}}\)|\d{{3}}){_SEP}\d{{3}}{_SEP}\d{{4}})(?!\d)"
)
_HEX = "[0-9a-fA-F]"
# A canonical UUID is an identifier, not a secret: it stays readable in logs.
_UUID = re.compile(
    rf"(?<![A-Za-z0-9_-])({_HEX}{{8}}-{_HEX}{{4}}-{_HEX}{{4}}-{_HEX}{{4}}-{_HEX}{{12}})"
    r"(?![A-Za-z0-9_-])"
)


def _shorten_token(match: re.Match[str]) -> str:
    return f"{match[1]}{match[2][:LOGGED_TOKEN_CHARS]}…"


def _redact_plain(text: str) -> str:
    text = _TOKEN.sub("[token]", text)
    text = _PHONE.sub("[digits]", text)
    return _DIGITS.sub("[digits]", text)


def redact(text: str) -> str:
    """Hide booking tokens, emails, 32+ character tokens, phones and runs of 10+ digits.

    Canonical UUIDs pass through untouched. Emails are redacted first, on the whole text, so a
    UUID inside an address (`user+<uuid>@x.mx`) cannot split it and leave a half behind.
    """
    text = _TOKEN_IN_PATH.sub(_shorten_token, text)
    text = _EMAIL.sub("[email]", text)
    parts = _UUID.split(text)  # odd items are the UUIDs
    return "".join(part if index % 2 else _redact_plain(part) for index, part in enumerate(parts))


def start_request_context() -> None:
    """Begin a request: fresh bound fields, shared by reference with every copied context."""
    _bound.set({})
    _route.set(None)


def bind(**fields: str) -> None:
    """Add fields (business id, ...) to every following line of the current request."""
    current = _bound.get()
    if current is None:
        current = {}
        _bound.set(current)
    current.update(fields)


def bind_route(resolver: Callable[[], str]) -> None:
    """Resolve `route` lazily: routing happens after the request context starts."""
    _route.set(resolver)


def log_event(name: str, **fields: str | int) -> None:
    """Log a named event of spec §12b; the fields become top-level keys of the line."""
    _EVENT_LOGGER.info(name, extra={_EVENT_ATTR: name, _FIELDS_ATTR: fields})


FORMAT_ERROR_MARKER = " [log format error]"


def _message_of(record: logging.LogRecord) -> str:
    """The formatted message; a broken format call yields the bare template plus a marker.

    The stdlib shields callers from this error inside `Handler.emit` (`handleError`), but a
    filter runs outside it, so a `logger.info("%d", "abc")` would raise into a request. The
    fallback leaves the args out: they are what failed to format and may hold personal data.
    """
    try:
        return record.getMessage()
    except Exception:  # a log call must never break its caller
        try:
            return f"{record.msg}{FORMAT_ERROR_MARKER}"
        except Exception:  # an unprintable `msg`: nothing left to show
            return f"[unprintable log message]{FORMAT_ERROR_MARKER}"


class RedactingFilter(logging.Filter):
    """Rewrite the record so that nothing downstream can see the unredacted text.

    Never raises: a logging call must not fail the code that made it.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact(_message_of(record))
        record.args = None
        if record.exc_info:
            record.exc_text = logging.Formatter().formatException(record.exc_info)
            record.exc_info = None
        if record.exc_text:
            record.exc_text = redact(record.exc_text)
        if record.stack_info:
            record.stack_info = redact(record.stack_info)
        fields: Mapping[str, str | int] | None = getattr(record, _FIELDS_ATTR, None)
        if fields is not None:
            setattr(record, _FIELDS_ATTR, {k: _redact_field(v) for k, v in fields.items()})
        return True


def _redact_field(value: str | int) -> str | int:
    return redact(value) if isinstance(value, str) else value


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        fields: Mapping[str, str | int] = getattr(record, _FIELDS_ATTR, {})
        payload: dict[str, object] = {
            "business_id": "",  # empty until tenancy binds it; the key is on every line
            **fields,
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": request_id.get(),
        }
        resolver = _route.get()
        if resolver is not None:
            payload["route"] = resolver()
        payload.update(_bound.get() or {})
        event: str | None = getattr(record, _EVENT_ATTR, None)
        if event is not None:
            payload["event"] = event
        if record.exc_text:
            payload["exc"] = record.exc_text
        if record.stack_info:
            payload["stack"] = record.stack_info
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging(level: str) -> None:
    """Send every log record, uvicorn's included, through one redacting JSON handler."""
    name = level.upper()
    if name not in logging.getLevelNamesMapping():
        raise ValueError(f"unknown log level: {level!r}")
    handler = logging.StreamHandler(sys.stdout)
    handler.addFilter(RedactingFilter())
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(name)
    for uvicorn_logger in _UVICORN_LOGGERS:
        logging.getLogger(uvicorn_logger).handlers.clear()
        logging.getLogger(uvicorn_logger).propagate = True
    # uvicorn logs access lines outside the request's context, so they would carry no request
    # id or route. RequestContextMiddleware writes the access line instead.
    logging.getLogger("uvicorn.access").propagate = False
