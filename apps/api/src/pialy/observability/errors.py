"""Optional Sentry reporting. The `sentry` extra is imported only when a DSN is set."""

import importlib
from collections.abc import Mapping
from typing import Literal

from pialy.config import Settings
from pialy.observability.logging import redact_value

# Where the SDK writes its own identifiers and timestamps (Sentry event payload docs; checked
# against what sentry-sdk 2.75 hands to `before_send`): a uuid4-hex `event_id`, 32-hex trace ids,
# 16-hex span ids, a git SHA as `release`. They are kept as they are, and only at these paths:
# the same key anywhere else (`extra`, `tags`, frame `vars`) is user data and is scrubbed. A list
# is transparent: each item follows the spec of the key that holds the list.
type _Keep = Literal[True] | Mapping[str, _Keep]
_NOTHING: Mapping[str, _Keep] = {}
_SPAN_IDS: Mapping[str, _Keep] = {
    "trace_id": True,
    "span_id": True,
    "parent_span_id": True,
    "start_timestamp": True,
    "timestamp": True,
    "data": {"thread.id": True},
}
_SDK_FIELDS: Mapping[str, _Keep] = {
    "event_id": True,
    "timestamp": True,
    "start_timestamp": True,
    "release": True,
    "dist": True,
    "contexts": {
        "trace": {
            **_SPAN_IDS,
            "dynamic_sampling_context": {"trace_id": True, "release": True, "public_key": True},
        }
    },
    "spans": _SPAN_IDS,
    "breadcrumbs": {"values": {"timestamp": True}},
}


def _scrub(value: object, keep: _Keep = _NOTHING) -> object:
    """Redact strings, dict keys and numbers (a phone is an int in a frame's `vars`).

    A number is replaced only when redaction changes its text, so line numbers and flags keep
    their type. Keys that redact to the same text merge: the entry is gone either way.
    """
    if keep is True:
        return value
    if isinstance(value, dict):
        return {
            _scrub(key): _scrub(item, keep.get(key, _NOTHING) if isinstance(key, str) else _NOTHING)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_scrub(item, keep) for item in value]
    if isinstance(value, tuple):
        return tuple(_scrub(item, keep) for item in value)
    return redact_value(value)


def scrub_event(event: dict[str, object], hint: object) -> dict[str, object]:
    """Sentry `before_send` and `before_send_transaction`: the log redaction over user content.

    Every string, key and number is redacted, except the SDK's own identifiers (`_SDK_FIELDS`).
    """
    scrubbed = _scrub(event, _SDK_FIELDS)
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
        before_send_transaction=scrub_event,
    )
