"""Keys for Postgres advisory locks, one namespace per kind of work."""

import hashlib
from typing import Literal, get_args

LockNamespace = Literal["sweeper", "relay", "mandate", "retention"]
NAMESPACES: frozenset[str] = frozenset(get_args(LockNamespace))


def advisory_key(namespace: LockNamespace, ident: str) -> int:
    """A stable signed 64-bit key: the first 8 bytes of SHA-256 of `namespace:ident`.

    Stable across processes and releases (unlike `hash()`), so replicas agree on it.
    """
    if namespace not in NAMESPACES:
        raise ValueError(f"unknown lock namespace: {namespace!r}")
    digest = hashlib.sha256(f"{namespace}:{ident}".encode()).digest()
    return int.from_bytes(digest[:8], "big", signed=True)
