"""Payments through the webhook: QR payments, double payments and races between deliveries."""

from concurrent.futures import ThreadPoolExecutor
from datetime import date
from functools import partial
from typing import Literal

import httpx
import pytest

from fake_pey.server import new_transaction_id
from support import (
    OTHER_PHONE,
    PHONE,
    UNKNOWN_TX,
    Api,
    Booking,
    Json,
    Pey,
    Slot,
    event_stream,
    money,
    new_key,
    outcome,
    pn_webhook,
    race,
)

BOOKING_CONFIRMED = {"type": "booking.updated", "status": "confirmed"}
FLAG_RAISED_BLOCK = 'data: {"type":"flag.raised"}'


def failed_hold(api: Api, pey: Pey, at: Slot, phone: str = PHONE) -> str:
    """Holds `at` while pey fails the push and returns the attempt id it sent.

    The 5xx is ambiguous, so the hold ends at once and money that still arrives is a late payment.
    """
    pey.fail_next(500)
    assert api.hold({"slotStart": at.start, "phone": phone}, new_key()).status_code == 502
    return pey.last_push_attempt_id()


def test_answers_201_when_the_push_call_failed_but_its_payment_already_confirmed_the_booking(
    api: Api, pey: Pey, first_slot: Slot
) -> None:
    """The money arrives while the push call is open and the call then fails: the paid hold stands."""
    pey.fail_next(500)
    pey.stall_next()

    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(api.hold, {"slotStart": first_slot.start, "phone": PHONE}, new_key())
        [push_call] = pey.wait_for("POST", "/codi/pn")
        attempt_id = push_call["body"]["metadata"]["attemptId"]
        paid = pey.deliver(pn_webhook(new_transaction_id(), attempt_id=attempt_id))
        pey.release()
        response = pending.result()

    assert outcome(paid) == "applied"
    assert response.status_code == 201
    view = api.view(response.json()["token"])
    assert view["status"] == "confirmed"
    assert view["attempts"] == [{"mode": "push", "status": "succeeded"}]


def test_confirms_a_held_booking_when_its_payment_arrives_on_time_and_notifies_board_and_booking(
    api: Api, pey: Pey, owner: httpx.Client, first_slot: Slot
) -> None:
    booking = api.book(first_slot)

    with (
        event_stream(api.client, api.url(f"/bookings/{booking.token}/events")) as page,
        event_stream(owner, api.url("/board/events")) as board,
    ):
        assert outcome(pey.pay(booking.push_ref)) == "applied"

        page.expect_event(BOOKING_CONFIRMED)
        board.expect_event(BOOKING_CONFIRMED)
    view = api.view(booking.token)
    assert (view["status"], view["late"]) == ("confirmed", False)


def test_confirms_a_late_payment_as_late_when_the_slot_is_still_free(
    api: Api, pey: Pey, owner: httpx.Client, day: date, first_slot: Slot
) -> None:
    """A failed push ends the hold at once, so money for it arrives late without moving the clock."""
    attempt_id = failed_hold(api, pey, first_slot)

    delivered = pey.deliver(pn_webhook(new_transaction_id(), attempt_id=attempt_id))

    assert outcome(delivered) == "applied"
    booking = api.board(owner, day)["slots"][0]["booking"]
    assert (booking["status"], booking["late"]) == ("confirmed", True)
    assert api.view(booking["token"])["late"] is True
    assert api.flags(owner) == []


def test_flags_refund_due_for_a_late_payment_whose_slot_was_taken_and_still_records_the_money(
    api: Api, pey: Pey, owner: httpx.Client, day: date, first_slot: Slot
) -> None:
    attempt_id = failed_hold(api, pey, first_slot)
    taker = api.book(first_slot, phone=OTHER_PHONE)

    delivered = pey.deliver(pn_webhook(new_transaction_id(), attempt_id=attempt_id))

    assert outcome(delivered) == "applied"
    [flag] = api.flags(owner)
    assert (flag["kind"], flag["reason"]) == ("refund_due", "slot_taken")
    assert flag["amount"] == money()
    assert (flag["booking"]["phoneLast4"], flag["booking"]["slotStart"]) == (PHONE[-4:], first_slot.start)
    assert api.view(taker.token)["status"] == "holding"
    assert api.board(owner, day)["slots"][0]["booking"]["token"] == taker.token


def test_flags_refund_due_for_a_second_payment_of_a_confirmed_booking(
    api: Api, pey: Pey, owner: httpx.Client, first_slot: Slot
) -> None:
    booking = api.confirmed(first_slot)

    second = pey.deliver(pn_webhook(new_transaction_id(), attempt_id=pey.last_push_attempt_id()))

    assert outcome(second) == "applied"
    assert api.view(booking.token)["status"] == "confirmed"
    [flag] = api.flags(owner)
    assert (flag["kind"], flag["reason"]) == ("refund_due", "duplicate_payment")


def test_keeps_flagging_unmatched_payments_and_tells_the_board_without_any_customer_data(
    api: Api, pey: Pey, owner: httpx.Client
) -> None:
    with event_stream(owner, api.url("/board/events")) as board:
        assert outcome(pey.deliver(pn_webhook(UNKNOWN_TX))) == "unmatched"

        assert board.next_data() == FLAG_RAISED_BLOCK
    [flag] = api.flags(owner)
    assert (flag["kind"], flag["booking"]) == ("unmatched_payment", None)


def test_tells_the_board_about_an_amount_mismatch_while_the_booking_keeps_holding(
    api: Api, pey: Pey, owner: httpx.Client, first_slot: Slot
) -> None:
    booking = api.book(first_slot)

    with event_stream(owner, api.url("/board/events")) as board:
        assert outcome(pey.pay(booking.push_ref, amount=2)) == "unmatched"

        assert board.next_data_after_holding() == FLAG_RAISED_BLOCK
    assert api.view(booking.token)["status"] == "holding"
    [flag] = api.flags(owner)
    assert flag["kind"] == "amount_mismatch"


def test_confirms_the_booking_from_a_codi_qr_payment_received_webhook_matched_by_codiqrid_alone(
    api: Api, pey: Pey, owner: httpx.Client, first_slot: Slot
) -> None:
    booking = api.book(first_slot)
    qr_id = api.qr(booking.token)

    paid = pey.pay(qr_id, external_metadata={})

    assert outcome(paid) == "applied"
    view = api.view(booking.token)
    assert view["status"] == "confirmed"
    assert view["late"] is False
    assert view["attempts"][1] == {"mode": "qr", "status": "succeeded"}
    assert view["pass"]["trackingKey"] == paid["tracking_key"]
    assert api.flags(owner) == []


def pay_through(pey: Pey, booking: Booking, qr_id: str, kind: Literal["push", "qr"]) -> Json:
    return pey.pay(booking.push_ref if kind == "push" else qr_id)


@pytest.mark.parametrize(("first_kind", "second_kind"), [("push", "qr"), ("qr", "push")])
def test_when_first_and_then_second_are_both_paid_the_second_payment_is_recorded_and_flagged_refund_due(
    api: Api,
    pey: Pey,
    owner: httpx.Client,
    first_kind: Literal["push", "qr"],
    second_kind: Literal["push", "qr"],
    first_slot: Slot,
) -> None:
    booking = api.book(first_slot)
    qr_id = api.qr(booking.token)

    first = pay_through(pey, booking, qr_id, first_kind)
    second = pay_through(pey, booking, qr_id, second_kind)

    assert outcome(first) == "applied"
    assert outcome(second) == "applied"
    view = api.view(booking.token)
    assert view["status"] == "confirmed"
    assert [a["status"] for a in view["attempts"]] == ["succeeded", "succeeded"]
    [flag] = api.flags(owner)
    assert flag["kind"] == "refund_due"
    assert flag["reason"] == "duplicate_payment"
    assert flag["booking"]["token"] == booking.token
    assert flag["trackingKey"] == second["tracking_key"]


def test_confirms_once_and_reports_the_other_as_a_second_payment_when_two_payments_for_one_intent_race(
    api: Api, pey: Pey, owner: httpx.Client, first_slot: Slot
) -> None:
    booking = api.book(first_slot)
    qr_id = api.qr(booking.token)

    deliveries = race(partial(pey.pay, booking.push_ref), partial(pey.pay, qr_id))

    assert [outcome(d) for d in deliveries] == ["applied", "applied"]
    assert api.view(booking.token)["status"] == "confirmed"
    [flag] = api.flags(owner)
    assert (flag["kind"], flag["reason"]) == ("refund_due", "duplicate_payment")


def test_records_an_unmatched_payment_once_when_two_deliveries_race(api: Api, pey: Pey, owner: httpx.Client) -> None:
    body = pn_webhook(UNKNOWN_TX)

    deliveries = race(*[partial(pey.deliver, body)] * 2)

    assert sorted(outcome(d) for d in deliveries) == ["duplicate", "unmatched"]
    [flag] = api.flags(owner)
    assert flag["kind"] == "unmatched_payment"
