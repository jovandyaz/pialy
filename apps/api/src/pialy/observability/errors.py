"""Optional Sentry reporting. The `sentry` extra is imported only when a DSN is set."""

import importlib

from pialy.config import Settings
from pialy.observability.logging import redact


def _scrub(value: object) -> object:
    """Redact strings, dict keys and numbers (a phone is an int in a frame's `vars`).

    A number is replaced only when redaction changes its text, so line numbers and flags keep
    their type. Keys that redact to the same text merge: the entry is gone either way.
    """
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, bool):  # a bool is an int: leave flags alone
        return value
    if isinstance(value, int | float):
        text = str(value)
        redacted = redact(text)
        return value if redacted == text else redacted
    if isinstance(value, dict):
        return {_scrub(key): _scrub(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_scrub(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_scrub(item) for item in value)
    return value


def scrub_event(event: dict[str, object], hint: object) -> dict[str, object]:
    """Sentry `before_send`: run the log redaction over every string, key and number."""
    scrubbed = _scrub(event)
    assert isinstance(scrubbed, dict)  # noqa: S101 - _scrub keeps the type of a dict
    return scrubbed


def init_error_reporting(settings: Settings) -> None:
    if settings.sentry_dsn is None:
        return
    try:
        sentry_sdk = importlib.import_module("sentry_sdk")
    except ImportError:
        raise RuntimeError(
            "SENTRY_DSN is set but sentry-sdk is not installed (install the 'sentry' extra)"
        ) from None
    sentry_sdk.init(
        dsn=settings.sentry_dsn.get_secret_value(),
        environment=settings.env,
        send_default_pii=False,
        before_send=scrub_event,
    )
