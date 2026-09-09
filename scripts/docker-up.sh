#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${VOIDSTATION_BIND_ADDRESS:-}" ]]; then
  bind_address="$VOIDSTATION_BIND_ADDRESS"
elif command -v ip >/dev/null 2>&1; then
  bind_address="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '
    { for (field_number = 1; field_number <= NF; field_number++) if ($field_number == "src") { print $(field_number + 1); exit } }
  ')"
  bind_address="${bind_address:-127.0.0.1}"
else
  bind_address="127.0.0.1"
fi

printf 'Starting Voidstation on %s:%s\n' "$bind_address" "${VOIDSTATION_PORT:-3000}"
exec env VOIDSTATION_BIND_ADDRESS="$bind_address" docker compose up --build -d "$@"
