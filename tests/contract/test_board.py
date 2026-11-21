"""The owner's session, the board, and the verify and pass lookups."""

import time

import httpx
import pytest

from fake_pey.server import SYNTHETIC_CLABE
from support import (
    CUSTOMER,
    OTHER_PHONE,
    PHONE,
    PROBLEM,
    SLOTS_PER_DAY,
    THIRD_PHONE,
    TOO_MANY_ATTEMPTS,
    Api,
    Pey,
    days_ahead,
    is_problem,
    iso_from_epoch,
    new_client,
    new_key,
    outcome,
    slot,
    today,
    unknown_token,
)
from targets import Target, TsTarget

DAY = days_ahead(1)
PIN_ATTEMPTS_PER_IP = 5
SESSION_SECONDS = 12 * 3600
UNKNOWN_FLAG_ID = "2c4e6a1e-1f6e-4d5a-9a53-3f3b2f6e9d11"


def ts(target: Target) -> TsTarget:
    assert isinstance(target, TsTarget)
    return target


def test_answers_401_without_the_cookie_on_every_owner_endpoint(api: Api) -> None:
    token = api.confirmed(slot(DAY, 0)).token
    calls = [
        ("GET", api.url(f"/board?date={DAY.isoformat()}"), None),
        ("GET", api.url("/board/events"), None),
        ("GET", api.url(f"/verify/{token}"), None),
        ("POST", api.url(f"/bookings/{token}/check-in"), None),
        ("POST", api.url(f"/flags/{UNKNOWN_FLAG_ID}/resolve"), {"note": "x"}),
    ]

    for method, url, body in calls:
        response = api.client.request(method, url, json=body)
        assert is_problem(response, 401), f"{method} {url}"


@pytest.mark.ts_only
def test_rejects_a_wrong_pin_and_limits_attempts_to_5_per_10_minutes_per_ip_the_6th_is_429(
    client: httpx.Client, target: Target
) -> None:
    def login(pin: str) -> httpx.Response:
        return client.post("/api/session", json={"pin": pin})

    statuses = [login("wrong").status_code for _ in range(PIN_ATTEMPTS_PER_IP + 1)]
    limited = login("wrong")

    assert statuses == [401] * PIN_ATTEMPTS_PER_IP + [429]
    assert is_problem(limited, 429)
    assert limited.json()["status"] == 429
    assert limited.json()["detail"] == TOO_MANY_ATTEMPTS
    assert login(ts(target).pin).status_code == 429


@pytest.mark.ts_only
def test_sets_a_signed_httponly_samesite_strict_cookie_that_lasts_12_hours(
    client: httpx.Client, target: Target
) -> None:
    response = client.post("/api/session", json={"pin": ts(target).pin})

    assert response.status_code == 204
    set_cookie = response.headers["set-cookie"]
    assert "pialy_owner=" in set_cookie
    assert "httponly" in set_cookie.lower()
    assert "samesite=strict" in set_cookie.lower()
    assert f"Max-Age={SESSION_SECONDS}" in set_cookie
    assert "secure" not in set_cookie.lower()
    assert ts(target).pin not in set_cookie


def test_accepts_the_cookie_and_rejects_a_tampered_one_and_one_older_than_12_hours(
    api: Api, owner: httpx.Client, base_url: str
) -> None:
    """The 12-hour half needs clock control. Tampering works on whatever cookies the login set."""
    url = api.url(f"/board?date={DAY.isoformat()}")
    session = {cookie.name: cookie.value for cookie in owner.cookies.jar}

    def board_with(cookies: dict[str, str]) -> int:
        header = "; ".join(f"{name}={value}" for name, value in cookies.items())
        with new_client(base_url, real_ip=None) as anonymous:
            return anonymous.get(url, headers={"cookie": header}).status_code

    assert owner.get(url).status_code == 200
    assert board_with({name: f"{value}x" for name, value in session.items()}) == 401
    assert board_with(dict.fromkeys(session, "1.forged")) == 401


@pytest.mark.ts_only
def test_logs_out_by_clearing_the_cookie(client: httpx.Client) -> None:
    response = client.delete("/api/session")

    assert response.status_code == 204
    assert "pialy_owner=;" in response.headers["set-cookie"]


def test_lists_the_day_with_each_booking_as_name_last_4_and_bank_name_and_never_the_phone_hash_or_clabe(
    api: Api, pey: Pey, owner: httpx.Client
) -> None:
    """`late: true` needs a late payment, which needs the clock; this covers the rest of the row."""
    confirmed = api.confirmed(slot(DAY, 0), customer_name=CUSTOMER)
    api.book(slot(DAY, 1), phone=OTHER_PHONE, customer_name=CUSTOMER)
    pey.fail_next(500)
    assert api.hold({"slotStart": slot(DAY, 2).start, "phone": THIRD_PHONE}, new_key()).status_code == 502

    response = owner.get(api.url("/board"), params={"date": DAY.isoformat()})

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["date"] == DAY.isoformat()
    assert len(body["slots"]) == SLOTS_PER_DAY
    first = slot(DAY, 0)
    assert body["slots"][0] == {
        "start": first.start,
        "end": first.end,
        "booking": {
            "token": confirmed.token,
            "status": "confirmed",
            "late": False,
            "slotStart": first.start,
            "customerName": CUSTOMER,
            "phoneLast4": PHONE[-4:],
            "bankName": "BBVA",
            "checkedInAt": None,
        },
    }
    assert body["slots"][1]["booking"]["status"] == "holding"
    assert body["slots"][1]["booking"]["bankName"] is None
    assert body["slots"][2]["booking"] is None
    for secret in (SYNTHETIC_CLABE, "phoneHash", PHONE, OTHER_PHONE):
        assert secret not in response.text


def test_lists_bookings_paid_in_the_last_15_minutes_for_any_day_with_only_what_the_payment_notice_needs(
    api: Api, pey: Pey, owner: httpx.Client
) -> None:
    """Leaving out a payment older than 15 minutes needs clock control."""
    day = days_ahead(3)
    older = api.book(slot(day, 0), customer_name=CUSTOMER)
    older_paid = pey.pay(older.push_ref, bank_code=None)
    time.sleep(1)
    latest = api.book(slot(day, 2), phone=OTHER_PHONE, customer_name=CUSTOMER)
    latest_paid = pey.pay(latest.push_ref)
    api.book(slot(day, 4), phone=THIRD_PHONE)
    assert [outcome(older_paid), outcome(latest_paid)] == ["applied", "applied"]

    response = owner.get(api.url("/board"))

    assert response.status_code == 200
    body = response.json()
    assert body["date"] == today().isoformat()
    assert all(s["booking"] is None for s in body["slots"])
    assert body["recent"] == [
        {
            "token": older.token,
            "slotStart": older.slot.start,
            "customerName": CUSTOMER,
            "bankName": None,
            "confirmedAt": iso_from_epoch(older_paid["date_paid"]),
        },
        {
            "token": latest.token,
            "slotStart": latest.slot.start,
            "customerName": CUSTOMER,
            "bankName": "BBVA",
            "confirmedAt": iso_from_epoch(latest_paid["date_paid"]),
        },
    ]
    assert SYNTHETIC_CLABE not in response.text
    assert "phoneHash" not in response.text


def test_defaults_to_today_in_the_business_time_zone_and_rejects_a_malformed_date(
    api: Api, owner: httpx.Client
) -> None:
    assert api.board(owner)["date"] == today().isoformat()

    bad = owner.get(api.url("/board"), params={"date": "hoy"})

    assert bad.status_code == 400


def test_returns_the_pass_status_for_staff_behind_the_owner_cookie(api: Api, owner: httpx.Client) -> None:
    booking = api.confirmed(slot(DAY, 0), customer_name=CUSTOMER, bank_code=40072)

    response = owner.get(api.url(f"/verify/{booking.token}"))
    missing = owner.get(api.url(f"/verify/{unknown_token()}"))

    assert response.status_code == 200
    assert response.json() == {
        "token": booking.token,
        "status": "confirmed",
        "late": False,
        "slotStart": booking.slot.start,
        "customerName": CUSTOMER,
        "phoneLast4": PHONE[-4:],
        "bankName": "Banorte",
        "checkedInAt": None,
    }
    assert missing.status_code == 404
    assert PROBLEM in missing.headers["content-type"]


def test_adds_the_payer_bank_name_to_the_customer_pass_null_when_the_code_is_unknown(api: Api) -> None:
    known = api.confirmed(slot(DAY, 0), bank_code=40014)
    unknown = api.confirmed(slot(DAY, 1), phone=OTHER_PHONE, bank_code=12345)
    none = api.confirmed(slot(DAY, 2), phone=THIRD_PHONE, bank_code=None)

    assert api.view(known.token)["pass"]["bankName"] == "Santander"
    assert api.view(unknown.token)["pass"]["bankName"] is None
    assert api.view(none.token)["pass"]["bankName"] is None
