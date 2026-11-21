"""Readiness: the database answers and its schema is at the Alembic head."""

from collections.abc import Callable
from pathlib import Path

from alembic.script import ScriptDirectory

from pialy.db.database import Database

ReadinessCheck = Callable[[], bool]

# A probe must not hold a request thread for the pool's full wait while the database is down.
POOL_WAIT_SECONDS = 2.0


def migrations_head(migrations_dir: Path) -> str | None:
    """The single Alembic head, or None when there are no migrations or several heads."""
    if not (migrations_dir / "versions").is_dir():
        return None
    heads = ScriptDirectory(str(migrations_dir)).get_heads()
    return heads[0] if len(heads) == 1 else None


def is_current(current: str | None, head: str | None) -> bool:
    return current is not None and current == head


def database_readiness(database: Database, migrations_dir: Path) -> ReadinessCheck:
    """A check that runs SELECT 1 on the pool and compares `alembic_version` with the head.

    The head is the code's, read once here (it imports every revision), not on each probe.
    So a broken migrations directory (a revision that does not import, a dangling down_revision)
    raises here, when the app is built, on purpose: the service fails fast instead of starting
    with a readiness check that can never pass. A missing one is no head, and never ready.
    The check reads `alembic_version` as the service role, which needs SELECT on that table.
    """
    head = migrations_head(migrations_dir)

    def check() -> bool:
        with database.system(timeout=POOL_WAIT_SECONDS) as connection:
            connection.execute("SELECT 1")
            if connection.execute("SELECT to_regclass('alembic_version')").fetchone() == (None,):
                return False
            row = connection.execute("SELECT version_num FROM alembic_version").fetchone()
        return is_current(row[0] if row else None, head)

    return check
