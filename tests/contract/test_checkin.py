"""`POST /bookings/{token}/check-in`. A pass checks in only on its own local day, so the
successful cases book a slot later today and skip when none is left."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

import httpx

from support import Api, assert_close, days_ahead, event_stream, is_problem, slot, slot_today, unknown_token

BOOKING_CHECKED_IN = {"type": "booking.updated", "status": "checked_in"}


def check_in(api: Api, owner: httpx.Client, token: str) -> httpx.Response:
    return owner.post(api.url(f"/bookings/{token}/check-in"))


def test_checks_in_a_confirmed_booking_once_the_second_call_is_409_with_the_original_time(
    api: Api, owner: httpx.Client
) -> None:
    booking = api.confirmed(slot_today())

    first = check_in(api, owner, booking.token)
    second = check_in(api, owner, booking.token)

    assert first.status_code == 200
    assert set(first.json()) == {"checkedInAt"}
    checked_in_at = first.json()["checkedInAt"]
    assert_close(checked_in_at, datetime.now(UTC))
    assert is_problem(second, 409)
    assert second.json()["detail"] == "Este pase ya se usó"
    assert second.json()["checkedInAt"] == checked_in_at
    verified = owner.get(api.url(f"/verify/{booking.token}")).json()
    assert (verified["status"], verified["checkedInAt"]) == ("checked_in", checked_in_at)


def test_refuses_a_booking_that_is_not_confirmed_or_unknown(api: Api, owner: httpx.Client) -> None:
    """Only `holding` is reachable over HTTP; `expired` and `canceled` need the clock or a cancel route."""
    holding = api.book(slot(days_ahead(1), 0))

    refused = check_in(api, owner, holding.token)
    missing = check_in(api, owner, unknown_token())

    assert refused.status_code == 409
    assert refused.json()["detail"] == "Anticipo no confirmado"
    assert "checkedInAt" not in refused.json()
    assert missing.status_code == 404


def test_refuses_a_confirmed_pass_on_any_other_local_day_and_leaves_it_usable(api: Api, owner: httpx.Client) -> None:
    """Today against a pass for tomorrow; the other instants of the TS test need the clock."""
    booking = api.confirmed(slot(days_ahead(1), 0))

    response = check_in(api, owner, booking.token)

    assert is_problem(response, 409)
    assert response.json()["detail"] == "Este pase es para otro día"
    assert response.json()["slotStart"] == booking.slot.start
    verified = owner.get(api.url(f"/verify/{booking.token}")).json()
    assert (verified["status"], verified["checkedInAt"]) == ("confirmed", None)


def test_lets_exactly_one_of_two_simultaneous_check_ins_win(api: Api, owner: httpx.Client) -> None:
    booking = api.confirmed(slot_today())

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: check_in(api, owner, booking.token), range(2)))

    assert sorted(r.status_code for r in responses) == [200, 409]


def test_announces_the_check_in_to_the_board_and_the_booking_page_through_the_outbox(
    api: Api, owner: httpx.Client
) -> None:
    booking = api.confirmed(slot_today())

    with (
        event_stream(api.client, api.url(f"/bookings/{booking.token}/events")) as page,
        event_stream(owner, api.url("/board/events")) as board,
    ):
        assert check_in(api, owner, booking.token).status_code == 200

        page.expect_event(BOOKING_CHECKED_IN)
        board.expect_event(BOOKING_CHECKED_IN)
