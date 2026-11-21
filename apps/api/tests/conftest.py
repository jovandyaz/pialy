from collections.abc import Iterator

import pytest

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
    """Start every test without any settings variable from the host environment."""
    for name in SETTINGS_VARS:
        monkeypatch.delenv(name, raising=False)
    yield
