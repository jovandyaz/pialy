"""Paths, types and helpers the db fixtures (conftest.py) and the db tests share."""

from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from pathlib import Path

from alembic.config import Config
from pydantic import SecretStr

from pialy.config import Settings
from pialy.db.database import Database

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "migrations"


@dataclass(frozen=True)
class ThrowawayDatabase:
    """A database of the test cluster, owned by pialy_owner, dropped after use."""

    name: str
    owner_url: str
    app_url: str


# A throwaway database at head of the given migrations (fixture `database_at`).
type ThrowawayDatabaseFactory = Callable[[Path], AbstractContextManager[ThrowawayDatabase]]
# The same, yielding only its pialy_app URL (fixture `app_database_at`).
type AppUrlFactory = Callable[[Path], AbstractContextManager[str]]
# An `alembic.command` function, such as `command.upgrade`.
type AlembicCommand = Callable[[Config, str], None]
# Runs an AlembicCommand to a revision of the real migrations as the owner (`alembic_as_owner`).
type RunAlembic = Callable[[str, AlembicCommand, str], None]


def app_settings(url: str) -> Settings:
    """Test settings whose database is `url`."""
    return Settings(env="test", database_url=SecretStr(url))


@contextmanager
def database_at_url(url: str) -> Iterator[Database]:
    """A Database on `url` whose pools are open with their first connections; closed on exit."""
    database = Database(app_settings(url))
    database.open(wait=True)
    try:
        yield database
    finally:
        database.close()
