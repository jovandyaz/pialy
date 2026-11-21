"""Process settings, read from the environment and validated at startup.

Outside production every key has a random per-process default so a developer
only needs DATABASE_URL. In production the keys must be set explicitly.
"""

import base64
import binascii
import secrets
from pathlib import Path
from typing import Literal, Self

from pydantic import AnyHttpUrl, Field, SecretStr, ValidationError, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ENC_KEY_BYTES = 32
PRODUCTION_REQUIRED = (
    "session_secret",
    "credentials_enc_key",
    "phone_hash_salt",
    "audit_hmac_key",
    "pey_base_url",
    "public_origin",
)


def _random_secret() -> SecretStr:
    return SecretStr(secrets.token_urlsafe(48))


def _random_enc_key() -> SecretStr:
    return SecretStr(base64.b64encode(secrets.token_bytes(ENC_KEY_BYTES)).decode())


def _check_enc_key_entry(entry: str) -> None:
    encoded = entry.partition(":")[2] if entry.startswith("v") and ":" in entry else entry
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("must be base64") from None
    if len(raw) != ENC_KEY_BYTES:
        raise ValueError(f"must decode to {ENC_KEY_BYTES} bytes")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(frozen=True, extra="ignore", env_file=".env")

    env: Literal["development", "test", "production"] = "development"
    port: int = 3000
    database_url: SecretStr
    migration_database_url: SecretStr | None = None
    pey_base_url: AnyHttpUrl = AnyHttpUrl("http://localhost:4010")
    phone_hash_salt: SecretStr = Field(default_factory=_random_secret)
    session_secret: SecretStr = Field(default_factory=_random_secret, min_length=32)
    credentials_enc_key: SecretStr = Field(default_factory=_random_enc_key)
    deposit_max_minor: int = Field(default=1, ge=1, le=1)  # 1 during the hackathon
    web_root: Path | None = None
    public_origin: AnyHttpUrl = AnyHttpUrl("http://localhost:3000")
    audit_hmac_key: SecretStr = Field(default_factory=_random_secret, min_length=32)
    sentry_dsn: SecretStr | None = None
    log_level: str = "INFO"

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
