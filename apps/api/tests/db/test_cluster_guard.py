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


LOCAL_URLS = [
    "postgresql://postgres:postgres@localhost:54329/pialy_test",
    "dbname=pialy_test user=postgres",  # no host: libpq takes PGHOST, PGHOSTADDR if set
]


@pytest.mark.parametrize("url", LOCAL_URLS)
@pytest.mark.parametrize(
    ("variable", "value"),
    [
        ("PGHOST", "db.example.invalid"),
        ("PGHOST", "localhost,db.example.invalid"),
        ("PGHOSTADDR", "10.0.0.7"),  # replaces the address a URL's host would resolve to
    ],
)
def test_refuses_a_libpq_host_variable_pointing_elsewhere(
    refuse_unless_disposable: Guard, url: str, variable: str, value: str
) -> None:
    with pytest.raises(pytest.fail.Exception, match=variable) as failure:
        refuse_unless_disposable(url, {variable: value})
    assert "postgres:postgres" not in str(failure.value)


@pytest.mark.parametrize(
    "environ",
    [
        {"PGHOST": "localhost"},
        {"PGHOST": "/var/run/postgresql"},
        {"PGHOSTADDR": "127.0.0.1"},
        {"PGHOST": "", "PGHOSTADDR": ""},
    ],
)
def test_accepts_libpq_host_variables_on_this_machine(
    refuse_unless_disposable: Guard, environ: dict[str, str]
) -> None:
    for url in LOCAL_URLS:
        refuse_unless_disposable(url, environ)


# A service (pg_service.conf) supplies the host, hostaddr and port the URL leaves out, from a file
# the guard does not read, so naming one is refused whatever the URL says.
@pytest.mark.parametrize(
    ("url", "environ", "named"),
    [
        ("service=pialy dbname=pialy_test user=postgres", {}, "TEST_DATABASE_URL"),
        (
            "postgresql://postgres:postgres@localhost:54329/pialy_test?service=pialy",
            {},
            "TEST_DATABASE_URL",
        ),
        (LOCAL_URLS[0], {"PGSERVICE": "pialy"}, "PGSERVICE"),
        (LOCAL_URLS[1], {"PGSERVICEFILE": "/etc/pg_service.conf"}, "PGSERVICEFILE"),
    ],
    ids=["url-service", "uri-service", "pgservice", "pgservicefile"],
)
def test_refuses_a_libpq_service(
    refuse_unless_disposable: Guard, url: str, environ: dict[str, str], named: str
) -> None:
    with pytest.raises(pytest.fail.Exception, match=named) as failure:
        refuse_unless_disposable(url, environ)
    assert "PIALY_TEST_DB_DISPOSABLE" in str(failure.value)
    assert "postgres:postgres" not in str(failure.value)


def test_a_disposable_cluster_may_be_reached_through_a_service(
    refuse_unless_disposable: Guard,
) -> None:
    refuse_unless_disposable(
        "service=pialy dbname=pialy_test", {"PGSERVICE": "pialy", "PIALY_TEST_DB_DISPOSABLE": "1"}
    )


def test_a_disposable_cluster_may_be_reached_through_pghost(
    refuse_unless_disposable: Guard,
) -> None:
    refuse_unless_disposable(
        "dbname=pialy_test user=postgres",
        {"PGHOST": "postgres", "PIALY_TEST_DB_DISPOSABLE": "1"},
    )
