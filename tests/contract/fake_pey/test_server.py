"""The fake's handling of bad input: every malformed request gets a 4xx answer, never a dropped connection."""

import socket
import sys
from urllib.parse import urlsplit

import httpx
import pytest

from fake_pey.server import MAX_BODY_BYTES

AUTHORIZED = {"authorization": "Bearer fake-pey-key"}
PUSH_BODY = {"amount": 0.01, "concept": "Anticipo", "expiration": 360, "numRef": "1", "phoneNumber": "5512345678"}
SOCKET_TIMEOUT_SECONDS = 5.0
SIGNED_AT = 1_700_000_000


def status_for_content_length(url: str, content_length: str) -> int | None:
    """The status the fake answers to a bodyless control call that declares `content_length`; None if it hangs up."""
    parts = urlsplit(url)
    request = f"POST /_control/reset HTTP/1.1\r\nHost: fake\r\nContent-Length: {content_length}\r\n\r\n"
    with socket.create_connection((parts.hostname, parts.port), timeout=SOCKET_TIMEOUT_SECONDS) as connection:
        connection.sendall(request.encode())
        status_line = connection.makefile("rb").readline()
    return int(status_line.split()[1]) if status_line else None


@pytest.mark.parametrize(
    "content_length",
    ["-1", "abc", "²", "1" * (sys.get_int_max_str_digits() + 1), "1" + "0" * len(str(MAX_BODY_BYTES))],
    ids=["negative", "not a number", "a unicode digit", "past the int conversion limit", "one digit too long"],
)
def test_answers_400_to_a_content_length_it_cannot_read(fake_url: str, content_length: str) -> None:
    assert status_for_content_length(fake_url, content_length) == 400


@pytest.mark.parametrize(
    "metadata", [[], "", 0, False, "x"], ids=["empty list", "empty string", "zero", "false", "text"]
)
def test_answers_a_pey_400_to_a_charge_whose_metadata_is_not_an_object(fake: httpx.Client, metadata: object) -> None:
    response = fake.post("/codi/pn", json=PUSH_BODY | {"metadata": metadata}, headers=AUTHORIZED)

    assert response.status_code == 400
    assert response.json()["error"]["type"] == "INVALID_PARAMETER"


@pytest.mark.parametrize("metadata", [None, {"attemptId": "a"}], ids=["null", "an object"])
def test_accepts_a_charge_whose_metadata_is_null_or_an_object(fake: httpx.Client, metadata: object) -> None:
    response = fake.post("/codi/pn", json=PUSH_BODY | {"metadata": metadata}, headers=AUTHORIZED)

    assert response.status_code == 201


def test_accepts_a_charge_without_metadata(fake: httpx.Client) -> None:
    assert fake.post("/codi/pn", json=PUSH_BODY, headers=AUTHORIZED).status_code == 201


@pytest.mark.parametrize(
    "options",
    [
        {"webhook_url": "127.0.0.1:3000/api/webhooks/pey"},
        {"webhook_url": "ftp://127.0.0.1/api/webhooks/pey"},
        {"webhook_url": "http://"},
        {"webhook_url": 3000},
        {"webhook_url": "http://127.0.0.1:3000/api/webhooks pey"},
        {"webhook_url": "http://127.0.0.1:99999/api/webhooks/pey"},
        {"webhook_url": "http://127.0.0.1:3000/api/webhooks/pey", "webhook_id": 7},
        {"webhook_url": "http://127.0.0.1:3000/api/webhooks/pey", "webhook_id": ""},
        {"webhook_url": "http://127.0.0.1:3000/api/webhooks/pey", "timestamp": "now"},
        {"webhook_url": "http://127.0.0.1:3000/api/webhooks/pey", "timestamp": 10**20},
        {"webhook_url": "http://127.0.0.1:3000/api/webhooks/pey", "send": "no"},
    ],
    ids=[
        "a url without scheme",
        "a url that is not http",
        "a url without host",
        "a url that is not a string",
        "a url with a space",
        "a url with a port out of range",
        "an id that is not a string",
        "an empty id",
        "a timestamp that is not an int",
        "a timestamp past any date",
        "a send flag that is not a boolean",
    ],
)
def test_answers_400_to_a_delivery_it_cannot_make(fake: httpx.Client, options: dict[str, object]) -> None:
    response = fake.post("/_control/deliver", json={"body": {"type": "x"}, "send": False} | options)

    assert response.status_code == 400
    assert "error" in response.json()


@pytest.mark.parametrize("send", [False, True], ids=["signed only", "sent"])
@pytest.mark.parametrize(
    "webhook_url", ["http://127.0.0.1:1/\u00f1", "http://a..b/x"], ids=["a non-ascii path", "an empty host label"]
)
def test_answers_400_to_a_url_urllib_cannot_encode(fake: httpx.Client, webhook_url: str, send: bool) -> None:
    """These pass a scheme-and-host check, yet urllib fails to encode them (ascii path, idna host) on send."""
    response = fake.post("/_control/deliver", json={"body": {"type": "x"}, "webhook_url": webhook_url, "send": send})

    assert response.status_code == 400


def test_signs_a_delivery_at_the_timestamp_it_is_given(fake: httpx.Client) -> None:
    body = {"body": {"type": "x"}, "webhook_url": "http://127.0.0.1:3000/x", "timestamp": SIGNED_AT, "send": False}

    response = fake.post("/_control/deliver", json=body)

    assert response.status_code == 200
    assert response.json()["delivery"]["headers"]["webhook-timestamp"] == str(SIGNED_AT)
