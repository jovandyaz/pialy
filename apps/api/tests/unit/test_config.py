import base64
from pathlib import Path

import pytest
from pydantic import ValidationError

from pialy.config import Settings, load_settings

DATABASE_URL = "postgresql://user:pw@localhost/db"
KEY_32 = base64.b64encode(b"k" * 32).decode()

SECRETS_ENV = {
    "SESSION_SECRET": "s" * 32,
    "CREDENTIALS_ENC_KEY": KEY_32,
    "PHONE_HASH_SALT": "p" * 16,
    "AUDIT_HMAC_KEY": "a" * 32,
}

DEV_ENV = {"ENV": "development", "DATABASE_URL": DATABASE_URL, **SECRETS_ENV}

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
    set_env(monkeypatch, DEV_ENV)
    settings = load_settings()
    assert isinstance(settings, Settings)
    assert settings.env == "development"
    assert settings.port == 3000
    assert settings.deposit_max_minor == 1


@pytest.mark.parametrize("missing", sorted(SECRETS_ENV))
def test_development_requires_secrets(monkeypatch: pytest.MonkeyPatch, missing: str) -> None:
    set_env(monkeypatch, {k: v for k, v in DEV_ENV.items() if k != missing})
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert missing in failure_text(exc)


def test_test_env_generates_random_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    set_env(monkeypatch, {"ENV": "test", "DATABASE_URL": DATABASE_URL})
    assert len(load_settings().session_secret.get_secret_value()) >= 32


def test_empty_value_in_production_fails_naming_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    set_env(monkeypatch, {**PROD_ENV, "PHONE_HASH_SALT": ""})
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert "PHONE_HASH_SALT" in failure_text(exc)


def test_empty_optional_values_resolve_to_none(monkeypatch: pytest.MonkeyPatch) -> None:
    set_env(
        monkeypatch,
        {**DEV_ENV, "WEB_ROOT": "", "SENTRY_DSN": ""},
    )
    settings = load_settings()
    assert settings.web_root is None
    assert settings.sentry_dsn is None


def test_rejects_phone_hash_salt_shorter_than_16(monkeypatch: pytest.MonkeyPatch) -> None:
    env = {**DEV_ENV, "PHONE_HASH_SALT": "p" * 15}
    set_env(monkeypatch, env)
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert "PHONE_HASH_SALT" in failure_text(exc)


def test_requires_database_url() -> None:
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert "DATABASE_URL" in failure_text(exc)


def test_rejects_deposit_max_above_1_while_hackathon(monkeypatch: pytest.MonkeyPatch) -> None:
    set_env(monkeypatch, {**DEV_ENV, "DEPOSIT_MAX_MINOR": "2"})
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert "DEPOSIT_MAX_MINOR" in failure_text(exc)


def test_accepts_complete_production_env(monkeypatch: pytest.MonkeyPatch) -> None:
    set_env(monkeypatch, PROD_ENV)
    assert load_settings().env == "production"


@pytest.mark.parametrize(
    "missing",
    [
        "SESSION_SECRET",
        "CREDENTIALS_ENC_KEY",
        "PHONE_HASH_SALT",
        "AUDIT_HMAC_KEY",
        "PEY_BASE_URL",
        "PUBLIC_ORIGIN",
    ],
)
def test_requires_every_key_and_endpoint_in_production(
    monkeypatch: pytest.MonkeyPatch, missing: str
) -> None:
    set_env(monkeypatch, {k: v for k, v in PROD_ENV.items() if k != missing})
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert missing in failure_text(exc)


def test_never_echoes_values_in_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    leaked = "short-value-that-must-not-leak"
    set_env(monkeypatch, {**DEV_ENV, "SESSION_SECRET": leaked})
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert "SESSION_SECRET" in failure_text(exc)
    assert leaked not in failure_text(exc)
    assert DATABASE_URL not in failure_text(exc)


def test_rejects_session_secret_shorter_than_32(monkeypatch: pytest.MonkeyPatch) -> None:
    set_env(monkeypatch, {**DEV_ENV, "SESSION_SECRET": "s" * 31})
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert "SESSION_SECRET" in failure_text(exc)
    set_env(monkeypatch, {"SESSION_SECRET": "s" * 32})
    assert load_settings().session_secret.get_secret_value() == "s" * 32


def test_rejects_credentials_key_not_32_bytes(monkeypatch: pytest.MonkeyPatch) -> None:
    bad = base64.b64encode(b"k" * 16).decode()
    set_env(monkeypatch, {**DEV_ENV, "CREDENTIALS_ENC_KEY": bad})
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert "CREDENTIALS_ENC_KEY" in failure_text(exc)
    assert bad not in failure_text(exc)


def test_accepts_versioned_credentials_key_list(monkeypatch: pytest.MonkeyPatch) -> None:
    other = base64.b64encode(b"o" * 32).decode()
    value = f"v2:{other},v1:{KEY_32}"
    set_env(monkeypatch, {**DEV_ENV, "CREDENTIALS_ENC_KEY": value})
    assert load_settings().credentials_enc_key.get_secret_value() == value


@pytest.mark.parametrize("value", ["0", "-1", "65536", "abc"])
def test_rejects_port_outside_1_to_65535(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    set_env(monkeypatch, {**DEV_ENV, "PORT": value})
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert "PORT" in failure_text(exc)


@pytest.mark.parametrize("value", [1, 8080, 65535])
def test_accepts_ports_inside_the_range(monkeypatch: pytest.MonkeyPatch, value: int) -> None:
    set_env(monkeypatch, {**DEV_ENV, "PORT": str(value)})
    assert load_settings().port == value


def test_test_env_is_refused_outside_pytest(monkeypatch: pytest.MonkeyPatch) -> None:
    # ENV=test generates random secrets: in a deployed process it would skip the secret requirement.
    monkeypatch.delenv("PYTEST_VERSION", raising=False)
    set_env(monkeypatch, {"ENV": "test", "DATABASE_URL": DATABASE_URL})
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert "ENV" in failure_text(exc)
    with pytest.raises(ValidationError):
        Settings()


def test_test_env_is_allowed_under_pytest(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PYTEST_VERSION", "9.0.0")  # pytest defines it for the whole session
    set_env(monkeypatch, {"ENV": "test", "DATABASE_URL": DATABASE_URL})
    assert load_settings().env == "test"


@pytest.mark.parametrize("env", ["development", "production"])
def test_env_example_leaves_every_secret_unset(monkeypatch: pytest.MonkeyPatch, env: str) -> None:
    monkeypatch.setenv("ENV", env)
    example = Path(__file__).resolve().parents[2] / ".env.example"
    with pytest.raises(ValidationError) as exc:
        Settings(_env_file=example)
    failing = {str(issue["loc"][0]).upper() for issue in exc.value.errors()}
    assert failing == set(SECRETS_ENV)


def test_a_stray_env_file_in_the_cwd_is_ignored_in_tests(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # A developer's filled-in apps/api/.env must not satisfy the missing-variable tests.
    (tmp_path / ".env").write_text("".join(f"{name}={value}\n" for name, value in DEV_ENV.items()))
    monkeypatch.chdir(tmp_path)
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert "DATABASE_URL" in failure_text(exc)


def test_env_is_required_outside_tests(monkeypatch: pytest.MonkeyPatch) -> None:
    set_env(monkeypatch, {k: v for k, v in DEV_ENV.items() if k != "ENV"})
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert failure_text(exc) == "Invalid configuration: ENV"


@pytest.mark.parametrize("value", ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"])
def test_accepts_the_standard_log_levels(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    set_env(monkeypatch, {**DEV_ENV, "LOG_LEVEL": value})
    assert load_settings().log_level == value


@pytest.mark.parametrize("value", ["LOUD", "info", "5512345678"])
def test_rejects_an_unknown_log_level_naming_only_the_variable(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    set_env(monkeypatch, {**DEV_ENV, "LOG_LEVEL": value})
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert failure_text(exc) == "Invalid configuration: LOG_LEVEL"


@pytest.mark.parametrize(
    "value",
    [
        "postgresql://u:p@localhost/db",
        "postgres://u:p@db.internal:5432/pialy?sslmode=require",
        "host=localhost dbname=pialy user=pialy_app",
    ],
)
def test_accepts_postgres_connection_strings(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    set_env(monkeypatch, {**DEV_ENV, "DATABASE_URL": value, "MIGRATION_DATABASE_URL": value})
    settings = load_settings()
    assert settings.database_url.get_secret_value() == value
    assert settings.migration_database_url is not None


LEAK_MARKER = "hunter2-marker"


@pytest.mark.parametrize("name", ["DATABASE_URL", "MIGRATION_DATABASE_URL"])
@pytest.mark.parametrize(
    "value",
    [
        f"not-a-dsn {LEAK_MARKER}",
        f"postgresql://u:{LEAK_MARKER}@[bad/db",  # libpq quotes the whole URI in its error
        f"mysql://u:{LEAK_MARKER}@h/db",
        f"postgresql://u:{LEAK_MARKER}@h/db?bogus=1",
        f"password={LEAK_MARKER} foo=bar",
    ],
)
def test_rejects_a_bad_database_url_naming_only_the_variable(
    monkeypatch: pytest.MonkeyPatch, name: str, value: str
) -> None:
    set_env(monkeypatch, {**DEV_ENV, name: value})
    with pytest.raises(SystemExit) as exc:
        load_settings()
    assert failure_text(exc) == f"Invalid configuration: {name}"
    with pytest.raises(ValidationError) as error:
        Settings()
    assert LEAK_MARKER not in str(error.value.errors(include_input=False, include_url=False))
