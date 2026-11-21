"""migrations/env.py and /readyz against real databases (the app served as pialy_app)."""

import json
import os
import shutil
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pialy.clock import system_clock
from pialy.config import Settings
from pialy.main import create_app
from tests.db.support import MIGRATIONS_DIR, AppUrlFactory, ThrowawayDatabaseFactory

PHONE = "5512345678"

# Fails the migration unless env.py set the limits for online migrations.
ASSERT_MIGRATION_LIMITS = """
DO $$
BEGIN
  IF current_setting('lock_timeout') <> '5s' OR current_setting('statement_timeout') <> '5min' THEN
    RAISE EXCEPTION 'lock_timeout=%, statement_timeout=%',
      current_setting('lock_timeout'), current_setting('statement_timeout');
  END IF;
END $$
"""


def add_revision(migrations: Path, revision: str, down: str | None, upgrade_sql: str = "") -> None:
    body = f"    op.execute({upgrade_sql!r})\n" if upgrade_sql else "    pass\n"
    migrations.joinpath("versions", f"{revision}_test.py").write_text(
        f'"""Revision written by a test."""\n\nfrom alembic import op\n\nrevision = "{revision}"\n'
        f"down_revision = {down!r}\nbranch_labels = None\ndepends_on = None\n\n\n"
        f"def upgrade() -> None:\n{body}"
    )


def migrations_with(directory: Path, revisions: list[str]) -> Path:
    """The real env.py with no-op revisions, so the tests do not depend on the schema."""
    directory.joinpath("versions").mkdir(parents=True)
    shutil.copy(MIGRATIONS_DIR / "env.py", directory / "env.py")
    down: str | None = None
    for revision in revisions:
        add_revision(directory, revision, down)
        down = revision
    return directory


@pytest.fixture(scope="module")
def at_head(
    app_database_at: AppUrlFactory,
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


def test_migrations_run_with_lock_and_statement_timeouts(
    app_database_at: AppUrlFactory, tmp_path: Path
) -> None:
    migrations = migrations_with(tmp_path / "migrations", [])
    add_revision(migrations, "r0001", None, ASSERT_MIGRATION_LIMITS)
    with app_database_at(migrations):
        pass  # the upgrade raised inside the factory if the limits were missing


def test_the_alembic_cli_logs_redacted_json(
    database_at: ThrowawayDatabaseFactory, tmp_path: Path
) -> None:
    # `alembic upgrade head` as a deploy runs it: the real alembic.ini and env.py, from the
    # directory that holds them. Alembic logs each revision's docstring as it runs it.
    shutil.copy(MIGRATIONS_DIR.parent / "alembic.ini", tmp_path / "alembic.ini")
    migrations = migrations_with(tmp_path / "migrations", [])
    with database_at(migrations) as database:
        migrations.joinpath("versions", "r0001_test.py").write_text(
            f'"""Call {PHONE} back."""\n\nrevision = "r0001"\ndown_revision = None\n'
            "branch_labels = None\ndepends_on = None\n\n\ndef upgrade() -> None:\n    pass\n"
        )
        result = subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            cwd=tmp_path,
            env={**os.environ, "MIGRATION_DATABASE_URL": database.owner_url},
            capture_output=True,
            text=True,
            check=True,
            timeout=60,
        )
    assert PHONE not in result.stdout + result.stderr
    lines = [json.loads(line) for line in result.stdout.splitlines()]
    [upgrade] = [line for line in lines if line["message"].startswith("Running upgrade")]
    assert upgrade["logger"] == "alembic.runtime.migration"
    assert upgrade["level"] == "INFO"
