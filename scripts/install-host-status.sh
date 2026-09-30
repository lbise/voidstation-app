#!/usr/bin/env bash
# Install or update the root host-status helper and its 15-minute timer.
# Run on the Server from the repository checkout: sudo scripts/install-host-status.sh
# Safe to re-run. It never runs apt update and never wakes sleeping drives.
set -euo pipefail

status_directory=/var/lib/voidstation/host-status
repository=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)

fail() {
  printf 'install-host-status: %s\n' "$*" >&2
  exit 1
}

[[ $(id -u) -eq 0 ]] || fail 'run with sudo.'
command -v python3 > /dev/null || fail 'python3 is required.'
[[ -x /usr/bin/python3 ]] || fail '/usr/bin/python3 is required by the helper.'

# Root services must not execute files from the writable checkout; install copies.
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$repository/scripts/host/voidstation-host-status.py" \
  /usr/local/libexec/voidstation-host-status
install -o root -g root -m 0644 "$repository/deploy/voidstation-host-status.service" \
  "$repository/deploy/voidstation-host-status.timer" /etc/systemd/system/

# Leave an existing parent's ownership and mode alone; other state lives there.
if [[ ! -e /var/lib/voidstation ]]; then
  install -d -o root -g root -m 0755 /var/lib/voidstation
fi
[[ -d /var/lib/voidstation && ! -L /var/lib/voidstation ]] || fail '/var/lib/voidstation must be a real directory.'
if [[ -L $status_directory ]] || { [[ -e $status_directory ]] && [[ ! -d $status_directory ]]; }; then
  fail "$status_directory must be a directory, not a link or file."
fi
# Root writes; the Dashboard (UID 1000) only reads through a read-only mount.
install -d -o root -g root -m 0755 "$status_directory"

systemctl daemon-reload
systemctl enable --now voidstation-host-status.timer
systemctl start voidstation-host-status.service

printf '\nWrote %s:\n' "$status_directory/status.json"
ls -l "$status_directory/status.json"
if ! command -v smartctl > /dev/null; then
  printf '\nsmartctl was not found, so drive health is reported as unavailable.\n'
  printf 'To enable it: sudo apt install --no-install-recommends smartmontools && sudo systemctl start voidstation-host-status.service\n'
fi
if [[ ! -x /usr/lib/update-notifier/apt-check ]]; then
  printf '\n/usr/lib/update-notifier/apt-check was not found, so pending updates are reported as unknown.\n'
  printf 'To enable it: sudo apt install update-notifier-common\n'
fi
printf '\nInspect with: systemctl list-timers voidstation-host-status.timer; journalctl -u voidstation-host-status.service\n'
