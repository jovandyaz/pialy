"""JSON logs on stdout with redaction of personal data and secrets.

Every line carries the request id and the fields bound for the request. The redaction
filter runs on the message, the exception text and the event fields, and the formatter on every
extra field (event, bound and route), so a phone, an email, a token or a CLABE inside an
exception message or a bound value never reaches the output.
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
# Unbounded `[\w.+-]+@` rescans the whole run from every start position when no `@` follows:
# quadratic on the attacker text that reaches the logs (paths, headers). So the local part is
# bounded by RFC 5321 s4.5.3.1 (64) and `_redact_emails` then absorbs the rest of an over-long one.
# The domain labels are possessive instead: they cannot backtrack, and a `.` is never a label
# character, so giving characters back could not help. Each label is read once, and a label over
# the RFC's 255 characters no longer defeats the pattern and leaves the local part behind.
_EMAIL = re.compile(r"[\w.+-]{1,64}@[\w-]++(?:\.[\w-]++)+")
_TOKEN = re.compile(r"[A-Za-z0-9_-]{32,}")
# Digits fail closed (OWASP Logging Cheat Sheet: no personal data in logs). Any chain of 10 or more
# digits is redacted whole: digit groups joined by 1 to 3 separator characters (whitespace or
# `. , / _ - : | ( )`, plus the `T` of an ISO timestamp), after an optional `+` and `(`. A phone or
# a CLABE in any grouping is caught without knowing its shape; an amount, an IP address or a long
# number that reaches 10 digits is redacted too, an accepted loss (money is integer minor units).
# Linear: the groups are digits and the separators never are, so nothing backtracks beyond the 3
# separator characters.
MIN_DIGITS = 10
_CHAIN_SEP = r"[\s.,/_\-:|()T]{1,3}"
_DIGIT_CHAIN = re.compile(rf"(?<!\d)\+?\(?\d+(?:{_CHAIN_SEP}\d+)*")
# The only exemption besides canonical UUIDs (split out before this runs): a chain that is a valid
# ISO 8601 date or timestamp, or a list of them. Month, day, hour, minute, second and offset are
# range-checked and the fraction has at most 9 digits, so no invalid part can shelter a number.
# Each timestamp is atomic and the list possessive, so a failed match never backtracks into them.
_MONTH = r"(?:0[1-9]|1[0-2])"
_DAY = r"(?:0[1-9]|[12]\d|3[01])"
_HOUR = r"(?:[01]\d|2[0-3])"
_MINUTE = r"[0-5]\d"  # seconds too
_ISO_TIME = rf"{_HOUR}:{_MINUTE}(?::{_MINUTE}(?:[.,]\d{{1,9}})?)?(?:[+-]{_HOUR}:{_MINUTE})?"
_ISO_TIMESTAMP = rf"(?>\d{{4}}-{_MONTH}-{_DAY}(?:[T ]{_ISO_TIME})?)"
_TIMESTAMPS_ONLY = re.compile(rf"{_ISO_TIMESTAMP}(?:{_CHAIN_SEP}{_ISO_TIMESTAMP})*+")
_HEX = "[0-9a-fA-F]"
# A canonical UUID is an identifier, not a secret: it stays readable in logs.
_UUID = re.compile(
    rf"(?<![A-Za-z0-9_-])({_HEX}{{8}}-{_HEX}{{4}}-{_HEX}{{4}}-{_HEX}{{4}}-{_HEX}{{12}})"
    r"(?![A-Za-z0-9_-])"
)


def _shorten_token(match: re.Match[str]) -> str:
    return f"{match[1]}{match[2][:LOGGED_TOKEN_CHARS]}…"


def _redact_digit_chain(match: re.Match[str]) -> str:
    chain = match[0]
    digits = sum(char.isdecimal() for char in chain)  # what `\d` matches
    if digits < MIN_DIGITS or _TIMESTAMPS_ONLY.fullmatch(chain):
        return chain
    return "[digits]"


def _is_local_part_char(char: str) -> bool:
    return char.isalnum() or char in "_.+-"  # the same set as `[\w.+-]`


def _redact_emails(text: str) -> str:
    """Replace each address by `[email]`, including the head of a local part over 64 characters.

    The bounded pattern finds the last 64 characters of the local part; the characters before
    them are absorbed here, walking back over local-part characters but never past the previous
    match. Those ranges never overlap, so the scan stays linear.
    """
    if "@" not in text:
        return text
    parts: list[str] = []
    copied = 0
    for match in _EMAIL.finditer(text):
        start = match.start()
        while start > copied and _is_local_part_char(text[start - 1]):
            start -= 1
        parts += (text[copied:start], "[email]")
        copied = match.end()
    parts.append(text[copied:])
    return "".join(parts)


def _redact_plain(text: str) -> str:
    text = _TOKEN.sub("[token]", text)
    return _DIGIT_CHAIN.sub(_redact_digit_chain, text)


def redact(text: str) -> str:
    """Hide booking tokens, emails, 32+ character tokens and every chain of 10 or more digits.

    Canonical UUIDs pass through untouched. Emails are redacted first, on the whole text, so a
    UUID inside an address (`user+<uuid>@x.mx`) cannot split it and leave a half behind.
    """
    text = _TOKEN_IN_PATH.sub(_shorten_token, text)
    text = _redact_emails(text)
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


def log_event(name: str, **fields: str | int | float | bool | None) -> None:
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


UNREDACTABLE_MESSAGE = "[log record could not be redacted]"


class RedactingFilter(logging.Filter):
    """Rewrite the record so that nothing downstream can see the unredacted text.

    Never raises: a logging call must not fail the code that made it. If redacting a record
    fails for any reason, the line is kept but its content is replaced by a fixed marker.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            self._redact(record)
        except Exception:  # last resort: drop everything that could not be redacted
            record.msg = UNREDACTABLE_MESSAGE
            record.args = None
            record.exc_info = None
            record.exc_text = None
            record.stack_info = None
            setattr(record, _FIELDS_ATTR, {})
        return True

    @staticmethod
    def _redact(record: logging.LogRecord) -> None:
        record.msg = redact(_message_of(record))
        record.args = None
        if record.exc_info:
            record.exc_text = logging.Formatter().formatException(record.exc_info)
            record.exc_info = None
        if record.exc_text:
            record.exc_text = redact(record.exc_text)
        if record.stack_info:
            record.stack_info = redact(record.stack_info)
        fields: Mapping[str, object] | None = getattr(record, _FIELDS_ATTR, None)
        if fields is not None:
            setattr(record, _FIELDS_ATTR, {k: redact_value(v) for k, v in fields.items()})


UNREPRESENTABLE = "[unrepresentable]"


def redact_value(value: object) -> object:
    """Redact one value: text as is, anything else by its text, keeping its type if that is clean.

    A phone held in an int or a float (`5512345678`, `1234567890123456.0`) is replaced by its
    redacted text; line numbers, ratios, flags and None keep their type. Other objects (a
    `uuid.UUID`, a `Decimal`) are checked by `str()`, which is what JSON output uses for them.
    Never raises: a value with no text (a `__str__` that raises, an int over Python's digit limit)
    becomes a fixed placeholder, so it can neither break the caller nor reach the output.
    """
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        return redact(value)
    try:
        text = str(value)
    except Exception:  # whatever `str()` raises: the value cannot be checked, so it is dropped
        return UNREPRESENTABLE
    redacted = redact(text)
    return value if redacted == text else redacted


# Keys the formatter owns: a bound or event field with one of these names is dropped.
_RESERVED_KEYS = frozenset(
    {"ts", "level", "logger", "message", "request_id", "event", "exc", "stack"}
)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        fields: Mapping[str, object] = getattr(record, _FIELDS_ATTR, {})
        extras: dict[str, object] = {"business_id": "", **fields}  # empty until tenancy binds it
        resolver = _route.get()
        if resolver is not None:
            extras["route"] = resolver()
        extras.update(_bound.get() or {})
        payload: dict[str, object] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": request_id.get(),
            **{
                key: redact_value(value)  # fail closed: bound and route values are not filtered
                for key, value in extras.items()
                if key not in _RESERVED_KEYS
            },
        }
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
