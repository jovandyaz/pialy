from pathlib import Path

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory

from pialy.config import Settings
from pialy.observability.readiness import is_current, migrations_head

API_DIR = Path(__file__).resolve().parents[2]


def write_revision(versions: Path, revision: str, down: str | None) -> None:
    versions.joinpath(f"{revision}.py").write_text(
        f'revision = "{revision}"\ndown_revision = {down!r}\nbranch_labels = None\n'
        "depends_on = None\n\ndef upgrade() -> None:\n    pass\n"
    )


def test_head_is_none_without_a_migrations_directory(tmp_path: Path) -> None:
    assert migrations_head(tmp_path / "missing") is None
    (tmp_path / "empty").mkdir()
    assert migrations_head(tmp_path / "empty") is None


def test_head_is_none_without_migrations(tmp_path: Path) -> None:
    (tmp_path / "versions").mkdir()
    assert migrations_head(tmp_path) is None


def test_head_is_the_latest_revision(tmp_path: Path) -> None:
    versions = tmp_path / "versions"
    versions.mkdir()
    write_revision(versions, "0001", None)
    write_revision(versions, "0002", "0001")
    assert migrations_head(tmp_path) == "0002"


def test_several_heads_count_as_no_head(tmp_path: Path) -> None:
    versions = tmp_path / "versions"
    versions.mkdir()
    write_revision(versions, "0001", None)
    write_revision(versions, "0002", None)
    assert migrations_head(tmp_path) is None


def test_current_only_when_database_matches_head() -> None:
    assert is_current("0002", "0002")
    assert not is_current("0001", "0002")
    assert not is_current(None, "0002")
    assert not is_current("0002", None)
    assert not is_current(None, None)


def test_readiness_and_the_alembic_cli_read_the_same_migrations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.chdir(API_DIR)  # where `alembic upgrade head` and the app both run
    monkeypatch.setenv("ENV", "test")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@localhost/db")
    cli = ScriptDirectory.from_config(Config(API_DIR / "alembic.ini"))
    assert Path(cli.dir).resolve() == Settings().migrations_dir.resolve()
    assert (API_DIR / "migrations" / "versions").is_dir()


def test_migrations_dir_is_a_setting(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("ENV", "test")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@localhost/db")
    monkeypatch.setenv("MIGRATIONS_DIR", str(tmp_path))
    assert Settings().migrations_dir == tmp_path
