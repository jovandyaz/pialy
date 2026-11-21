"""Helpers shared by the contract tests: the seeded business's calendar, the fake pey and SSE."""

from __future__ import annotations

import itertools
import json
import random
import secrets
import threading
import time
import uuid
from collections.abc import Callable, Iterator, Mapping
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from datetime import time as wall_time
from ipaddress import IPv4Address
from typing import Any, NotRequired, Required, TypedDict
from zoneinfo import ZoneInfo

import httpx
import pytest

from currency import CURRENCY, pesos
from fake_pey.server import DEFAULT_BANK_CODE, Charge, Payment, PeyWebhook, webhook_body
from targets import Target

# Wire JSON as `httpx.Response.json()` returns it (Any): the tests index answers freely, and narrowing
# every access would bury the assertions. Request bodies the suite builds are typed below instead.
type Json = dict[str, Any]


class Problem(TypedDict, total=False):
    """RFC 9457 members a test expects; the answer may hold more."""

    type: str
    title: str
    status: Required[int]
    detail: str


BUSINESS_TZ = ZoneInfo("America/Mexico_City")
OPENING = wall_time(9, 0)
SLOT_MINUTES = 45
SERVICE_MINUTES = 45
SLOTS_PER_DAY = 14
BUSINESS_NAME = "Estudio Demo"
DEPOSIT_MINOR = 1
DEPOSIT_PESOS = pesos(DEPOSIT_MINOR)
DEPOSIT_CONCEPT = f"Anticipo {BUSINESS_NAME}"
DEFAULT_BANK_NAME = "BBVA"
HOLD_SECONDS = 360
PROBLEM = "application/problem+json"
PHONE = "5512345678"
OTHER_PHONE = "3312345678"
THIRD_PHONE = "8112345678"
CUSTOMER = "Cliente Demo"
UNKNOWN_TX = "01UNKNOWNTX000000000000000"
UNMATCHED_TRACKING_KEY = "0000000001"
TOO_MANY_ATTEMPTS = "Demasiados intentos. Espera unos minutos."
HOLDING_BLOCK = 'data: {"type":"booking.updated","status":"holding"}'
SLOT_TAKEN_TYPE = "urn:pialy:problem:slot-taken"
KEY_REUSED_TYPE = "urn:pialy:problem:idempotency-key-reused"
IN_PROGRESS_TYPE = "urn:pialy:problem:request-in-progress"
PUSH_FAILED: Problem = {
    "type": "urn:pialy:problem:push-failed",
    "title": "Bad Gateway",
    "status": 502,
    "detail": "No pudimos enviar la solicitud. Intenta de nuevo.",
}
CLOCK_SKEW = timedelta(seconds=5)
REQUEST_TIMEOUT_SECONDS = 15.0
WAIT_SECONDS = 5.0
POLL_SECONDS = 0.02
RACE_START_TIMEOUT_SECONDS = 5.0
TODAY_SLOT_LEAD = timedelta(minutes=5)
# 10.0.0.0/8: a random base per run keeps two runs on one server from sharing per-IP limits.
PRIVATE_NETWORK = int(IPv4Address("10.0.0.0"))
PRIVATE_HOSTS = 2**24


def iso(instant: datetime) -> str:
    """An instant as the API writes it: UTC with milliseconds and a `Z`."""
    return instant.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso_from_epoch(seconds: int) -> str:
    return iso(datetime.fromtimestamp(seconds, UTC))


def parse_iso(text: str) -> datetime:
    return datetime.fromisoformat(text)


def today() -> date:
    return datetime.now(BUSINESS_TZ).date()


def days_ahead(count: int) -> date:
    return today() + timedelta(days=count)


@dataclass(frozen=True)
class Slot:
    start: str
    end: str


def slot(day: date, index: int) -> Slot:
    """The `index`-th slot the seeded business offers on `day` (09:00 local, every 45 minutes)."""
    start = datetime.combine(day, OPENING, BUSINESS_TZ) + timedelta(minutes=SLOT_MINUTES * index)
    return Slot(iso(start), iso(start + timedelta(minutes=SERVICE_MINUTES)))


def day_slots(day: date) -> list[Slot]:
    return [slot(day, index) for index in range(SLOTS_PER_DAY)]


def slot_today() -> Slot:
    """A slot later today, for passes that only check in on their own day; skips when none is left."""
    earliest = datetime.now(UTC) + TODAY_SLOT_LEAD
    for candidate in day_slots(today()):
        if parse_iso(candidate.start) > earliest:
            return candidate
    pytest.skip(f"no slot left today in {BUSINESS_TZ.key}; check-in needs a pass for today")


def assert_close(text: str, expected: datetime, tolerance: timedelta = CLOCK_SKEW) -> None:
    actual = parse_iso(text)
    assert abs(actual - expected) <= tolerance, f"{text} is not within {tolerance} of {iso(expected)}"


def money(amount_minor: int = DEPOSIT_MINOR) -> Json:
    """An amount as the API writes it."""
    return {"amountMinor": amount_minor, "currency": CURRENCY}


def new_key() -> str:
    return str(uuid.uuid4())


def unknown_token() -> str:
    """Shaped like a booking token (128 bits, base64url) but naming no booking."""
    return secrets.token_urlsafe(16)


class IpPool:
    """Distinct client addresses, so the per-IP limits of one test never reach another."""

    def __init__(self) -> None:
        self._next = itertools.count(random.randrange(PRIVATE_HOSTS // 2))

    def take(self) -> str:
        return str(IPv4Address(PRIVATE_NETWORK + next(self._next) % PRIVATE_HOSTS))


def new_client(base_url: str, real_ip: str | None) -> httpx.Client:
    headers = {} if real_ip is None else {"x-real-ip": real_ip}
    return httpx.Client(base_url=base_url, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS)


def is_problem(response: httpx.Response, status: int) -> bool:
    return response.status_code == status and PROBLEM in response.headers.get("content-type", "")


def assert_problem(response: httpx.Response, expected: Problem, context: str = "") -> None:
    """A problem+json answer holding `expected`; a backend may add members such as `requestId`.

    `context` names the case in a failure message, for checks made in a loop.
    """
    where = f"{context}: " if context else ""
    assert is_problem(response, expected["status"]), f"{where}{response.status_code} {response.text}"
    assert expected.items() <= response.json().items(), f"{where}{response.text}"


def retry_after_seconds(response: httpx.Response) -> int:
    """The `Retry-After` of an answer as delay-seconds (RFC 9110 section 10.2.3), the form 429s here use."""
    value = response.headers.get("retry-after", "")
    assert value.isascii() and value.isdigit(), f"Retry-After is {value!r}, not delay-seconds"
    return int(value)


def wait_until[T](probe: Callable[[], T | None], what: str) -> T:
    deadline = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < deadline:
        result = probe()
        if result is not None:
            return result
        time.sleep(POLL_SECONDS)
    raise AssertionError(f"timed out waiting for {what}")


def race[T](*calls: Callable[[], T]) -> list[T]:
    """Runs each call on its own thread, all released by one barrier, and returns their results in order.

    The barrier makes the requests overlap more often; it cannot guarantee the server sees them at once.
    """
    start = threading.Barrier(len(calls), timeout=RACE_START_TIMEOUT_SECONDS)

    def run(call: Callable[[], T]) -> T:
        start.wait()
        return call()

    with ThreadPoolExecutor(max_workers=len(calls)) as pool:
        return list(pool.map(run, calls))


class PayRequest(TypedDict):
    provider_ref: str
    amount: int
    fee: int
    bank_code: int | None
    webhook_url: str
    send: bool
    external_metadata: NotRequired[Mapping[str, object]]


class DeliverRequest(TypedDict):
    body: Mapping[str, object] | str
    webhook_url: str
    send: bool
    webhook_id: NotRequired[str]
    timestamp: NotRequired[int]


class FailNextRequest(TypedDict):
    status: int
    times: int


type ControlRequest = PayRequest | DeliverRequest | FailNextRequest


class Pey:
    """Drives the fake pey's control endpoints."""

    def __init__(self, client: httpx.Client, webhook_url: str) -> None:
        self._client = client
        self.webhook_url = webhook_url

    def _control(self, path: str, body: ControlRequest | None = None) -> Json:
        response = self._client.post(f"/_control/{path}", json=body or {})
        response.raise_for_status()
        result: Json = response.json()
        return result

    def reset(self) -> None:
        self._control("reset")

    def fail_next(self, status: int, times: int = 1) -> None:
        self._control("fail-next", FailNextRequest(status=status, times=times))

    def clear_failures(self) -> None:
        """Drops the failures `fail_next` queued that no call has used yet."""
        self._control("clear-failures")

    def stall_next(self) -> None:
        self._control("stall-next")

    def release(self) -> None:
        self._control("release")

    def requests(self, method: str, path: str) -> list[Json]:
        response = self._client.get("/_control/requests")
        response.raise_for_status()
        recorded: list[Json] = response.json()["requests"]
        return [r for r in recorded if r["method"] == method and r["path"] == path]

    def calls(self, method: str, path: str) -> int:
        return len(self.requests(method, path))

    def last_push_attempt_id(self) -> str:
        """The attempt id the target put in the metadata of its latest push charge."""
        attempt_id: str = self.requests("POST", "/codi/pn")[-1]["body"]["metadata"]["attemptId"]
        return attempt_id

    def wait_for(self, method: str, path: str, count: int = 1) -> list[Json]:
        return wait_until(
            lambda: matched if len(matched := self.requests(method, path)) >= count else None,
            f"{count} x {method} {path} at the fake pey",
        )

    def pay(
        self,
        provider_ref: str,
        amount: int = DEPOSIT_MINOR,
        *,
        fee: int = 0,
        bank_code: int | None = DEFAULT_BANK_CODE,
        external_metadata: Mapping[str, object] | None = None,
        send: bool = True,
    ) -> Json:
        """Pays a charge and delivers the signed webhook; the result holds the target's answer.

        `amount` is the charge's base and `fee` the payer's fee on top; `bank_code=None` leaves the bank out;
        `external_metadata` replaces what the charge carried.
        """
        request = PayRequest(
            provider_ref=provider_ref,
            amount=amount,
            fee=fee,
            bank_code=bank_code,
            webhook_url=self.webhook_url,
            send=send,
        )
        if external_metadata is not None:
            request["external_metadata"] = external_metadata
        return self._control("pay", request)

    def deliver(
        self,
        body: Mapping[str, object] | str,
        *,
        webhook_id: str | None = None,
        timestamp: int | None = None,
        send: bool = True,
    ) -> Json:
        """Signs any webhook body and delivers it, under `webhook_id` and at `timestamp` (epoch seconds) if given."""
        request = DeliverRequest(body=body, webhook_url=self.webhook_url, send=send)
        if webhook_id is not None:
            request["webhook_id"] = webhook_id
        if timestamp is not None:
            request["timestamp"] = timestamp
        return self._control("deliver", request)


def outcome(delivered: Json) -> str:
    """The target's `status` for a delivered webhook it accepted with 200."""
    response = delivered["response"]
    assert response["status"] == 200, response
    status: str = response["body"]["status"]
    return status


def failed_with_problem(delivered: Json, status: int) -> bool:
    response = delivered["response"]
    return response["status"] == status and PROBLEM in (response["content_type"] or "")


def pn_webhook(transaction_id: str, attempt_id: str | None = None, concept: str = DEPOSIT_CONCEPT) -> PeyWebhook:
    """A push payment webhook built the way the fake builds its own, for money no charge of the fake asked for."""
    now = int(time.time())
    external: dict[str, object] = {} if attempt_id is None else {"attemptId": attempt_id}
    charge = Charge(
        kind="pn",
        ref=transaction_id,
        concept=concept,
        num_ref="1",
        metadata=external,
        expiration=HOLD_SECONDS,
        created_at=now,
    )
    payment = Payment(
        transaction_id=transaction_id,
        charge=charge,
        amount_minor=DEPOSIT_MINOR,
        fee_minor=0,
        date_paid=now,
        tracking_key=UNMATCHED_TRACKING_KEY,
        bank_code=DEFAULT_BANK_CODE,
    )
    return webhook_body(payment, external)


def redeliver(client: httpx.Client, delivered: Json, body: str | None = None) -> httpx.Response:
    """Posts a recorded delivery again, as pey retries it; `body` replaces the signed one."""
    delivery = delivered["delivery"]
    return client.post(delivery["url"], headers=delivery["headers"], content=delivery["body"] if body is None else body)


@dataclass(frozen=True)
class Booking:
    token: str
    push_ref: str
    slot: Slot


class Api:
    """Business routes of the target, and the pey refs each call created."""

    def __init__(self, client: httpx.Client, target: Target, pey: Pey) -> None:
        self.client = client
        self.target = target
        self.pey = pey

    def url(self, path: str) -> str:
        return self.target.prefix(path)

    def hold(self, body: Mapping[str, object], key: str | None = None) -> httpx.Response:
        headers = {} if key is None else {"idempotency-key": key}
        return self.client.post(self.url("/bookings"), json=body, headers=headers)

    def book(self, at: Slot, phone: str = PHONE, customer_name: str | None = None) -> Booking:
        """Holds `at` and returns the booking with its push charge at the fake pey."""
        body: dict[str, str] = {"slotStart": at.start, "phone": phone}
        if customer_name is not None:
            body["customerName"] = customer_name
        response = self.hold(body, new_key())
        assert response.status_code == 201, response.text
        push_ref: str = self.pey.requests("POST", "/codi/pn")[-1]["response"]["transactionId"]
        return Booking(response.json()["token"], push_ref, at)

    def confirmed(
        self,
        at: Slot,
        phone: str = PHONE,
        customer_name: str | None = None,
        bank_code: int | None = DEFAULT_BANK_CODE,
    ) -> Booking:
        booking = self.book(at, phone, customer_name)
        assert outcome(self.pey.pay(booking.push_ref, bank_code=bank_code)) == "applied"
        return booking

    def post_qr(self, token: str, key: str | None = None) -> httpx.Response:
        headers = {} if key is None else {"idempotency-key": key}
        return self.client.post(self.url(f"/bookings/{token}/qr"), headers=headers)

    def qr(self, token: str) -> str:
        """Starts a QR attempt and returns its id at the fake pey."""
        response = self.post_qr(token, new_key())
        assert response.status_code == 201, response.text
        qr_id: str = self.pey.requests("POST", "/codi/qr")[-1]["response"]["id"]
        return qr_id

    def board(self, owner: httpx.Client, day: date | None = None) -> Json:
        params = {} if day is None else {"date": day.isoformat()}
        response = owner.get(self.url("/board"), params=params)
        assert response.status_code == 200, response.text
        board: Json = response.json()
        return board

    def flags(self, owner: httpx.Client) -> list[Json]:
        flags: list[Json] = self.board(owner)["flags"]
        return flags

    def view(self, token: str) -> Json:
        response = self.client.get(self.url(f"/bookings/{token}"))
        assert response.status_code == 200, response.text
        view: Json = response.json()
        return view


class EventStream:
    """Server-sent events of one open response, read block by block."""

    def __init__(self, response: httpx.Response) -> None:
        self.response = response
        self._chunks = response.iter_text()
        self._buffer = ""

    def next_block(self) -> str:
        while "\n\n" not in self._buffer:
            chunk = next(self._chunks, None)
            if chunk is None:
                raise AssertionError(f"the event stream ended; unread: {self._buffer!r}")
            self._buffer += chunk
        block, self._buffer = self._buffer.split("\n\n", 1)
        return block

    def next_data(self) -> str:
        """The next `data:` block as sent, skipping heartbeat comments."""
        while not (block := self.next_block()).startswith("data: "):
            pass
        return block

    def next_data_after_holding(self) -> str:
        """The next `data:` block other than the hold's own `holding` notice, which may still be in flight."""
        while (block := self.next_data()) == HOLDING_BLOCK:
            pass
        return block

    def expect_event(self, expected: Json) -> None:
        """Reads events until `expected`; earlier ones come from changes made before the test acted."""
        while json.loads(self.next_data().removeprefix("data: ")) != expected:
            pass


@contextmanager
def event_stream(client: httpx.Client, url: str) -> Iterator[EventStream]:
    with client.stream("GET", url) as response:
        # Held here: a collected EventStream closes its text iterator, and with it the connection.
        stream = EventStream(response)
        yield stream
