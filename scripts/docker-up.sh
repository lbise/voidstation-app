#!/usr/bin/env bash
set -euo pipefail

if (($#)); then
  printf 'docker:up does not accept Compose overrides or service arguments.\n' >&2
  exit 64
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

node scripts/deployment-preflight.mjs
printf 'Preflight passed. Building the dashboard and assistant-worker images.\n'
docker compose --project-name voidstation-app build dashboard assistant-worker
worker_image="$(docker compose --project-name voidstation-app images --quiet assistant-worker)"
if [[ -z "$worker_image" ]]; then
  printf 'Could not find the built assistant-worker image.\n' >&2
  exit 1
fi
node scripts/worker-runtime-inspect.mjs "$worker_image"
node scripts/deployment-preflight.mjs
printf 'Preflight passed. Starting the dashboard and assistant-worker.\n'
docker compose --project-name voidstation-app up --no-build -d --no-deps dashboard assistant-worker
node scripts/deployment-preflight.mjs --postdeploy
printf 'Dashboard and assistant-worker passed post-deploy inspection.\n'
