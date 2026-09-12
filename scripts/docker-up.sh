#!/usr/bin/env bash
set -euo pipefail

if (($#)); then
  printf 'docker:up does not accept Compose overrides or service arguments.\n' >&2
  exit 64
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

node scripts/deployment-preflight.mjs
printf 'Preflight passed. Building the dashboard image.\n'
docker compose --project-name voidstation-app build dashboard
node scripts/deployment-preflight.mjs
printf 'Preflight passed. Starting the dashboard.\n'
docker compose --project-name voidstation-app up --no-build -d --no-deps dashboard
node scripts/deployment-preflight.mjs --postdeploy
printf 'Dashboard passed post-deploy inspection.\n'
