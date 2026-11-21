"""Process settings, read from the environment and validated at startup.

ENV has no default. The four keys (phone_hash_salt, session_secret, credentials_enc_key,
audit_hmac_key) are required in development and production. Only env == "test"
gets random per-process values, and only under pytest. Empty variables count as unset.
"""

import base64
import binascii
import os
import secrets
from pathlib import Path
from typing import Annotated, Literal, Self

import psycopg
from psycopg.conninfo import conninfo_to_dict
from pydantic import (
    AnyHttpUrl,
    BeforeValidator,
    Field,
    SecretStr,
    ValidationError,
    field_validator,
    model_validator,
)
from pydantic_settings import BaseSettings, SettingsConfigDict

ENC_KEY_BYTES = 32
PRODUCTION_REQUIRED = ("pey_base_url", "public_origin")


def _random_secret() -> SecretStr:
    return SecretStr(secrets.token_urlsafe(48))


def _random_enc_key() -> SecretStr:
    return SecretStr(base64.b64encode(secrets.token_bytes(ENC_KEY_BYTES)).decode())


def _upper(value: object) -> object:
    return value.upper() if isinstance(value, str) else value


def _check_enc_key_entry(entry: str) -> None:
    encoded = entry.partition(":")[2] if entry.startswith("v") and ":" in entry else entry
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("must be base64") from None
    if len(raw) != ENC_KEY_BYTES:
        raise ValueError(f"must decode to {ENC_KEY_BYTES} bytes")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        frozen=True, extra="ignore", env_file=".env", env_ignore_empty=True
    )

    env: Literal["development", "test", "production"]  # no default: a deploy states its own
    port: int = Field(default=3000, ge=1, le=65535)
    database_url: SecretStr
    migration_database_url: SecretStr | None = None
    pey_base_url: AnyHttpUrl = AnyHttpUrl("http://localhost:4010")
    phone_hash_salt: SecretStr = Field(min_length=16)
    session_secret: SecretStr = Field(min_length=32)
    credentials_enc_key: SecretStr
    deposit_max_minor: int = Field(default=1, ge=1, le=1)  # 1 during the hackathon
    web_root: Path | None = None
    public_origin: AnyHttpUrl = AnyHttpUrl("http://localhost:3000")
    audit_hmac_key: SecretStr = Field(min_length=32)
    sentry_dsn: SecretStr | None = None
    log_level: Annotated[
        Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"], BeforeValidator(_upper)
    ] = "INFO"  # any case: `info` is read as `INFO`
    # Where Alembic revisions live, relative to the working directory, which is apps/api
    # for both the app and `alembic upgrade head` (alembic.ini's script_location).
    migrations_dir: Path = Path("migrations")

    @model_validator(mode="before")
    @classmethod
    def _random_keys_in_test(cls, data: dict[str, object]) -> dict[str, object]:
        if data.get("env") == "test":
            # Random keys would silently skip the key requirement in a deployed process.
            # pytest defines PYTEST_VERSION for the whole session, child processes included.
            if "PYTEST_VERSION" not in os.environ:
                raise ValueError("ENV=test is only allowed under pytest")
            data = {
                "phone_hash_salt": _random_secret(),
                "session_secret": _random_secret(),
                "audit_hmac_key": _random_secret(),
                "credentials_enc_key": _random_enc_key(),
                **data,
            }
        return data

    @field_validator("database_url", "migration_database_url")
    @classmethod
    def _valid_conninfo(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None:
            try:
                conninfo_to_dict(value.get_secret_value())
            except psycopg.Error:  # libpq's message quotes the string, password included
                raise ValueError("must be a PostgreSQL connection string") from None
        return value

    @field_validator("credentials_enc_key")
    @classmethod
    def _valid_enc_keys(cls, value: SecretStr) -> SecretStr:
        entries = [e.strip() for e in value.get_secret_value().split(",")]
        for entry in entries:
            _check_enc_key_entry(entry)
        return value

    @model_validator(mode="after")
    def _production_needs_explicit_keys(self) -> Self:
        if self.env == "production":
            missing = [n.upper() for n in PRODUCTION_REQUIRED if n not in self.model_fields_set]
            if missing:
                raise ValueError("required in production: " + ", ".join(missing))
        return self


def load_settings() -> Settings:
    """Read settings from the environment; exit naming only the failing variables."""
    try:
        return Settings()
    except ValidationError as error:
        names: list[str] = []
        for issue in error.errors(include_input=False, include_url=False):
            if issue["loc"]:
                names.append(str(issue["loc"][0]).upper())
            else:
                names.append(issue["msg"].removeprefix("Value error, "))
        raise SystemExit("Invalid configuration: " + "; ".join(dict.fromkeys(names))) from None
