"""The fake's own tests start it in process, so the suite's live-service fixtures do not apply here."""

import base64
import secrets
import threading
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

from fake_pey.server import FakePey, PeyServer

SECRET_BYTES = 32
SHUTDOWN_POLL_SECONDS = 0.01


@pytest.fixture(scope="session", autouse=True)
def services_up() -> None:
    """Overrides the suite's check: no target or external fake is needed."""


@pytest.fixture(autouse=True)
def clean_state() -> None:
    """Overrides the suite's reset: every test gets a fresh fake."""


@pytest.fixture
def fake_url(tmp_path: Path) -> Iterator[str]:
    secret_file = tmp_path / "pey-secret"
    secret_file.write_text("whsec_" + base64.b64encode(secrets.token_bytes(SECRET_BYTES)).decode())
    server = PeyServer(("127.0.0.1", 0), FakePey(secret_file, webhook_url=None))
    thread = threading.Thread(target=server.serve_forever, args=(SHUTDOWN_POLL_SECONDS,), daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()
    thread.join()


@pytest.fixture
def fake(fake_url: str) -> Iterator[httpx.Client]:
    with httpx.Client(base_url=fake_url) as client:
        yield client
