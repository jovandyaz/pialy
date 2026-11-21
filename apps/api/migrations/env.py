"""Alembic environment for raw SQL revisions: no SQLAlchemy models, no autogenerate.

Migrations run as the owner role, from MIGRATION_DATABASE_URL (any libpq connection string).
All pending revisions run in one transaction: a failing one leaves the schema as it was.

Online-migration limits, set before any revision runs:
- lock_timeout 5s: DDL waiting for a lock held by live traffic gives up (and the deploy fails)
  instead of queueing every later query on that table behind its ACCESS EXCLUSIVE request.
- statement_timeout 5min: generous room for a backfill, but no statement runs unbounded.
"""

import os

import psycopg
from alembic import context
from psycopg.rows import TupleRow
from sqlalchemy import create_engine, pool

from pialy.observability.logging import configure_logging

config = context.config

# The alembic CLI (it reads alembic.ini) logs through pialy's redacting JSON handler, as the app
# does: Alembic logs each revision's docstring. A caller that builds its own Config without the
# file, such as the db test fixtures, keeps the logging it has.
if config.config_file_name is not None:
    configure_logging("INFO")


def _conninfo() -> str:
    conninfo = os.environ.get("MIGRATION_DATABASE_URL")
    if not conninfo:
        raise SystemExit("MIGRATION_DATABASE_URL is not set")
    return conninfo


def run_migrations_online() -> None:
    conninfo = _conninfo()

    def connect() -> psycopg.Connection[TupleRow]:
        return psycopg.connect(conninfo)

    # psycopg makes the connection; SQLAlchemy only provides the dialect Alembic needs.
    engine = create_engine("postgresql+psycopg://", creator=connect, poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=None)
        with context.begin_transaction():
            connection.exec_driver_sql("SET lock_timeout = '5s'")
            connection.exec_driver_sql("SET statement_timeout = '5min'")
            context.run_migrations()


if context.is_offline_mode():
    raise SystemExit("offline (--sql) mode is not supported; revisions are already plain SQL")
run_migrations_online()
