import base64

import pytest

from pialy.config import Settings, load_settings

DATABASE_URL = "postgresql://user:pw@localhost/db"
KEY_32 = base64.b64encode(b"k" * 32).decode()

PROD_ENV = {
    "ENV": "production",
    "DATABASE_URL": DATABASE_URL,
    "PEY_BASE_URL": "https://pey.example",
    "PUBLIC_ORIGIN": "https://pialy.example",
    "SESSION_SECRET": "s" * 32,
    "CREDENTIALS_ENC_KEY": KEY_32,
    "PHONE_HASH_SALT": "p" * 16,
    "AUDIT_HMAC_KEY": "a" * 32,
}


def set_env(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    for name, value in env.items():
        monkeypatch.setenv(name, value)


def failure_text(exc: pytest.ExceptionInfo[SystemExit]) -> str:
    return str(exc.value.code)


def test_accepts_minimal_development_env_with_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    set_env(monkeypatch, {"DATABASE_URL": DATABASE_URL})
    settings = load_settings()
    assert isinstance(settings, Settings)
    assert settings.env == "development"
    assert settings.port == 3000
    assert settings.deposit_max_minor == 1


def test_requires_database_url() -> None:
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert "DATABASE_URL" in failure_text(exc)


def test_rejects_deposit_max_above_1_while_hackathon(monkeypatch: pytest.MonkeyPatch) -> None:
    set_env(monkeypatch, {"DATABASE_URL": DATABASE_URL, "DEPOSIT_MAX_MINOR": "2"})
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert "DEPOSIT_MAX_MINOR" in failure_text(exc)


def test_accepts_complete_production_env(monkeypatch: pytest.MonkeyPatch) -> None:
    set_env(monkeypatch, PROD_ENV)
    assert load_settings().env == "production"


@pytest.mark.parametrize("missing", ["SESSION_SECRET", "CREDENTIALS_ENC_KEY", "PHONE_HASH_SALT"])
def test_requires_every_secret_in_production(monkeypatch: pytest.MonkeyPatch, missing: str) -> None:
    set_env(monkeypatch, {k: v for k, v in PROD_ENV.items() if k != missing})
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert missing in failure_text(exc)


def test_never_echoes_values_in_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    leaked = "short-value-that-must-not-leak"
    set_env(monkeypatch, {"DATABASE_URL": DATABASE_URL, "SESSION_SECRET": leaked})
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert "SESSION_SECRET" in failure_text(exc)
    assert leaked not in failure_text(exc)
    assert DATABASE_URL not in failure_text(exc)


def test_rejects_session_secret_shorter_than_32(monkeypatch: pytest.MonkeyPatch) -> None:
    set_env(monkeypatch, {"DATABASE_URL": DATABASE_URL, "SESSION_SECRET": "s" * 31})
    with pytest.raises(SystemExit):
        load_settings()
    set_env(monkeypatch, {"SESSION_SECRET": "s" * 32})
    assert load_settings().session_secret.get_secret_value() == "s" * 32


def test_rejects_credentials_key_not_32_bytes(monkeypatch: pytest.MonkeyPatch) -> None:
    bad = base64.b64encode(b"k" * 16).decode()
    set_env(monkeypatch, {"DATABASE_URL": DATABASE_URL, "CREDENTIALS_ENC_KEY": bad})
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert "CREDENTIALS_ENC_KEY" in failure_text(exc)
    assert bad not in failure_text(exc)


def test_accepts_versioned_credentials_key_list(monkeypatch: pytest.MonkeyPatch) -> None:
    other = base64.b64encode(b"o" * 32).decode()
    value = f"v2:{other},v1:{KEY_32}"
    set_env(monkeypatch, {"DATABASE_URL": DATABASE_URL, "CREDENTIALS_ENC_KEY": value})
    assert load_settings().credentials_enc_key.get_secret_value() == value
