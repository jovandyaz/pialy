"""The pey webhook route: signature, inbox, matching and amount checks."""

import base64
import json
import secrets
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, timedelta
from functools import partial

import httpx
import pytest
from agent_toolkit.webhooks.testing import sign

from support import (
    DEPOSIT_PESOS,
    PROBLEM,
    UNKNOWN_TX,
    Api,
    Pey,
    Slot,
    failed_with_problem,
    money,
    outcome,
    pn_webhook,
    race,
    redeliver,
)

INTERNAL_ERROR = {"type": "about:blank", "title": "Internal Server Error", "status": 500}
# More failures than any sane retry policy makes, so the rail stays down whatever the target's count.
RAIL_OUTAGE_FAILURES = 10
# Fields a payload validation error would name; none may reach the sender.
VALIDATED_FIELDS = ("transactionId", "datePaid", "metadata")
NO_PAYMENT_EVENT = {"type": "bank_account.updated", "id": "ba_1"}
NO_PAYMENT_WEBHOOK_ID = "msg_no_payment_1"
WEBHOOK_TOLERANCE = timedelta(minutes=5)
TOLERANCE_MARGIN = timedelta(minutes=1)
SECRET_BYTES = 32


def test_applies_a_signed_payment_once_booking_confirmed_money_trace_outbox_and_inbox_rows(
    api: Api, pey: Pey, first_slot: Slot
) -> None:
    booking = api.book(first_slot)

    paid = pey.pay(booking.push_ref)

    assert outcome(paid) == "applied"
    view = api.view(booking.token)
    assert view["status"] == "confirmed"
    assert view["attempts"] == [{"mode": "push", "status": "succeeded"}]
    assert view["pass"]["trackingKey"] == paid["tracking_key"]


def test_answers_a_redelivery_of_the_same_webhook_id_as_duplicate_without_new_rows(
    api: Api, pey: Pey, owner: httpx.Client, day: date, first_slot: Slot
) -> None:
    booking = api.book(first_slot)
    paid = pey.pay(booking.push_ref)
    view_before, board_before = api.view(booking.token), api.board(owner, day)

    response = redeliver(api.client, paid)

    assert response.status_code == 200
    assert response.json() == {"status": "duplicate"}
    assert api.view(booking.token) == view_before
    assert api.board(owner, day) == board_before


def test_applies_one_of_two_concurrent_deliveries_of_the_same_webhook_id_and_answers_the_other_as_duplicate(
    api: Api, pey: Pey, owner: httpx.Client, first_slot: Slot
) -> None:
    booking = api.book(first_slot)
    signed = pey.pay(booking.push_ref, send=False)

    responses = race(*[partial(redeliver, api.client, signed)] * 2)

    assert [r.status_code for r in responses] == [200, 200]
    assert sorted(r.json()["status"] for r in responses) == ["applied", "duplicate"]
    view = api.view(booking.token)
    assert view["status"] == "confirmed"
    assert view["attempts"] == [{"mode": "push", "status": "succeeded"}]
    assert api.flags(owner) == []


def test_rejects_a_tampered_body_with_401_writes_nothing_and_logs_only_the_webhook_id(
    api: Api, pey: Pey, owner: httpx.Client, first_slot: Slot
) -> None:
    """The log half of the TS test is not observable; the untouched delivery still applying shows nothing was kept."""
    booking = api.book(first_slot)
    signed = pey.pay(booking.push_ref, send=False)
    tampered = json.dumps(json.loads(signed["delivery"]["body"]) | {"amount": 100})

    response = redeliver(api.client, signed, body=tampered)

    assert response.status_code == 401
    assert PROBLEM in response.headers["content-type"]
    assert api.view(booking.token)["status"] == "holding"
    assert api.flags(owner) == []
    assert redeliver(api.client, signed).json() == {"status": "applied"}


def test_records_a_payment_no_attempt_claims_and_flags_it_unmatched(
    api: Api, pey: Pey, owner: httpx.Client, first_slot: Slot
) -> None:
    booking = api.book(first_slot)

    delivered = pey.deliver(pn_webhook(UNKNOWN_TX, attempt_id=str(uuid.uuid4())))

    assert outcome(delivered) == "unmatched"
    [flag] = api.flags(owner)
    assert flag["kind"] == "unmatched_payment"
    assert flag["booking"] is None
    assert flag["amount"] == money()
    assert api.view(booking.token)["status"] == "holding"


def test_matches_by_metadata_attemptid_when_the_transaction_id_is_not_stored_yet(
    api: Api, pey: Pey, first_slot: Slot
) -> None:
    """pey notifies before the push call returned: only the attempt id in the metadata can match."""
    pey.stall_next()

    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(api.book, first_slot)
        [push_call] = pey.wait_for("POST", "/codi/pn")
        paid = pey.pay(push_call["response"]["transactionId"])
        pey.release()
        booking = pending.result()

    assert outcome(paid) == "applied"
    view = api.view(booking.token)
    assert view["status"] == "confirmed"
    assert view["attempts"] == [{"mode": "push", "status": "succeeded"}]


def test_treats_an_attemptid_that_is_not_one_of_ours_as_unmatched(api: Api, pey: Pey, first_slot: Slot) -> None:
    api.book(first_slot)

    delivered = pey.deliver(pn_webhook(UNKNOWN_TX, attempt_id="att_not_a_uuid"))

    assert outcome(delivered) == "unmatched"


def test_applies_a_fee_inclusive_webhook_amount_once_the_rail_confirms_the_base_amount(
    api: Api, pey: Pey, first_slot: Slot
) -> None:
    booking = api.book(first_slot)

    paid = pey.pay(booking.push_ref, fee=2)

    assert json.loads(paid["delivery"]["body"])["amount"] == 0.03
    assert outcome(paid) == "applied"
    assert pey.calls("GET", f"/transaction/{booking.push_ref}") == 1
    assert api.view(booking.token)["status"] == "confirmed"


def test_keeps_the_money_trace_and_flags_amount_mismatch_when_the_rail_confirms_a_wrong_amount(
    api: Api, pey: Pey, owner: httpx.Client, first_slot: Slot
) -> None:
    booking = api.book(first_slot)

    paid = pey.pay(booking.push_ref, amount=2)

    assert outcome(paid) == "unmatched"
    [flag] = api.flags(owner)
    assert flag["kind"] == "amount_mismatch"
    assert flag["booking"]["token"] == booking.token
    assert flag["expected"] == money()
    assert flag["received"] == money(2)
    assert api.view(booking.token)["status"] == "holding"


def test_answers_500_and_records_nothing_when_the_rail_cannot_confirm_the_amount_so_a_later_reconcile_applies(
    api: Api, pey: Pey, owner: httpx.Client, first_slot: Slot
) -> None:
    """The TS test reconciles in process; from outside, pey's redelivery after the 500 is what applies it."""
    booking = api.book(first_slot)
    pey.fail_next(503, times=RAIL_OUTAGE_FAILURES)

    paid = pey.pay(booking.push_ref, fee=2)

    assert failed_with_problem(paid, 500)
    assert pey.calls("GET", f"/transaction/{booking.push_ref}") >= 1
    assert api.view(booking.token)["status"] == "holding"
    assert api.flags(owner) == []
    pey.clear_failures()
    assert redeliver(api.client, paid).json() == {"status": "applied"}
    assert api.view(booking.token)["status"] == "confirmed"


def test_answers_500_to_a_signed_but_malformed_payment_event_so_pey_retries_and_writes_nothing(
    api: Api, pey: Pey, owner: httpx.Client, first_slot: Slot
) -> None:
    booking = api.book(first_slot)

    delivered = pey.deliver({"type": "codi.pn.payment_received", "amount": DEPOSIT_PESOS})

    assert failed_with_problem(delivered, 500)
    problem = delivered["response"]["body"]
    assert INTERNAL_ERROR.items() <= problem.items(), problem
    assert "detail" not in problem
    assert [field for field in VALIDATED_FIELDS if field in json.dumps(problem)] == []
    assert api.view(booking.token)["status"] == "holding"
    assert api.flags(owner) == []


def test_keeps_the_raw_body_out_of_the_logs_when_storing_the_payment_fails(
    api: Api, pey: Pey, owner: httpx.Client, first_slot: Slot
) -> None:
    """Postgres jsonb rejects \\u0000, so storing the raw body fails; the log half is not observable."""
    booking = api.book(first_slot)
    body = pn_webhook(booking.push_ref, attempt_id=pey.last_push_attempt_id(), concept="Anticipo\u0000cita")

    delivered = pey.deliver(body)

    assert failed_with_problem(delivered, 500)
    assert "\\u0000" in delivered["delivery"]["body"]
    assert api.view(booking.token)["status"] == "holding"
    assert api.flags(owner) == []


def test_logs_a_verified_event_that_reports_no_payment_and_ignores_it(pey: Pey) -> None:
    delivered = pey.deliver(NO_PAYMENT_EVENT)

    assert outcome(delivered) == "ignored"


def test_answers_a_redelivery_of_a_no_payment_event_with_the_same_webhook_id_as_duplicate(pey: Pey) -> None:
    """No payment means no provider transaction id to dedupe on: only the inbox's webhook id can.

    Each delivery is signed afresh; the same body under a new webhook id is a new event.
    """
    first = pey.deliver(NO_PAYMENT_EVENT, webhook_id=NO_PAYMENT_WEBHOOK_ID)
    again = pey.deliver(NO_PAYMENT_EVENT, webhook_id=NO_PAYMENT_WEBHOOK_ID)
    other_id = pey.deliver(NO_PAYMENT_EVENT)

    assert [outcome(first), outcome(again), outcome(other_id)] == ["ignored", "duplicate", "ignored"]


@pytest.mark.parametrize(
    "offset", [-(WEBHOOK_TOLERANCE + TOLERANCE_MARGIN), WEBHOOK_TOLERANCE + TOLERANCE_MARGIN], ids=["stale", "future"]
)
def test_rejects_a_delivery_signed_more_than_5_minutes_from_now_with_401_and_records_nothing(
    pey: Pey, offset: timedelta
) -> None:
    """Standard Webhooks: a timestamp outside the tolerance is a possible replay; the fresh one shows no inbox row."""
    signed_at = int((datetime.now(UTC) + offset).timestamp())

    rejected = pey.deliver(NO_PAYMENT_EVENT, webhook_id=NO_PAYMENT_WEBHOOK_ID, timestamp=signed_at)
    fresh = pey.deliver(NO_PAYMENT_EVENT, webhook_id=NO_PAYMENT_WEBHOOK_ID)

    assert failed_with_problem(rejected, 401)
    assert outcome(fresh) == "ignored"


@pytest.mark.parametrize(
    "offset", [-(WEBHOOK_TOLERANCE - TOLERANCE_MARGIN), WEBHOOK_TOLERANCE - TOLERANCE_MARGIN], ids=["past", "future"]
)
def test_accepts_a_delivery_signed_within_5_minutes_of_now(pey: Pey, offset: timedelta) -> None:
    signed_at = int((datetime.now(UTC) + offset).timestamp())

    assert outcome(pey.deliver(NO_PAYMENT_EVENT, timestamp=signed_at)) == "ignored"


def test_accepts_a_signature_header_that_also_lists_a_signature_by_another_secret(api: Api, pey: Pey) -> None:
    """Standard Webhooks rotation: `webhook-signature` lists signatures space-delimited; one valid one is enough."""
    signed = pey.deliver(NO_PAYMENT_EVENT, send=False)
    delivery = signed["delivery"]
    headers = delivery["headers"]
    other_secret = "whsec_" + base64.b64encode(secrets.token_bytes(SECRET_BYTES)).decode()
    signed_at = datetime.fromtimestamp(int(headers["webhook-timestamp"]), UTC)
    other = sign(delivery["body"].encode(), other_secret, headers["webhook-id"], signed_at)["webhook-signature"]

    only_other = api.client.post(
        delivery["url"], headers={**headers, "webhook-signature": other}, content=delivery["body"]
    )
    both = api.client.post(
        delivery["url"],
        headers={**headers, "webhook-signature": f"{other} {headers['webhook-signature']}"},
        content=delivery["body"],
    )

    assert only_other.status_code == 401
    assert PROBLEM in only_other.headers["content-type"]
    assert both.status_code == 200
    assert both.json() == {"status": "ignored"}
