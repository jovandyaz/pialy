#!/usr/bin/env bash
# Audits the contract suite's locked dependencies (dev group included) with the pip-audit that
# apps/api locks, so this project needs no audit tool of its own. Fails if the export fails.
# agent-toolkit-webhooks is left out: it is a git dependency, so it has no hash for --disable-pip
# and is not on PyPI for pip-audit to look up. Its own dependencies are still audited.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
requirements=$(mktemp)
trap 'rm -f "$requirements"' EXIT

uv export --locked --quiet --directory "$root/tests/contract" --no-emit-project \
  --no-emit-package agent-toolkit-webhooks --format requirements.txt --output-file "$requirements"
uv run --directory "$root/apps/api" pip-audit --disable-pip --requirement "$requirements"
