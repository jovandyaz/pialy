"""What differs between the backends under test. Every test goes through a `Target` for it."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from http import HTTPStatus
from typing import Literal, Protocol

import httpx
import psycopg
from psycopg import sql

type TargetName = Literal["ts", "py"]

# Booking and payment state; the seeded business, its resource and (py) its owner and connection stay.
TS_STATE_TABLES = (
    "bookings",
    "payment_intents",
    "payment_attempts",
    "payment_events",
    "webhook_inbox",
    "idempotency_keys",
    "outbox",
    "flags",
)
PY_STATE_TABLES = (*TS_STATE_TABLES, "rate_limits")


class Target(Protocol):
    @property
    def name(self) -> TargetName: ...

    def prefix(self, path: str) -> str:
        """The URL path of a business route; `path` starts after `/api`, e.g. `/slots`."""
        ...

    def webhook_path(self) -> str: ...

    def health_body(self) -> dict[str, object]:
        """What `GET /healthz` answers while the service runs."""
        ...

    def readiness_path(self) -> str:
        """The route that answers 200 only while the database is reachable."""
        ...

    def readiness_body(self) -> dict[str, object]:
        """Its 200 body."""
        ...

    def attempts_exhausted_status(self) -> int:
        """The status for a booking out of QR attempts: a cap that never resets, so not a 429 by RFC 6585."""
        ...

    def login(self, client: httpx.Client) -> None:
        """Signs `client` in as the business owner; its cookies carry the session."""
        ...

    def reset_db(self) -> None: ...


@dataclass(frozen=True)
class TsTarget:
    db_url: str
    pin: str
    name: TargetName = "ts"

    def prefix(self, path: str) -> str:
        return f"/api{path}"

    def webhook_path(self) -> str:
        return "/api/webhooks/pey"

    def health_body(self) -> dict[str, object]:
        return {"ok": True, "db": True}

    def readiness_path(self) -> str:
        return "/healthz"

    def readiness_body(self) -> dict[str, object]:
        return self.health_body()

    def attempts_exhausted_status(self) -> int:
        return HTTPStatus.TOO_MANY_REQUESTS

    def login(self, client: httpx.Client) -> None:
        client.post("/api/session", json={"pin": self.pin}).raise_for_status()

    def reset_db(self) -> None:
        truncate(self.db_url, TS_STATE_TABLES)


@dataclass(frozen=True)
class PyTarget:
    db_url: str
    slug: str
    connection_id: str
    owner_email: str
    owner_password: str
    name: TargetName = "py"

    def prefix(self, path: str) -> str:
        return f"/api/b/{self.slug}{path}"

    def webhook_path(self) -> str:
        return f"/api/webhooks/pey/{self.connection_id}"

    def health_body(self) -> dict[str, object]:
        return {"status": "ok"}

    def readiness_path(self) -> str:
        return "/readyz"

    def readiness_body(self) -> dict[str, object]:
        return {"status": "ready"}

    def attempts_exhausted_status(self) -> int:
        return HTTPStatus.CONFLICT

    def login(self, client: httpx.Client) -> None:
        credentials = {"email": self.owner_email, "password": self.owner_password}
        client.post("/api/auth/login", json=credentials).raise_for_status()

    def reset_db(self) -> None:
        truncate(self.db_url, PY_STATE_TABLES)


def truncate(db_url: str, tables: tuple[str, ...]) -> None:
    statement = sql.SQL("TRUNCATE {} CASCADE").format(sql.SQL(", ").join(map(sql.Identifier, tables)))
    with psycopg.connect(db_url, autocommit=True) as connection:
        connection.execute(statement)


def target_name(env: Mapping[str, str] = os.environ) -> TargetName:
    name = env.get("CONTRACT_TARGET", "")
    if name not in ("ts", "py"):
        raise RuntimeError(f"CONTRACT_TARGET must be 'ts' or 'py', got {name!r}")
    return "ts" if name == "ts" else "py"


def target_from_env(env: Mapping[str, str] = os.environ) -> Target:
    def required(key: str) -> str:
        value = env.get(key)
        if not value:
            raise RuntimeError(f"{key} is required for CONTRACT_TARGET={env.get('CONTRACT_TARGET')}")
        return value

    if target_name(env) == "ts":
        return TsTarget(db_url=required("CONTRACT_DB_URL"), pin=required("CONTRACT_PIN"))
    return PyTarget(
        db_url=required("CONTRACT_DB_URL"),
        slug=env.get("CONTRACT_SLUG", "estudio-demo"),
        connection_id=required("CONTRACT_CONNECTION_ID"),
        owner_email=required("CONTRACT_OWNER_EMAIL"),
        owner_password=required("CONTRACT_OWNER_PASSWORD"),
    )
