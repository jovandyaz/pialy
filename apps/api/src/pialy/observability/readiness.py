"""Readiness: the database answers and its schema is at the Alembic head."""

from collections.abc import Callable
from pathlib import Path

import psycopg
from alembic.script import ScriptDirectory

ReadinessCheck = Callable[[], bool]

CONNECT_TIMEOUT_SECONDS = 2
STATEMENT_TIMEOUT_MS = 2000
DEFAULT_MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"


def migrations_head(migrations_dir: Path) -> str | None:
    """The single Alembic head, or None when there are no migrations or several heads."""
    if not (migrations_dir / "versions").is_dir():
        return None
    heads = ScriptDirectory(str(migrations_dir)).get_heads()
    return heads[0] if len(heads) == 1 else None


def is_current(current: str | None, head: str | None) -> bool:
    return current is not None and current == head


def database_readiness(
    database_url: str, migrations_dir: Path = DEFAULT_MIGRATIONS_DIR
) -> ReadinessCheck:
    """A check that connects, runs SELECT 1 and compares `alembic_version` with the head."""

    def check() -> bool:
        with psycopg.connect(
            database_url,
            connect_timeout=CONNECT_TIMEOUT_SECONDS,
            options=f"-c statement_timeout={STATEMENT_TIMEOUT_MS}",
        ) as connection:
            connection.execute("SELECT 1")
            if connection.execute("SELECT to_regclass('alembic_version')").fetchone() == (None,):
                return False
            row = connection.execute("SELECT version_num FROM alembic_version").fetchone()
        return is_current(row[0] if row else None, migrations_head(migrations_dir))

    return check
