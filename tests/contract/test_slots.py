from collections.abc import Callable
from datetime import UTC, datetime

import pytest

from support import OTHER_PHONE, SLOTS_PER_DAY, Api, day_slots, days_ahead, is_problem, parse_iso, slot, today


def test_lists_the_day_with_free_held_and_taken_slots(api: Api) -> None:
    day = days_ahead(1)
    api.book(slot(day, 0))
    api.confirmed(slot(day, 1), phone=OTHER_PHONE)

    response = api.client.get(api.url("/slots"), params={"date": day.isoformat()})

    assert response.status_code == 200
    slots = response.json()["slots"]
    assert len(slots) == SLOTS_PER_DAY
    first, second, third = (slot(day, index) for index in range(3))
    assert slots[:3] == [
        {"start": first.start, "end": first.end, "state": "held"},
        {"start": second.start, "end": second.end, "state": "taken"},
        {"start": third.start, "end": third.end, "state": "free"},
    ]


def test_leaves_out_slots_that_already_started_today(api: Api) -> None:
    """The target reads its clock between `before` and `after`; a slot starting in between may go either way."""
    day = today()
    before = datetime.now(UTC)

    response = api.client.get(api.url("/slots"), params={"date": day.isoformat()})

    after = datetime.now(UTC)
    assert response.status_code == 200
    starts = [s["start"] for s in response.json()["slots"]]
    either = [[s.start for s in day_slots(day) if parse_iso(s.start) > instant] for instant in (before, after)]
    assert starts in either, f"{starts} is neither list for a clock read between {before} and {after}"


@pytest.mark.parametrize(
    "query_for",
    [
        lambda: {},
        lambda: {"date": days_ahead(-1).isoformat()},
        lambda: {"date": "mañana"},
        lambda: {"date": "2026-02-30"},
    ],
    ids=["no date", "a past date", "not a date", "an impossible date"],
)
def test_answers_400_for(api: Api, query_for: Callable[[], dict[str, str]]) -> None:
    response = api.client.get(api.url("/slots"), params=query_for())

    assert is_problem(response, 400)
