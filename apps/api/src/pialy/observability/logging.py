"""JSON logs on stdout with redaction of personal data and secrets.

Every line carries the request id and the fields bound for the request. `JsonFormatter` is the
one place that redacts: the message, the exception and stack text, and every event, bound and
route field go through `redact` once, so a phone, an email, a token or a CLABE inside an exception
message or a bound value never reaches the output.
"""

import contextlib
import json
import logging
import re
import sys
from collections.abc import Callable, Iterator, Mapping
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import TextIO

request_id: ContextVar[str] = ContextVar("request_id", default="-")
# One mutable dict per request: a handler running in a threadpool (copied context) binds into
# the same object the middleware reads for its own lines.
_bound: ContextVar[dict[str, str] | None] = ContextVar("bound_log_fields", default=None)
_route: ContextVar[Callable[[], str] | None] = ContextVar("log_route", default=None)

_EVENT_LOGGER = logging.getLogger("pialy.events")
_EVENT_ATTR = "pialy_event"
_FIELDS_ATTR = "pialy_fields"
_UVICORN_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")

# Unbounded `[\w.+-]+@` rescans the whole run from every start position when no `@` follows:
# quadratic on the attacker text that reaches the logs (paths, headers). So the local part is
# bounded by RFC 5321 s4.5.3.1 (64) and `_redact_emails` then absorbs the rest of an over-long one.
# The domain labels are possessive instead: they cannot backtrack, and a `.` is never a label
# character, so giving characters back could not help. Each label is read once, and a label over
# the RFC's 255 characters no longer defeats the pattern and leaves the local part behind.
_EMAIL = re.compile(r"[\w.+-]{1,64}@[\w-]++(?:\.[\w-]++)+")
# Credentials, redacted before emails: the email rule would read `pass@db.example.com` as an
# address and leave the user name, and miss `pass@localhost` altogether. The userinfo of a URL
# (`scheme://user:pass@`, RFC 3986 s3.2.1) is everything after `://` up to the last `@` before the
# path, query or fragment, so an `@` left unencoded in a password goes too. A libpq keyword value
# (`password=...`, `password = '...'`; `PGPASSWORD=` and `sslpassword=` as well) goes up to its
# closing quote, backslash escapes included (an unclosed quote runs to the end), or else up to
# the next whitespace. Linear: a userinfo scan starts only right after `://` and stops at the next
# `/`, so scans never overlap, and a quoted value is read possessively.
_USERINFO = re.compile(r"(?<=://)[^\s/?#]+@")
_PASSWORD_VALUE = re.compile(r"(password\s*=\s*)(?:'(?:[^'\\]|\\[\s\S])*+'?|\S+)", re.IGNORECASE)
# Tokens. A run is a maximal stretch of characters from either base64 alphabet, standard (`+ /`
# and `=` padding) or url-safe (`- _`); hex and plain words are subsets. A run of 32 or more is a
# key or a token and is redacted whole, unless it reads as a path: `/` is also a base64 character,
# so `/app/src/pialy/observability/logging` is a 36-character run. A path has no `+` and no
# padding; its `/` segments are words (an optional capital, then lowercase letters, digits, `_` or
# `-`), at least two of them names (two or more lowercase letters: `api`, `bookings`); and only an
# absolute path (`/...`) may also hold token segments. Measured on 3,000,000 random unpadded
# standard-base64 keys of 32 to 64 characters, none passes for a path (two short lowercase chunks
# are not that rare in a key, a leading `/` plus two of them is); a 32-byte key always has padding.
# Inside a path (or a shorter run), each segment of 16 or more characters is judged on its own
# (`_redact_segment`). Canonical UUIDs never get here.
# Linear: runs never overlap, and the lookbehind stops a failed match from restarting inside one.
LOGGED_TOKEN_CHARS = 4
MIN_PATH_TOKEN_CHARS = 16
MIN_TOKEN_CHARS = 32
MIN_PATH_NAMES = 2
_RUN = re.compile(r"(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{16,}(?:={1,2}(?![A-Za-z0-9+/=_-]))?")
_WORD = re.compile(r"[A-Z]?[a-z0-9_-]*")
_NAME = re.compile(r"[a-z][a-z_-]+")
# File and module names (`security_headers`, `_exception_handler`). A `.` ends a run, so the
# segment of `security_headers.py` is `security_headers`.
_LOWERCASE_NAME = re.compile(r"[a-z0-9_-]+")
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
# range-checked and the fraction has at most 6 digits (microseconds, what `datetime.isoformat`
# writes), so no invalid part can shelter a number: with 8, `:55.12345678` holds a whole phone.
# Each timestamp is atomic and the list possessive, so a failed match never backtracks into them.
_MONTH = r"(?:0[1-9]|1[0-2])"
_DAY = r"(?:0[1-9]|[12]\d|3[01])"
_HOUR = r"(?:[01]\d|2[0-3])"
_MINUTE = r"[0-5]\d"  # seconds too
_ISO_TIME = rf"{_HOUR}:{_MINUTE}(?::{_MINUTE}(?:[.,]\d{{1,6}})?)?(?:[+-]{_HOUR}:{_MINUTE})?"
_ISO_TIMESTAMP = rf"(?>\d{{4}}-{_MONTH}-{_DAY}(?:[T ]{_ISO_TIME})?)"
_TIMESTAMPS_ONLY = re.compile(rf"{_ISO_TIMESTAMP}(?:{_CHAIN_SEP}{_ISO_TIMESTAMP})*+")
_HEX = "[0-9a-fA-F]"
# A canonical UUID is an identifier, not a secret: it stays readable in logs.
_UUID = re.compile(
    rf"(?<![A-Za-z0-9_-])({_HEX}{{8}}-{_HEX}{{4}}-{_HEX}{{4}}-{_HEX}{{4}}-{_HEX}{{12}})"
    r"(?![A-Za-z0-9_-])"
)


def _is_path(run: str, segments: list[str]) -> bool:
    if "+" in run or run.endswith("="):
        return False
    absolute = segments[0] == ""
    names = 0
    for segment in segments:
        if _WORD.fullmatch(segment):
            names += _NAME.fullmatch(segment) is not None
        elif not (absolute and len(segment) >= MIN_PATH_TOKEN_CHARS):
            return False
    return names >= MIN_PATH_NAMES


def _looks_random(segment: str) -> bool:
    """A digit and an uppercase letter: words and CamelCase identifiers without digits are not."""
    return any(char.isdigit() for char in segment) and any(char.isupper() for char in segment)


def _redact_segment(segment: str, after_slash: bool) -> str:
    """One `/` segment of a run: kept, replaced, or truncated to its first 4 characters.

    Only a segment of 16 or more characters is judged. After a `/` it is a bearer token (a booking
    token is 22), wherever the route puts it. Anywhere else (a message, `Bearer <token>`,
    `?token=<token>`) it is a key at 32 or more, a token when it holds a digit and an uppercase
    letter, and otherwise (a word, a name, a list of ISO dates) it is left to the digit rule. A
    token keeps 4 characters, but one with 10 or more digits becomes `[digits]` (a CLABE as a
    route parameter: its first 4 digits name the bank) and a lowercase name is kept.
    """
    if len(segment) < MIN_PATH_TOKEN_CHARS:
        return segment
    if not after_slash:
        if len(segment) >= MIN_TOKEN_CHARS:
            return "[token]"
        if not _looks_random(segment):
            return segment
    if sum(char.isdecimal() for char in segment) >= MIN_DIGITS:
        return "[digits]"
    if _LOWERCASE_NAME.fullmatch(segment):
        return segment
    return f"{segment[:LOGGED_TOKEN_CHARS]}…"


def _redact_run(match: re.Match[str]) -> str:
    run = match[0]
    segments = run.split("/")
    if len(run) >= MIN_TOKEN_CHARS and not _is_path(run, segments):
        return "[token]"
    return "/".join(_redact_segment(segment, index > 0) for index, segment in enumerate(segments))


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


def _redact_credentials(text: str) -> str:
    text = _USERINFO.sub("[userinfo]@", text)
    return _PASSWORD_VALUE.sub(r"\g<1>[redacted]", text)


def _redact_plain(text: str) -> str:
    text = _RUN.sub(_redact_run, text)
    return _DIGIT_CHAIN.sub(_redact_digit_chain, text)


def redact(text: str) -> str:
    """Hide credentials, emails, keys and tokens, path tokens and chains of 10 or more digits.

    Canonical UUIDs pass through untouched. Credentials, then emails, are redacted first, on the
    whole text, so a UUID inside an address (`user+<uuid>@x.mx`) cannot split it and leave a half
    behind.
    """
    text = _redact_credentials(text)
    text = _redact_emails(text)
    parts = _UUID.split(text)  # odd items are the UUIDs
    return "".join(part if index % 2 else _redact_plain(part) for index, part in enumerate(parts))


@contextlib.contextmanager
def request_context(rid: str) -> Iterator[None]:
    """Run one request with its id and fresh bound fields, then restore what was there before.

    The bound fields are one dict shared by reference with every context copied from this one.
    The reset matters when the caller's task goes on after the request (an in-process client).
    """
    rid_token = request_id.set(rid)
    bound_token = _bound.set({})
    route_token = _route.set(None)
    try:
        yield
    finally:
        _route.reset(route_token)
        _bound.reset(bound_token)
        request_id.reset(rid_token)


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


type FieldValue = str | int | float | bool | None


def log_fields(**fields: FieldValue) -> dict[str, object]:
    """`extra=` for a log call: the fields become top-level keys of the line, redacted once.

    A value that has its own key stays readable next to the message instead of merging into
    its text (`2026-11-15 404` would be one 11-digit chain).
    """
    return {_FIELDS_ATTR: fields}


def log_event(name: str, **fields: FieldValue) -> None:
    """Log a named event of spec §12b; the fields become top-level keys of the line."""
    _EVENT_LOGGER.info(name, extra={_EVENT_ATTR: name, **log_fields(**fields)})


FORMAT_ERROR_MARKER = " [log format error]"


def _message_of(record: logging.LogRecord) -> str:
    """The formatted message; a broken format call yields the bare template plus a marker.

    A `logger.info("%d", "abc")` keeps its line instead of reaching `Handler.handleError`, which
    would print the raw arguments. The fallback leaves the args out: they are what failed to
    format and may hold personal data.
    """
    try:
        return record.getMessage()
    except Exception:  # a log call must never break its caller
        try:
            return f"{record.msg}{FORMAT_ERROR_MARKER}"
        except Exception:  # an unprintable `msg`: nothing left to show
            return f"[unprintable log message]{FORMAT_ERROR_MARKER}"


UNREDACTABLE_MESSAGE = "[log record could not be redacted]"


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
    """One JSON line per record, and the only place that redacts.

    Every value is redacted once, here: the message, the exception and stack text, the event,
    bound and route fields. The record itself is left as it is, so any handler that formats with
    this class emits redacted text whether or not it has a filter. Never raises: a log call must
    not fail its caller, and a record that cannot be redacted becomes a fixed marker line.
    """

    def format(self, record: logging.LogRecord) -> str:
        try:
            return json.dumps(self._payload(record), ensure_ascii=False, default=str)
        except Exception:  # last resort: drop everything that could not be redacted
            return json.dumps(
                {**self._base(record), "message": UNREDACTABLE_MESSAGE}, ensure_ascii=False
            )

    @staticmethod
    def _base(record: logging.LogRecord) -> dict[str, object]:
        return {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "request_id": request_id.get(),  # validated when the request starts
        }

    def _payload(self, record: logging.LogRecord) -> dict[str, object]:
        fields: Mapping[str, object] = getattr(record, _FIELDS_ATTR, None) or {}
        extras: dict[str, object] = {"business_id": "", **fields}  # empty until tenancy binds it
        resolver = _route.get()
        if resolver is not None:
            extras["route"] = resolver()
        extras.update(_bound.get() or {})
        payload: dict[str, object] = {
            **self._base(record),
            "message": redact(_message_of(record)),
            **{
                key: redact_value(value)
                for key, value in extras.items()
                if key not in _RESERVED_KEYS
            },
        }
        event: str | None = getattr(record, _EVENT_ATTR, None)
        if event is not None:
            payload["event"] = redact(event)
        exc_text = self.formatException(record.exc_info) if record.exc_info else record.exc_text
        if exc_text:
            payload["exc"] = redact(exc_text)
        if record.stack_info:
            payload["stack"] = redact(self.formatStack(record.stack_info))
        return payload


class _JsonStreamHandler(logging.StreamHandler[TextIO]):
    def handleError(self, record: logging.LogRecord) -> None:
        """Report a failed write without the record: the stdlib prints its raw message and args."""
        with contextlib.suppress(Exception):  # nowhere left to report to
            sys.stderr.write("--- Logging error: a log line could not be written ---\n")


def configure_logging(level: str) -> None:
    """Send every log record, uvicorn's included, through one redacting JSON handler."""
    name = level.upper()
    if name not in logging.getLevelNamesMapping():
        raise ValueError(f"unknown log level: {level!r}")
    handler = _JsonStreamHandler(sys.stdout)
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
