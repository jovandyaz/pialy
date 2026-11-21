"""`POST /bookings/{token}/qr`: QR attempts, their key and their cap."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from support import (
    BUSINESS_NAME,
    HOLD_SECONDS,
    OTHER_PHONE,
    PHONE,
    PROBLEM,
    Api,
    Booking,
    Pey,
    assert_close,
    assert_problem,
    days_ahead,
    is_problem,
    new_key,
    outcome,
    slot,
    slot_today,
)

SLOT = slot(days_ahead(1), 0)
NOT_HOLDING = {
    "type": "urn:pialy:problem:booking-not-holding",
    "title": "Conflict",
    "status": 409,
    "detail": "Esta reserva ya no está esperando el pago",
}
QR_FAILED = {
    "type": "urn:pialy:problem:qr-failed",
    "title": "Bad Gateway",
    "status": 502,
    "detail": "No pudimos generar el código QR. Intenta de nuevo.",
}


def test_creates_a_codi_qr_attempt_next_to_the_awaiting_push_and_extends_the_hold_to_its_expiry(
    api: Api, pey: Pey
) -> None:
    booking = api.book(SLOT)

    response = api.post_qr(booking.token, new_key())

    assert response.status_code == 201
    [qr_call] = pey.requests("POST", "/codi/qr")
    body = response.json()
    assert set(body) == {"qrString", "expiresAt"}
    assert body["qrString"] == qr_call["response"]["qrString"]
    assert_close(body["expiresAt"], datetime.now(UTC) + timedelta(seconds=HOLD_SECONDS))
    [push_call] = pey.requests("POST", "/codi/pn")
    assert qr_call["body"] == {
        "amount": 0.01,
        "concept": f"Anticipo {BUSINESS_NAME}",
        "expiration": HOLD_SECONDS,
        "numRef": push_call["body"]["numRef"],
        "metadata": {
            "bookingId": push_call["body"]["metadata"]["bookingId"],
            "attemptId": qr_call["body"]["metadata"]["attemptId"],
        },
    }
    assert qr_call["body"]["metadata"]["attemptId"] != push_call["body"]["metadata"]["attemptId"]
    view = api.view(booking.token)
    assert view["status"] == "holding"
    assert view["holdExpiresAt"] == body["expiresAt"]
    assert view["attempts"] == [{"mode": "push", "status": "awaiting"}, {"mode": "qr", "status": "awaiting"}]


def test_replays_the_same_response_for_the_same_idempotency_key_one_qr_one_rail_call(api: Api, pey: Pey) -> None:
    booking = api.book(SLOT)
    key = new_key()

    first = api.post_qr(booking.token, key)
    second = api.post_qr(booking.token, key)

    assert first.status_code == 201
    assert second.status_code == 201
    assert second.content == first.content
    assert pey.calls("POST", "/codi/qr") == 1
    assert len(api.view(booking.token)["attempts"]) == 2


def test_answers_422_when_the_key_was_already_used_for_another_booking(api: Api) -> None:
    first = api.book(SLOT)
    other = api.book(slot(days_ahead(1), 2), phone=OTHER_PHONE)
    key = new_key()
    assert api.post_qr(first.token, key).status_code == 201

    response = api.post_qr(other.token, key)

    assert response.status_code == 422
    assert response.json()["type"] == "urn:pialy:problem:idempotency-key-reused"
    assert len(api.view(other.token)["attempts"]) == 1


def checked_in_booking(api: Api, owner: httpx.Client) -> Booking:
    booking = api.confirmed(slot_today())
    owner.post(api.url(f"/bookings/{booking.token}/check-in")).raise_for_status()
    return booking


@pytest.mark.parametrize("status", ["confirmed", "checked_in"])
def test_answers_409_for_a_booking_that_is_without_calling_the_rail(
    api: Api, pey: Pey, request: pytest.FixtureRequest, status: str
) -> None:
    """`expired` and `canceled` are not reachable over HTTP without the clock or a cancel route."""
    if status == "confirmed":
        booking = api.confirmed(SLOT)
    else:
        booking = checked_in_booking(api, request.getfixturevalue("owner"))
    assert api.view(booking.token)["status"] == status

    response = api.post_qr(booking.token, new_key())

    assert_problem(response, NOT_HOLDING)
    assert pey.calls("POST", "/codi/qr") == 0
    assert len(api.view(booking.token)["attempts"]) == 1


@pytest.mark.parametrize("token", ["nope", "A" * 22])
def test_answers_404_for_the_unknown_token(api: Api, pey: Pey, token: str) -> None:
    response = api.post_qr(token, new_key())

    assert response.status_code == 404
    assert PROBLEM in response.headers["content-type"]
    assert pey.calls("POST", "/codi/qr") == 0


@pytest.mark.parametrize("key", [None, "abc"], ids=["missing", "too short"])
def test_answers_400_when_the_idempotency_key_is(api: Api, pey: Pey, key: str | None) -> None:
    booking = api.book(SLOT)

    response = api.post_qr(booking.token, key)

    assert is_problem(response, 400)
    assert pey.calls("POST", "/codi/qr") == 0


def test_answers_429_alcanzaste_el_maximo_de_intentos_to_the_4th_attempt_of_a_booking_failed_attempts_count(
    api: Api, pey: Pey
) -> None:
    booking = api.book(SLOT)
    first_key = new_key()

    first = api.post_qr(booking.token, first_key)
    pey.fail_next(500)
    second = api.post_qr(booking.token, new_key())
    fourth = api.post_qr(booking.token, new_key())
    replay = api.post_qr(booking.token, first_key)

    assert first.status_code == 201
    assert second.status_code == 502
    assert is_problem(fourth, 429)
    assert fourth.json()["type"] == "urn:pialy:problem:attempts-exhausted"
    assert fourth.json()["status"] == 429
    assert fourth.json()["detail"] == "Alcanzaste el máximo de intentos"
    assert replay.status_code == 201
    assert replay.content == first.content
    assert pey.calls("POST", "/codi/qr") == 2
    assert len(api.view(booking.token)["attempts"]) == 3


def test_lets_only_one_of_two_concurrent_requests_take_the_last_attempt(api: Api, pey: Pey) -> None:
    booking = api.book(SLOT)
    assert api.post_qr(booking.token, new_key()).status_code == 201

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: api.post_qr(booking.token, new_key()), range(2)))

    assert sorted(r.status_code for r in responses) == [201, 429]
    assert len(api.view(booking.token)["attempts"]) == 3
    assert pey.calls("POST", "/codi/qr") == 2


@pytest.mark.parametrize("pey_status", [500, 400], ids=["RailUnavailableError", "RailRejectedError"])
def test_on_rail_error_stores_a_502_fails_the_qr_attempt_and_keeps_the_push_hold_as_it_was(
    api: Api, pey: Pey, pey_status: int
) -> None:
    held = api.hold({"slotStart": SLOT.start, "phone": PHONE}, new_key()).json()
    pey.fail_next(pey_status)
    key = new_key()

    response = api.post_qr(held["token"], key)
    replay = api.post_qr(held["token"], key)

    assert_problem(response, QR_FAILED)
    assert replay.status_code == 502
    assert replay.content == response.content
    assert pey.calls("POST", "/codi/qr") == 1
    view = api.view(held["token"])
    assert view["status"] == "holding"
    assert view["holdExpiresAt"] == held["holdExpiresAt"]
    assert view["attempts"] == [{"mode": "push", "status": "awaiting"}, {"mode": "qr", "status": "failed"}]


def test_withholds_the_qr_with_the_409_problem_when_the_push_is_paid_during_the_qr_call_and_keeps_its_id(
    api: Api, pey: Pey
) -> None:
    held = api.hold({"slotStart": SLOT.start, "phone": PHONE}, new_key()).json()
    push_ref = pey.requests("POST", "/codi/pn")[0]["response"]["transactionId"]
    key = new_key()
    pey.stall_next()

    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(api.post_qr, held["token"], key)
        [qr_call] = pey.wait_for("POST", "/codi/qr")
        assert outcome(pey.pay(push_ref)) == "applied"
        pey.release()
        response = pending.result()
    replay = api.post_qr(held["token"], key)

    assert_problem(response, NOT_HOLDING)
    assert "qrString" not in response.text
    assert qr_call["response"]["id"] not in response.text
    assert replay.status_code == 409
    assert replay.content == response.content
    assert pey.calls("POST", "/codi/qr") == 1
    view = api.view(held["token"])
    assert view["status"] == "confirmed"
    assert view["holdExpiresAt"] == held["holdExpiresAt"]
    assert view["attempts"] == [{"mode": "push", "status": "succeeded"}, {"mode": "qr", "status": "awaiting"}]


def test_answers_409_solicitud_en_proceso_while_the_same_key_is_in_flight(api: Api, pey: Pey) -> None:
    booking = api.book(SLOT)
    key = new_key()
    pey.stall_next()

    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(api.post_qr, booking.token, key)
        pey.wait_for("POST", "/codi/qr")
        second = api.post_qr(booking.token, key)
        pey.release()
        first = pending.result()
    third = api.post_qr(booking.token, key)

    assert second.status_code == 409
    assert second.json()["type"] == "urn:pialy:problem:request-in-progress"
    assert first.status_code == 201
    assert third.content == first.content
    assert pey.calls("POST", "/codi/qr") == 1
