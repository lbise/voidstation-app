#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  printf 'Production deployment requires a clean checkout. Preserve and commit or stash local work first.\n' >&2
  exit 1
fi

git pull --ff-only origin main
exec npm run docker:up -- "$@"
