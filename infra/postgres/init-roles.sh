#!/bin/sh
# Creates the owner (migrations) and app (runtime, subject to RLS) roles.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$PIALY_OWNER_PASSWORD" -v app_pw="$PIALY_APP_PASSWORD" <<'SQL'
CREATE ROLE pialy_owner LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :'owner_pw';
CREATE ROLE pialy_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :'app_pw';
GRANT ALL ON DATABASE pialy TO pialy_owner;
GRANT CONNECT ON DATABASE pialy TO pialy_app;
GRANT ALL ON SCHEMA public TO pialy_owner;
GRANT USAGE ON SCHEMA public TO pialy_app;
SQL
