"""Cross-cutting HTTP behavior: health, security headers and problem details for bad input."""

import httpx

from support import Api, is_problem, new_key
from targets import Target


def test_reports_ok_with_a_reachable_database(client: httpx.Client, target: Target) -> None:
    response = client.get(target.readiness_path())

    assert response.status_code == 200
    assert "application/json" in response.headers["content-type"]
    assert response.json() == target.readiness_body()


def content_security_policy(response: httpx.Response) -> dict[str, list[str]]:
    directives = (d.split() for d in response.headers["content-security-policy"].split(";") if d.strip())
    return {name: values for name, *values in directives}


def test_sets_security_headers(client: httpx.Client) -> None:
    """Beyond the TS test's `nosniff`: the OWASP headers both backends send, compared by directive."""
    response = client.get("/healthz")

    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    csp = content_security_policy(response)
    assert csp["default-src"] == ["'self'"]
    assert csp["script-src"] == ["'self'"]
    assert csp["frame-ancestors"] in (["'none'"], ["'self'"])


def test_maps_client_errors_to_4xx_problems(api: Api) -> None:
    response = api.client.post(
        api.url("/bookings"),
        headers={"content-type": "application/json", "idempotency-key": new_key()},
        content="{bad",
    )

    assert is_problem(response, 400)
    assert response.json()["status"] == 400
