"""Cross-cutting HTTP behavior: health, security headers and problem details for bad input."""

import httpx

from support import Api, is_problem, new_key


def test_reports_ok_with_a_reachable_database(client: httpx.Client) -> None:
    """The body differs by backend (`{ok, db}` on TS); both answer 200 JSON while the database is up."""
    response = client.get("/healthz")

    assert response.status_code == 200
    assert "application/json" in response.headers["content-type"]


def test_sets_security_headers(client: httpx.Client) -> None:
    response = client.get("/healthz")

    assert response.headers["x-content-type-options"] == "nosniff"


def test_maps_client_errors_to_4xx_problems(api: Api) -> None:
    response = api.client.post(
        api.url("/bookings"),
        headers={"content-type": "application/json", "idempotency-key": new_key()},
        content="{bad",
    )

    assert is_problem(response, 400)
    assert response.json()["status"] == 400
