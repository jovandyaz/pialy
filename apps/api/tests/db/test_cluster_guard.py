"""The db fixtures reset two cluster-wide role passwords, so they refuse non-disposable clusters."""

from collections.abc import Callable, Mapping

import pytest

Guard = Callable[[str, Mapping[str, str]], None]


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://postgres:postgres@localhost:54329/pialy_test",
        "postgresql://postgres:postgres@127.0.0.1:54329/pialy_test",
        "postgresql://postgres:postgres@[::1]:54329/pialy_test",
        "host=/var/run/postgresql dbname=pialy_test user=postgres",
        "dbname=pialy_test user=postgres",
    ],
)
def test_accepts_a_cluster_on_this_machine(refuse_unless_disposable: Guard, url: str) -> None:
    refuse_unless_disposable(url, {})


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://postgres:postgres@db.example.invalid:5432/pialy",
        "postgresql://postgres:postgres@10.0.0.7:5432/pialy",
        "host=localhost,db.example.invalid dbname=pialy user=postgres",
        "host=localhost hostaddr=10.0.0.7 dbname=pialy user=postgres",
    ],
)
def test_refuses_a_remote_cluster_without_saying_its_password(
    refuse_unless_disposable: Guard, url: str
) -> None:
    with pytest.raises(pytest.fail.Exception, match="PIALY_TEST_DB_DISPOSABLE") as failure:
        refuse_unless_disposable(url, {"PIALY_TEST_DB_DISPOSABLE": "yes"})
    assert "postgres:postgres" not in str(failure.value)


def test_accepts_a_remote_cluster_marked_disposable(refuse_unless_disposable: Guard) -> None:
    # A CI job running in a container reaches its Postgres service by label, not localhost.
    refuse_unless_disposable(
        "postgresql://postgres:postgres@postgres:5432/pialy_test", {"PIALY_TEST_DB_DISPOSABLE": "1"}
    )
