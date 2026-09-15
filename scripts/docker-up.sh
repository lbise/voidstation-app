#!/usr/bin/env bash
set -euo pipefail

cutover=false
case "$#:$*" in
  0:) ;;
  1:--cutover) cutover=true ;;
  *)
    printf 'Usage: docker:up [--cutover]\n' >&2
    printf 'Use --cutover only for the owner-authorized first LAN deployment.\n' >&2
    exit 64
    ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ $cutover == true ]]; then
  if [[ ${VOIDSTATION_INITIAL_LAN_CUTOVER:-} != approved ]]; then
    printf 'Set VOIDSTATION_INITIAL_LAN_CUTOVER=approved for an owner-authorized initial LAN cutover.\n' >&2
    exit 64
  fi
  node scripts/deployment-preflight.mjs --precutover
else
  # Routine updates must prove both existing paths before they replace images.
  node scripts/deployment-preflight.mjs --predeploy
fi

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
docker compose --project-name voidstation-app up --no-build -d --no-deps assistant-worker
# A new certificate directory does not change the image or Compose configuration.
# Recreate the Dashboard to load it, but do not force an unchanged worker restart.
docker compose --project-name voidstation-app up --no-build -d --no-deps --force-recreate dashboard
node scripts/deployment-preflight.mjs --postdeploy
printf 'Dashboard and assistant-worker passed post-deploy inspection.\n'
