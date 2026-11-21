"""`POST /bookings` (body, slot and abuse rules) and `GET /bookings/{token}`."""

import json
import re
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import Any

import httpx
import pytest

from support import (
    DEFAULT_BANK_NAME,
    DEPOSIT_CONCEPT,
    DEPOSIT_PESOS,
    HOLD_SECONDS,
    OTHER_PHONE,
    PHONE,
    PROBLEM,
    PUSH_FAILED,
    SLOT_TAKEN_TYPE,
    TOO_MANY_ATTEMPTS,
    Api,
    IpPool,
    Pey,
    assert_close,
    assert_problem,
    days_ahead,
    is_problem,
    iso,
    new_client,
    new_key,
    parse_iso,
    race,
    slot,
)
from targets import Target

SLOT_DAY = days_ahead(1)
SLOT = slot(SLOT_DAY, 0)
IP_LIMIT = 10
PHONE_HOLD_LIMIT = 3
PHONE_LIMIT_WINDOW_SECONDS = "600"
RACE_ROUNDS = 4
TOKEN_SHAPE = re.compile(r"^[A-Za-z0-9_-]{22,}$")


def race_phone(index: int) -> str:
    return f"55123456{index:02d}"


def test_holds_the_slot_sends_one_codi_push_and_stores_only_the_last_4_digits_and_a_hash_of_the_phone(
    api: Api, pey: Pey
) -> None:
    """What is stored is not observable; the push pey receives and what the booking shows are."""
    response = api.hold({"slotStart": SLOT.start, "phone": "55 1234 5678", "customerName": "Cliente"}, new_key())

    assert response.status_code == 201
    token = response.json()["token"]
    assert TOKEN_SHAPE.match(token)
    assert_close(response.json()["holdExpiresAt"], datetime.now(UTC) + timedelta(seconds=HOLD_SECONDS))
    [push] = pey.requests("POST", "/codi/pn")
    body = push["body"]
    assert push["authorized"] is True
    assert set(body) == {"amount", "phoneNumber", "concept", "expiration", "numRef", "metadata"}
    assert (body["amount"], body["phoneNumber"]) == (DEPOSIT_PESOS, PHONE)
    assert (body["concept"], body["expiration"]) == (DEPOSIT_CONCEPT, HOLD_SECONDS)
    assert body["numRef"].isdigit()
    assert set(body["metadata"]) == {"bookingId", "attemptId"}
    view = api.view(token)
    assert view["status"] == "holding"
    assert PHONE not in json.dumps(view)


@pytest.mark.parametrize(
    "body",
    [
        {"phone": PHONE},
        {"slotStart": "mañana", "phone": PHONE},
        {"slotStart": SLOT.start},
        {"slotStart": SLOT.start, "phone": PHONE, "amount": 100},
    ],
    ids=["no slot", "a slot that is not a date", "no phone", "an amount"],
)
def test_answers_400_for_a_body_with(api: Api, body: dict[str, Any]) -> None:
    response = api.hold(body, new_key())

    assert is_problem(response, 400)


def test_answers_422_with_the_phone_message_for_a_number_that_is_not_10_digits(api: Api) -> None:
    response = api.hold({"slotStart": SLOT.start, "phone": "12345"}, new_key())

    assert response.status_code == 422
    assert response.json()["type"] == "urn:pialy:problem:invalid-phone"
    assert response.json()["detail"] == "Revisa tu número: deben ser 10 dígitos"


def test_answers_422_for_a_slot_the_business_does_not_offer(api: Api) -> None:
    off_grid = iso(parse_iso(SLOT.start) + timedelta(minutes=10))

    response = api.hold({"slotStart": off_grid, "phone": PHONE}, new_key())

    assert response.status_code == 422
    assert response.json()["type"] == "urn:pialy:problem:slot-not-offered"


def test_answers_409_slottaken_when_the_slot_is_held_by_someone_else(api: Api) -> None:
    api.book(SLOT)

    response = api.hold({"slotStart": SLOT.start, "phone": OTHER_PHONE}, new_key())

    assert is_problem(response, 409)
    assert response.json()["type"] == SLOT_TAKEN_TYPE
    assert response.json()["detail"] == "Ese horario se acaba de ocupar"


def test_two_concurrent_holds_of_one_slot_with_different_keys_one_is_held_the_other_gets_slot_taken(
    api: Api, pey: Pey
) -> None:
    """RF2 of hold-slot.test.ts: two phones, two keys, one slot; repeated on several slots."""
    for index in range(RACE_ROUNDS):
        at = slot(SLOT_DAY, index)
        bodies = [{"slotStart": at.start, "phone": race_phone(2 * index + side)} for side in (0, 1)]

        responses = race(*(partial(api.hold, body, new_key()) for body in bodies))

        assert sorted(r.status_code for r in responses) == [201, 409], at
        taken = next(r for r in responses if r.status_code == 409)
        assert is_problem(taken, 409)
        assert taken.json()["type"] == SLOT_TAKEN_TYPE
    assert pey.calls("POST", "/codi/pn") == RACE_ROUNDS


@pytest.mark.parametrize("pey_status", [500, 400], ids=["RailUnavailableError", "RailRejectedError"])
def test_on_rail_error_stores_a_502_expires_the_booking_fails_the_attempt_and_frees_the_slot(
    api: Api, pey: Pey, pey_status: int
) -> None:
    pey.fail_next(pey_status)
    body = {"slotStart": SLOT.start, "phone": PHONE}
    key = new_key()

    response = api.hold(body, key)
    replay = api.hold(body, key)

    assert_problem(response, PUSH_FAILED)
    assert replay.content == response.content
    assert pey.calls("POST", "/codi/pn") == 1
    slots = api.client.get(api.url("/slots"), params={"date": SLOT_DAY.isoformat()}).json()["slots"]
    assert slots[0]["state"] == "free"
    assert api.hold(body, new_key()).status_code == 201


def assert_ip_limited(response: httpx.Response) -> None:
    assert is_problem(response, 429)
    assert "retry-after" in response.headers
    assert response.json()["status"] == 429
    assert response.json()["detail"] == TOO_MANY_ATTEMPTS


def test_answers_429_to_the_11th_request_from_one_ip_in_10_minutes_and_not_to_another_ip(
    base_url: str, ips: IpPool, target: Target
) -> None:
    ip, other_ip = ips.take(), ips.take()
    with new_client(base_url, real_ip=None) as client:

        def from_ip(address: str) -> httpx.Response:
            return client.post(target.prefix("/bookings"), headers={"x-forwarded-for": address}, json={})

        assert [from_ip(ip).status_code for _ in range(IP_LIMIT)] == [400] * IP_LIMIT
        limited = from_ip(ip)
        other = from_ip(other_ip)

    assert_ip_limited(limited)
    assert other.status_code == 400


def test_keys_the_ip_limit_on_x_real_ip_so_requests_with_spoofed_x_forwarded_for_values_share_one_bucket(
    base_url: str, ips: IpPool, target: Target
) -> None:
    real_ip, other_real_ip = ips.take(), ips.take()
    with new_client(base_url, real_ip=None) as client:

        def send(headers: dict[str, str]) -> httpx.Response:
            return client.post(target.prefix("/bookings"), headers=headers, json={})

        for _ in range(IP_LIMIT):
            assert send({"x-real-ip": real_ip, "x-forwarded-for": ips.take()}).status_code == 400
        limited = send({"x-real-ip": real_ip, "x-forwarded-for": ips.take()})
        other_client = send({"x-real-ip": other_real_ip, "x-forwarded-for": ips.take()})

    assert_ip_limited(limited)
    assert other_client.status_code == 400


def test_falls_back_to_the_request_address_when_x_real_ip_is_not_an_ip(
    base_url: str, ips: IpPool, target: Target
) -> None:
    forwarded = ips.take()
    with new_client(base_url, real_ip=None) as client:

        def send(real_ip: str) -> httpx.Response:
            headers = {"x-real-ip": real_ip, "x-forwarded-for": forwarded}
            return client.post(target.prefix("/bookings"), headers=headers, json={})

        for attempt in range(IP_LIMIT):
            assert send(f"not-an-ip-{attempt}").status_code == 400
        limited = send("999.1.1.1")

    assert limited.status_code == 429


def test_answers_429_to_the_4th_hold_for_one_phone_within_10_minutes_replaying_a_key_does_not_count(
    api: Api, pey: Pey
) -> None:
    pey.fail_next(500, times=PHONE_HOLD_LIMIT)
    body = {"slotStart": SLOT.start, "phone": PHONE}
    keys = [new_key() for _ in range(PHONE_HOLD_LIMIT)]
    assert [api.hold(body, key).status_code for key in keys] == [502] * PHONE_HOLD_LIMIT

    replay = api.hold(body, keys[-1])
    fourth = api.hold({"slotStart": SLOT.start, "phone": "55-1234-5678"}, new_key())

    assert replay.status_code == 502
    assert is_problem(fourth, 429)
    assert fourth.headers["retry-after"] == PHONE_LIMIT_WINDOW_SECONDS
    assert fourth.json()["type"] == "urn:pialy:problem:phone-rate-limited"
    assert fourth.json()["detail"] == "Demasiados intentos con este número"
    assert api.hold({"slotStart": SLOT.start, "phone": OTHER_PHONE}, new_key()).status_code == 201


def test_answers_409_to_a_second_concurrent_hold_for_the_same_phone_then_allows_one_after_the_first_expires(
    api: Api,
) -> None:
    """Only the concurrent half: the expiry half needs clock control."""
    bodies = [{"slotStart": slot(days_ahead(1), index).start, "phone": PHONE} for index in (0, 3)]

    responses = race(*(partial(api.hold, body, new_key()) for body in bodies))

    assert sorted(r.status_code for r in responses) == [201, 409]
    conflict = next(r for r in responses if r.status_code == 409)
    assert conflict.json()["type"] == "urn:pialy:problem:active-hold-exists"
    assert conflict.json()["detail"] == "Ya tienes un apartado en curso"


def test_never_logs_the_phone_when_pey_rejects_the_push_with_a_message_that_echoes_it(api: Api, pey: Pey) -> None:
    """The log half of the TS test is not observable from outside; a 4xx from pey still ends in 502."""
    pey.fail_next(400)

    response = api.hold({"slotStart": SLOT.start, "phone": PHONE}, new_key())

    assert_problem(response, PUSH_FAILED)


def test_shows_a_held_booking_without_phone_data(api: Api) -> None:
    held = api.hold({"slotStart": SLOT.start, "phone": PHONE, "customerName": "Cliente"}, new_key()).json()

    response = api.client.get(api.url(f"/bookings/{held['token']}"))

    assert response.status_code == 200
    assert response.json() == {
        "token": held["token"],
        "status": "holding",
        "late": False,
        "slot": {"start": SLOT.start, "end": SLOT.end},
        "holdExpiresAt": held["holdExpiresAt"],
        "attempts": [{"mode": "push", "status": "awaiting"}],
    }
    assert "phoneHash" not in response.text
    assert PHONE not in response.text


def test_adds_the_pass_once_the_payment_confirmed_the_booking(api: Api, pey: Pey) -> None:
    booking = api.book(SLOT)
    paid = pey.pay(booking.push_ref)

    view = api.view(booking.token)

    assert view["status"] == "confirmed"
    assert view["attempts"] == [{"mode": "push", "status": "succeeded"}]
    assert view["pass"] == {
        "time": SLOT.start,
        "phoneLast4": PHONE[-4:],
        "bankName": DEFAULT_BANK_NAME,
        "trackingKey": paid["tracking_key"],
    }


@pytest.mark.parametrize("token", ["nope", "x" * 80, "A" * 22])
def test_answers_404_for_the_unknown_token(api: Api, token: str) -> None:
    response = api.client.get(api.url(f"/bookings/{token}"))

    assert response.status_code == 404
    assert PROBLEM in response.headers["content-type"]
