"""Flags on the board and their resolution."""

from datetime import UTC, datetime

import httpx

from support import (
    CUSTOMER,
    DEPOSIT_MINOR,
    PHONE,
    Api,
    Pey,
    assert_close,
    days_ahead,
    iso_from_epoch,
    outcome,
    slot,
)

RESOLUTION_NOTE = "Reembolsado por SPEI"


def test_shows_open_flags_with_their_booking_and_hides_resolved_ones(api: Api, pey: Pey, owner: httpx.Client) -> None:
    booking = api.book(slot(days_ahead(1), 0), customer_name=CUSTOMER)
    qr_id = api.qr(booking.token)
    assert outcome(pey.pay(booking.push_ref)) == "applied"
    second = pey.pay(qr_id)
    assert outcome(second) == "applied"

    [flag] = api.flags(owner)

    assert flag == {
        "id": flag["id"],
        "kind": "refund_due",
        "trackingKey": second["tracking_key"],
        "createdAt": flag["createdAt"],
        "reason": "duplicate_payment",
        "paidAt": iso_from_epoch(second["date_paid"]),
        "amount": {"amountMinor": DEPOSIT_MINOR, "currency": "MXN"},
        "expected": None,
        "received": None,
        "booking": {
            "token": booking.token,
            "customerName": CUSTOMER,
            "phoneLast4": PHONE[-4:],
            "slotStart": booking.slot.start,
        },
    }
    assert isinstance(flag["createdAt"], str)
    resolve_url = api.url(f"/flags/{flag['id']}/resolve")

    resolved = owner.post(resolve_url, json={"note": RESOLUTION_NOTE})

    assert resolved.status_code == 200
    assert resolved.json()["id"] == flag["id"]
    assert_close(resolved.json()["resolvedAt"], datetime.now(UTC))
    assert set(resolved.json()) == {"id", "resolvedAt"}
    assert api.flags(owner) == []
    assert owner.post(resolve_url, json={"note": "otra vez"}).status_code == 404
    assert owner.post(resolve_url, json={}).status_code == 400
