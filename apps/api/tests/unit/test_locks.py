import pytest

from pialy.db.locks import advisory_key

INT64_MIN, INT64_MAX = -(2**63), 2**63 - 1


def test_advisory_key_is_stable() -> None:
    # First 8 bytes of SHA-256("sweeper:tick"), big-endian, signed. Pinned so that two
    # releases running side by side always agree on the key.
    assert advisory_key("sweeper", "tick") == 243802676546872480
    assert advisory_key("mandate", "00000000-0000-0000-0000-000000000001") == 8622802091088406891


def test_advisory_keys_fit_a_postgres_bigint_and_differ_by_namespace() -> None:
    keys = {advisory_key(ns, "same") for ns in ("sweeper", "relay", "mandate", "retention")}
    assert len(keys) == 4
    assert all(INT64_MIN <= key <= INT64_MAX for key in keys)


def test_advisory_key_rejects_an_unknown_namespace() -> None:
    with pytest.raises(ValueError, match="namespace"):
        advisory_key("nope", "x")  # type: ignore[arg-type]
