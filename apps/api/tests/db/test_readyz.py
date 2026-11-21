"""/readyz against a real database, served as pialy_app through the app's own Database."""

import shutil
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pialy.clock import system_clock
from pialy.config import Settings
from pialy.main import create_app

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "migrations"


def add_revision(migrations: Path, revision: str, down: str | None) -> None:
    migrations.joinpath("versions", f"{revision}_noop.py").write_text(
        f'"""No-op revision for readiness tests."""\n\nrevision = "{revision}"\n'
        f"down_revision = {down!r}\nbranch_labels = None\ndepends_on = None\n\n\n"
        "def upgrade() -> None:\n    pass\n"
    )


def migrations_with(directory: Path, revisions: list[str]) -> Path:
    """The real env.py with no-op revisions, so the test does not depend on the schema."""
    directory.joinpath("versions").mkdir(parents=True)
    shutil.copy(MIGRATIONS_DIR / "env.py", directory / "env.py")
    down: str | None = None
    for revision in revisions:
        add_revision(directory, revision, down)
        down = revision
    return directory


@pytest.fixture(scope="module")
def at_head(
    app_database_at: Callable[[Path], AbstractContextManager[str]],
    tmp_path_factory: pytest.TempPathFactory,
) -> Iterator[tuple[str, Path]]:
    migrations = migrations_with(tmp_path_factory.mktemp("readyz") / "migrations", ["r0001"])
    with app_database_at(migrations) as app_url:
        yield app_url, migrations


def client_for(monkeypatch: pytest.MonkeyPatch, app_url: str, migrations: Path) -> TestClient:
    monkeypatch.setenv("ENV", "test")
    monkeypatch.setenv("DATABASE_URL", app_url)
    monkeypatch.setenv("MIGRATIONS_DIR", str(migrations))
    return TestClient(create_app(Settings(), system_clock))


def test_readyz_is_200_when_the_database_is_at_head(
    at_head: tuple[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    app_url, migrations = at_head
    with client_for(monkeypatch, app_url, migrations) as client:
        response = client.get("/readyz")
    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


def test_readyz_is_503_when_the_code_is_ahead_of_the_database(
    at_head: tuple[str, Path], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app_url, migrations = at_head
    ahead = tmp_path / "migrations"
    shutil.copytree(migrations, ahead)
    add_revision(ahead, "r0002", "r0001")
    with client_for(monkeypatch, app_url, ahead) as client:
        assert client.get("/readyz").status_code == 503
