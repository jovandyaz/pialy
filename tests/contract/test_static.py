"""Serving the web app. The target must serve `web_root/` (see the README) as its built SPA."""

from pathlib import Path

import httpx
import pytest

from support import PROBLEM, assert_problem
from targets import Target

WEB_ROOT = Path(__file__).parent / "web_root"
INDEX = (WEB_ROOT / "index.html").read_text()
IMMUTABLE = "public, max-age=31536000, immutable"
NOT_FOUND = {"type": "about:blank", "title": "Not Found", "status": 404}


def test_serves_index_html_at_without_caching(client: httpx.Client) -> None:
    response = client.get("/")

    assert response.status_code == 200
    assert response.text == INDEX
    assert "text/html" in response.headers["content-type"]
    assert response.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize("path", ["/negocio/verificar/abc", "/c/tok", "/negocio", "/negocio/entrar"])
def test_falls_back_to_index_html_for_the_client_route(client: httpx.Client, path: str) -> None:
    response = client.get(path)

    assert response.status_code == 200
    assert response.text == INDEX
    assert response.headers["cache-control"] == "no-cache"


def test_serves_assets_with_a_long_immutable_cache(client: httpx.Client) -> None:
    response = client.get("/assets/x.js")

    assert response.status_code == 200
    assert response.text == (WEB_ROOT / "assets" / "x.js").read_text()
    assert response.headers["cache-control"] == IMMUTABLE


def test_serves_the_precompressed_brotli_variant_when_the_client_accepts_it(client: httpx.Client) -> None:
    with client.stream("GET", "/assets/big.js", headers={"accept-encoding": "br, gzip"}) as response:
        raw = b"".join(response.iter_raw())

    assert response.status_code == 200
    assert response.headers["content-encoding"] == "br"
    assert "javascript" in response.headers["content-type"]
    assert "accept-encoding" in response.headers["vary"].lower()
    assert response.headers["cache-control"] == IMMUTABLE
    assert raw == (WEB_ROOT / "assets" / "big.js.br").read_bytes()


def test_falls_back_to_the_plain_asset_when_the_client_accepts_no_encoding(client: httpx.Client) -> None:
    response = client.get("/assets/big.js", headers={"accept-encoding": "identity"})

    assert response.status_code == 200
    assert "content-encoding" not in response.headers
    assert response.text == (WEB_ROOT / "assets" / "big.js").read_text()


def test_keeps_problem_json_404_for_unknown_api_paths_and_missing_files(client: httpx.Client) -> None:
    for path in ["/api/nope", "/api", "/api?x=1", "/api/", "/assets/missing.js"]:
        response = client.get(path)
        assert_problem(response, NOT_FOUND)


def test_answers_head_on_client_routes_like_get_without_a_body(client: httpx.Client) -> None:
    response = client.head("/negocio")

    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert response.content == b""


def test_keeps_problem_json_404_for_head_on_api_paths(client: httpx.Client) -> None:
    response = client.head("/api/nope")

    assert response.status_code == 404


def test_keeps_problem_json_404_for_unknown_non_get_requests(client: httpx.Client) -> None:
    response = client.post("/negocio")

    assert response.status_code == 404
    assert PROBLEM in response.headers["content-type"]


def test_leaves_existing_routes_unaffected(client: httpx.Client, target: Target) -> None:
    response = client.get("/healthz")

    assert response.status_code == 200
    assert "application/json" in response.headers["content-type"]
    assert response.json() == target.health_body()
