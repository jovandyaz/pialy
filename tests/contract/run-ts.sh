#!/usr/bin/env bash
# Runs the contract suite against a fresh TS server: test Postgres (54329), fake pey and the built
# server, with throwaway secrets generated for this run only. Extra arguments go to pytest.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
server_port=${SERVER_PORT:-3000}
pey_port=${FAKE_PEY_PORT:-4010}
database_url=postgres://postgres:postgres@localhost:54329/pialy_test
run_dir=$(mktemp -d)
pids=()

cleanup() {
  for pid in ${pids[@]+"${pids[@]}"}; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -f "$run_dir/pey-secret"
  echo "logs: $run_dir"
}
trap cleanup EXIT

for port in "$server_port" "$pey_port"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null; then
    echo "port $port is taken; set SERVER_PORT / FAKE_PEY_PORT" >&2
    exit 1
  fi
done

docker compose -f "$root/docker-compose.test.yml" up -d --wait
pnpm --dir "$root" --filter @pialy/server build
(cd "$root/apps/server" && DATABASE_URL=$database_url node dist/migrate.js && DATABASE_URL=$database_url node dist/seed.js)

webhook_secret="whsec_$(openssl rand -base64 32)"
pin=$(($(od -An -N4 -tu4 /dev/urandom) % 900000 + 100000))
(umask 077 && printf '%s' "$webhook_secret" >"$run_dir/pey-secret")

(cd "$here" && exec uv run python -m fake_pey --port "$pey_port" --secret-file "$run_dir/pey-secret") \
  >"$run_dir/fake-pey.log" 2>&1 &
pids+=($!)

# Exported rather than passed to `env`, so the secrets stay out of any process's argv.
(
  cd "$root/apps/server"
  export NODE_ENV=development PORT="$server_port" DATABASE_URL="$database_url" PEY_API_KEY=fake-pey-key
  export PEY_BASE_URL="http://127.0.0.1:$pey_port" PEY_WEBHOOK_SECRET="$webhook_secret" BUSINESS_PIN="$pin"
  COOKIE_SECRET="$(openssl rand -hex 32)" PHONE_HASH_SALT="$(openssl rand -hex 16)" WEB_ROOT="$here/web_root"
  export COOKIE_SECRET PHONE_HASH_SALT WEB_ROOT
  exec node dist/main.js
) >"$run_dir/server.log" 2>&1 &
pids+=($!)

for url in "http://127.0.0.1:$server_port/healthz" "http://127.0.0.1:$pey_port/_control/requests"; do
  for _ in $(seq 100); do curl -fs "$url" >/dev/null && break || sleep 0.2; done
  curl -fs "$url" >/dev/null || { echo "$url did not come up; see $run_dir" >&2; exit 1; }
done

cd "$here"
CONTRACT_TARGET=ts BASE_URL="http://127.0.0.1:$server_port" FAKE_PEY_URL="http://127.0.0.1:$pey_port" \
  CONTRACT_DB_URL="$database_url" CONTRACT_PIN="$pin" uv run pytest "$@"
