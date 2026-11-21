"""migrations/env.py as the alembic CLI runs it, before any database is reached."""

import os
import subprocess
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[2]
MARKER = "dsn-marker-pw"


def test_a_connection_failure_exits_without_the_connection_string() -> None:
    # libpq quotes the whole string, password included, in this parse error.
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=API_DIR,
        env={**os.environ, "MIGRATION_DATABASE_URL": f"postgresql://u:{MARKER}@[::1/db"},
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert result.returncode == 1
    assert MARKER not in result.stdout + result.stderr
    assert result.stderr.strip().endswith("cannot connect: ProgrammingError")
