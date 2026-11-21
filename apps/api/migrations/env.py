"""Alembic environment for raw SQL revisions: no SQLAlchemy models, no autogenerate.

Migrations run as the owner role, from MIGRATION_DATABASE_URL (any libpq connection string).
All pending revisions run in one transaction: a failing one leaves the schema as it was.
"""

import os
from logging.config import fileConfig

import psycopg
from alembic import context
from psycopg.rows import TupleRow
from sqlalchemy import create_engine, pool

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)


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
            context.run_migrations()


if context.is_offline_mode():
    raise SystemExit("offline (--sql) mode is not supported; revisions are already plain SQL")
run_migrations_online()
