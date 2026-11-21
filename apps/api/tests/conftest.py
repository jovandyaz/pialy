import logging
from collections.abc import Iterator

import pytest

from pialy.config import Settings

SETTINGS_VARS = (
    "ENV",
    "PORT",
    "DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "PEY_BASE_URL",
    "PHONE_HASH_SALT",
    "SESSION_SECRET",
    "CREDENTIALS_ENC_KEY",
    "DEPOSIT_MAX_MINOR",
    "WEB_ROOT",
    "PUBLIC_ORIGIN",
    "AUDIT_HMAC_KEY",
    "SENTRY_DSN",
    "LOG_LEVEL",
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Start every test without any settings variable from the host environment or a `.env`.

    `Settings` reads `.env` from the working directory, which is apps/api under `pnpm api:test`:
    a developer's filled-in file would otherwise satisfy the missing-variable tests. A test that
    wants a dotenv file passes `_env_file` explicitly.
    """
    for name in SETTINGS_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    yield


@pytest.fixture
def json_logs() -> Iterator[None]:
    """Let a test call `configure_logging`, then put the root logger back as it was."""
    root = logging.getLogger()
    handlers, level = list(root.handlers), root.level
    yield
    root.handlers[:] = handlers
    root.setLevel(level)
