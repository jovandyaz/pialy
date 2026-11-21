import os
from collections.abc import Iterator
from datetime import date

import httpx
import pytest

# Before the import: only test modules and conftest files get assertion rewriting by default.
pytest.register_assert_rewrite("support")

from support import REQUEST_TIMEOUT_SECONDS, Api, IpPool, Pey, Slot, days_ahead, new_client, slot  # noqa: E402
from targets import Target, target_from_env, target_name  # noqa: E402

ONLY_MARKERS = {"ts_only": "ts", "py_only": "py"}


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    for item in items:
        for marker, only in ONLY_MARKERS.items():
            # Resolved only for marked tests, so the fake's own tests run without CONTRACT_TARGET.
            found = item.get_closest_marker(marker)
            if found and target_name() != only:
                why = found.kwargs.get("reason", "login-specific case")
                item.add_marker(pytest.mark.skip(reason=f"CONTRACT_TARGET={only} only: {why}"))


@pytest.fixture(scope="session")
def target() -> Target:
    return target_from_env()


@pytest.fixture(scope="session")
def base_url() -> str:
    return os.environ.get("BASE_URL", "http://127.0.0.1:3000")


@pytest.fixture(scope="session")
def pey_url() -> str:
    return os.environ.get("FAKE_PEY_URL", "http://127.0.0.1:4010")


@pytest.fixture(scope="session")
def ips() -> IpPool:
    return IpPool()


@pytest.fixture(scope="session", autouse=True)
def services_up(base_url: str, pey_url: str) -> None:
    for url in (f"{base_url}/healthz", f"{pey_url}/_control/requests"):
        try:
            httpx.get(url).raise_for_status()
        except httpx.HTTPError as error:
            pytest.exit(f"{url} is not answering ({error}); start the services as the README says", returncode=2)


@pytest.fixture
def pey(base_url: str, pey_url: str, target: Target) -> Iterator[Pey]:
    with httpx.Client(base_url=pey_url, timeout=REQUEST_TIMEOUT_SECONDS) as client:
        yield Pey(client, f"{base_url}{target.webhook_path()}")


@pytest.fixture(autouse=True)
def clean_state(target: Target, pey: Pey) -> Iterator[None]:
    target.reset_db()
    pey.reset()
    yield
    pey.release()


@pytest.fixture
def client(base_url: str, ips: IpPool) -> Iterator[httpx.Client]:
    with new_client(base_url, ips.take()) as anonymous:
        yield anonymous


@pytest.fixture
def owner(base_url: str, ips: IpPool, target: Target) -> Iterator[httpx.Client]:
    with new_client(base_url, ips.take()) as signed_in:
        target.login(signed_in)
        yield signed_in


@pytest.fixture
def api(client: httpx.Client, target: Target, pey: Pey) -> Api:
    return Api(client, target, pey)


@pytest.fixture
def day() -> date:
    """Tomorrow in the business's time zone, taken when the test starts, so a run past midnight stays right."""
    return days_ahead(1)


@pytest.fixture
def first_slot(day: date) -> Slot:
    """The first slot `day` offers."""
    return slot(day, 0)
