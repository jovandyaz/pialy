from pathlib import Path

from pialy.observability.readiness import is_current, migrations_head


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
