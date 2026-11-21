"""The pey webhook route: signature, inbox, matching and amount checks."""

import json
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx

from support import (
    DEPOSIT_MINOR,
    PROBLEM,
    UNKNOWN_TX,
    Api,
    Pey,
    days_ahead,
    failed_with_problem,
    outcome,
    pn_webhook,
    redeliver,
    slot,
)

SLOT_DAY = days_ahead(1)
SLOT = slot(SLOT_DAY, 0)
EXPECTED_MONEY = {"amountMinor": DEPOSIT_MINOR, "currency": "MXN"}


def push_attempt_id(pey: Pey) -> str:
    attempt_id: str = pey.requests("POST", "/codi/pn")[-1]["body"]["metadata"]["attemptId"]
    return attempt_id


def test_applies_a_signed_payment_once_booking_confirmed_money_trace_outbox_and_inbox_rows(api: Api, pey: Pey) -> None:
    booking = api.book(SLOT)

    paid = pey.pay(booking.push_ref)

    assert outcome(paid) == "applied"
    view = api.view(booking.token)
    assert view["status"] == "confirmed"
    assert view["attempts"] == [{"mode": "push", "status": "succeeded"}]
    assert view["pass"]["trackingKey"] == paid["tracking_key"]


def test_answers_a_redelivery_of_the_same_webhook_id_as_duplicate_without_new_rows(
    api: Api, pey: Pey, owner: httpx.Client
) -> None:
    booking = api.book(SLOT)
    paid = pey.pay(booking.push_ref)
    view_before, board_before = api.view(booking.token), api.board(owner, SLOT_DAY)

    response = redeliver(api.client, paid)

    assert response.status_code == 200
    assert response.json() == {"status": "duplicate"}
    assert api.view(booking.token) == view_before
    assert api.board(owner, SLOT_DAY) == board_before


def test_rejects_a_tampered_body_with_401_writes_nothing_and_logs_only_the_webhook_id(
    api: Api, pey: Pey, owner: httpx.Client
) -> None:
    """The log half of the TS test is not observable; the untouched delivery still applying shows nothing was kept."""
    booking = api.book(SLOT)
    signed = pey.pay(booking.push_ref, send=False)
    tampered = json.dumps(json.loads(signed["delivery"]["body"]) | {"amount": 100})

    response = redeliver(api.client, signed, body=tampered)

    assert response.status_code == 401
    assert PROBLEM in response.headers["content-type"]
    assert api.view(booking.token)["status"] == "holding"
    assert api.flags(owner) == []
    assert redeliver(api.client, signed).json() == {"status": "applied"}


def test_records_a_payment_no_attempt_claims_and_flags_it_unmatched(api: Api, pey: Pey, owner: httpx.Client) -> None:
    booking = api.book(SLOT)

    delivered = pey.deliver(pn_webhook(UNKNOWN_TX, attempt_id=str(uuid.uuid4())))

    assert outcome(delivered) == "unmatched"
    [flag] = api.flags(owner)
    assert flag["kind"] == "unmatched_payment"
    assert flag["booking"] is None
    assert flag["amount"] == EXPECTED_MONEY
    assert api.view(booking.token)["status"] == "holding"


def test_matches_by_metadata_attemptid_when_the_transaction_id_is_not_stored_yet(api: Api, pey: Pey) -> None:
    """pey notifies before the push call returned: only the attempt id in the metadata can match."""
    pey.stall_next()

    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(api.book, SLOT)
        [push_call] = pey.wait_for("POST", "/codi/pn")
        paid = pey.pay(push_call["response"]["transactionId"])
        pey.release()
        booking = pending.result()

    assert outcome(paid) == "applied"
    view = api.view(booking.token)
    assert view["status"] == "confirmed"
    assert view["attempts"] == [{"mode": "push", "status": "succeeded"}]


def test_treats_an_attemptid_that_is_not_one_of_ours_as_unmatched(api: Api, pey: Pey) -> None:
    api.book(SLOT)

    delivered = pey.deliver(pn_webhook(UNKNOWN_TX, attempt_id="att_not_a_uuid"))

    assert outcome(delivered) == "unmatched"


def test_applies_a_fee_inclusive_webhook_amount_once_the_rail_confirms_the_base_amount(api: Api, pey: Pey) -> None:
    booking = api.book(SLOT)

    paid = pey.pay(booking.push_ref, fee=2)

    assert json.loads(paid["delivery"]["body"])["amount"] == 0.03
    assert outcome(paid) == "applied"
    assert pey.calls("GET", f"/transaction/{booking.push_ref}") == 1
    assert api.view(booking.token)["status"] == "confirmed"


def test_keeps_the_money_trace_and_flags_amount_mismatch_when_the_rail_confirms_a_wrong_amount(
    api: Api, pey: Pey, owner: httpx.Client
) -> None:
    booking = api.book(SLOT)

    paid = pey.pay(booking.push_ref, amount=2)

    assert outcome(paid) == "unmatched"
    [flag] = api.flags(owner)
    assert flag["kind"] == "amount_mismatch"
    assert flag["booking"]["token"] == booking.token
    assert flag["expected"] == EXPECTED_MONEY
    assert flag["received"] == {"amountMinor": 2, "currency": "MXN"}
    assert api.view(booking.token)["status"] == "holding"


def test_answers_500_and_records_nothing_when_the_rail_cannot_confirm_the_amount_so_a_later_reconcile_applies(
    api: Api, pey: Pey, owner: httpx.Client
) -> None:
    """The TS test reconciles in process; from outside, pey's redelivery after the 500 is what applies it."""
    booking = api.book(SLOT)
    pey.fail_next(503, times=3)

    paid = pey.pay(booking.push_ref, fee=2)

    assert failed_with_problem(paid, 500)
    assert api.view(booking.token)["status"] == "holding"
    assert api.flags(owner) == []
    assert redeliver(api.client, paid).json() == {"status": "applied"}
    assert api.view(booking.token)["status"] == "confirmed"


def test_answers_500_to_a_signed_but_malformed_payment_event_so_pey_retries_and_writes_nothing(
    api: Api, pey: Pey, owner: httpx.Client
) -> None:
    booking = api.book(SLOT)

    delivered = pey.deliver({"type": "codi.pn.payment_received", "amount": 0.01})

    assert failed_with_problem(delivered, 500)
    assert api.view(booking.token)["status"] == "holding"
    assert api.flags(owner) == []


def test_keeps_the_raw_body_out_of_the_logs_when_storing_the_payment_fails(
    api: Api, pey: Pey, owner: httpx.Client
) -> None:
    """Postgres jsonb rejects \\u0000, so storing the raw body fails; the log half is not observable."""
    booking = api.book(SLOT)
    body = pn_webhook(booking.push_ref, attempt_id=push_attempt_id(pey), concept="Anticipo\u0000cita")

    delivered = pey.deliver(body)

    assert failed_with_problem(delivered, 500)
    assert "\\u0000" in delivered["delivery"]["body"]
    assert api.view(booking.token)["status"] == "holding"
    assert api.flags(owner) == []


def test_logs_a_verified_event_that_reports_no_payment_and_ignores_it(pey: Pey) -> None:
    delivered = pey.deliver({"type": "bank_account.updated", "id": "ba_1"})

    assert outcome(delivered) == "ignored"
