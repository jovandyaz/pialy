"""`Idempotency-Key` on `POST /bookings`. The QR route's key cases live in test_qr.py."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest

from support import (
    HOLD_SECONDS,
    OTHER_PHONE,
    PHONE,
    PUSH_FAILED,
    Api,
    Pey,
    assert_close,
    assert_problem,
    days_ahead,
    is_problem,
    new_key,
    slot,
)

SLOT = slot(days_ahead(1), 0)


def test_holds_the_slot_and_replays_the_same_response_for_the_same_idempotency_key(api: Api, pey: Pey) -> None:
    key = new_key()

    first = api.hold({"slotStart": SLOT.start, "phone": "55 1234 5678", "customerName": "  Cliente  "}, key)
    second = api.hold({"slotStart": SLOT.start, "phone": "55 1234 5678", "customerName": "Cliente"}, key)

    assert first.status_code == 201
    assert set(first.json()) == {"token", "holdExpiresAt"}
    assert_close(first.json()["holdExpiresAt"], datetime.now(UTC) + timedelta(seconds=HOLD_SECONDS))
    assert second.status_code == 201
    assert second.content == first.content
    assert pey.calls("POST", "/codi/pn") == 1


def test_treats_a_differently_formatted_but_equal_phone_as_the_same_request(api: Api, pey: Pey) -> None:
    key = new_key()

    first = api.hold({"slotStart": SLOT.start, "phone": "+52 55 1234 5678"}, key)
    second = api.hold({"slotStart": SLOT.start, "phone": PHONE}, key)

    assert first.status_code == 201
    assert second.content == first.content
    assert pey.calls("POST", "/codi/pn") == 1


def test_accepts_the_key_as_a_structured_field_string(api: Api) -> None:
    response = api.hold({"slotStart": SLOT.start, "phone": PHONE}, f'"{new_key()}"')

    assert response.status_code == 201


@pytest.mark.parametrize(
    "key",
    [None, "abc", "a b c d e f g h i j k l m n o p", "a" * 256],
    ids=["missing", "too short", "with spaces", "too long"],
)
def test_answers_400_when_the_idempotency_key_is(api: Api, pey: Pey, key: str | None) -> None:
    response = api.hold({"slotStart": SLOT.start, "phone": PHONE}, key)

    assert is_problem(response, 400)
    assert pey.calls("POST", "/codi/pn") == 0


def test_answers_422_when_the_key_is_reused_with_another_request(api: Api) -> None:
    key = new_key()
    api.hold({"slotStart": SLOT.start, "phone": PHONE}, key)

    response = api.hold({"slotStart": slot(days_ahead(1), 1).start, "phone": PHONE}, key)

    assert response.status_code == 422
    assert response.json()["type"] == "urn:pialy:problem:idempotency-key-reused"


def test_rejects_the_same_key_with_a_different_request_and_leaves_the_first_hold_alone(api: Api, pey: Pey) -> None:
    key = new_key()
    first = api.hold({"slotStart": SLOT.start, "phone": PHONE}, key)

    response = api.hold({"slotStart": SLOT.start, "phone": OTHER_PHONE}, key)

    assert response.status_code == 422
    assert response.json()["type"] == "urn:pialy:problem:idempotency-key-reused"
    assert pey.calls("POST", "/codi/pn") == 1
    assert api.view(first.json()["token"])["status"] == "holding"


def test_answers_409_solicitud_en_proceso_while_the_same_key_is_in_flight(api: Api, pey: Pey) -> None:
    body = {"slotStart": SLOT.start, "phone": PHONE}
    key = new_key()
    pey.stall_next()

    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(api.hold, body, key)
        pey.wait_for("POST", "/codi/pn")
        second = api.hold(body, key)
        pey.release()
        first = pending.result()
    replay = api.hold(body, key)

    assert second.status_code == 409
    assert second.json()["type"] == "urn:pialy:problem:request-in-progress"
    assert second.json()["detail"] == "Solicitud en proceso"
    assert first.status_code == 201
    assert replay.content == first.content
    assert pey.calls("POST", "/codi/pn") == 1


def test_answers_the_stored_502_problem_when_the_push_cannot_be_sent_and_never_logs_the_phone(
    api: Api, pey: Pey
) -> None:
    """The log half of the TS test is not observable from outside; the stored answer is."""
    pey.fail_next(500)
    body = {"slotStart": SLOT.start, "phone": "55 1234 5678"}
    key = new_key()

    response = api.hold(body, key)
    replay = api.hold(body, key)

    assert_problem(response, PUSH_FAILED)
    assert replay.status_code == 502
    assert replay.content == response.content
    assert pey.calls("POST", "/codi/pn") == 1
