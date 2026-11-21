from datetime import UTC, datetime, timedelta

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
    now = datetime.now(UTC)

    response = api.client.get(api.url("/slots"), params={"date": today().isoformat()})

    assert response.status_code == 200
    expected = [s.start for s in day_slots(today()) if parse_iso(s.start) > now]
    assert [s["start"] for s in response.json()["slots"]] == expected


@pytest.mark.parametrize(
    "query",
    [
        {},
        {"date": (today() - timedelta(days=1)).isoformat()},
        {"date": "mañana"},
        {"date": "2026-02-30"},
    ],
    ids=["no date", "a past date", "not a date", "an impossible date"],
)
def test_answers_400_for(api: Api, query: dict[str, str]) -> None:
    response = api.client.get(api.url("/slots"), params=query)

    assert is_problem(response, 400)
