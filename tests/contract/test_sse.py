"""Server-sent events: a booking's page stream and the owner's board stream."""

from contextlib import ExitStack

import httpx
import pytest

from support import Api, Pey, Slot, event_stream, is_problem, outcome, wait_until

LISTENERS_PER_BOOKING = 20
RECONNECT_BLOCK = "retry: 2000"
CONFIRMED_BLOCK = 'data: {"type":"booking.updated","status":"confirmed"}'


def test_streams_the_booking_topic_event_stream_headers_reconnect_delay_then_events_only_after_they_commit(
    api: Api, pey: Pey, first_slot: Slot
) -> None:
    """Commit ordering is internal; from outside, the payment's event arrives with only type and status."""
    booking = api.book(first_slot)

    with event_stream(api.client, api.url(f"/bookings/{booking.token}/events")) as stream:
        assert stream.response.status_code == 200
        assert stream.response.headers["content-type"] == "text/event-stream"
        assert stream.response.headers["cache-control"] == "no-cache"
        assert stream.response.headers["x-accel-buffering"] == "no"
        assert stream.next_block() == RECONNECT_BLOCK

        assert outcome(pey.pay(booking.push_ref)) == "applied"

        assert stream.next_data_after_holding() == CONFIRMED_BLOCK


def open_listeners(stack: ExitStack, api: Api, token: str, count: int) -> None:
    for _ in range(count):
        stream = stack.enter_context(event_stream(api.client, api.url(f"/bookings/{token}/events")))
        assert stream.next_block() == RECONNECT_BLOCK


def stream_status(api: Api, token: str) -> int:
    with event_stream(api.client, api.url(f"/bookings/{token}/events")) as stream:
        return stream.response.status_code


def test_unsubscribes_when_the_client_goes_away(api: Api, first_slot: Slot) -> None:
    """Seen from outside through the per-booking cap: closed listeners free their places."""
    booking = api.book(first_slot)
    with ExitStack() as stack:
        open_listeners(stack, api, booking.token, LISTENERS_PER_BOOKING)
        assert stream_status(api, booking.token) == 503

    wait_until(lambda: True if stream_status(api, booking.token) == 200 else None, "a freed listener place")


@pytest.mark.parametrize(
    "token", ["AAAAAAAAAAAAAAAAAAAAAA", "not!a!token"], ids=["an unknown token", "a malformed token"]
)
def test_answers_404_for(api: Api, token: str) -> None:
    response = api.client.get(api.url(f"/bookings/{token}/events"))

    assert is_problem(response, 404)


def test_answers_503_when_the_booking_already_has_as_many_listeners_as_allowed(api: Api, first_slot: Slot) -> None:
    booking = api.book(first_slot)

    with ExitStack() as stack:
        open_listeners(stack, api, booking.token, LISTENERS_PER_BOOKING)
        with event_stream(api.client, api.url(f"/bookings/{booking.token}/events")) as refused:
            refused.response.read()
            response = refused.response

    assert is_problem(response, 503)
    assert response.json()["status"] == 503
    assert response.json()["type"] == "urn:pialy:problem:live-updates-busy"


def test_streams_the_board_topic_to_the_owner(api: Api, owner: httpx.Client) -> None:
    with event_stream(owner, api.url("/board/events")) as stream:
        assert stream.response.status_code == 200
        assert stream.response.headers["content-type"] == "text/event-stream"
