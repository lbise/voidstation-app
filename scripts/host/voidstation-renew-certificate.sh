#!/usr/bin/env bash
set -euo pipefail
umask 077

hostname_file="${VOIDSTATION_HOSTNAME_FILE:-/etc/voidstation/hostname}"
tls_directory="${VOIDSTATION_TLS_DIRECTORY:-/var/lib/voidstation/tls}"
certificate="$tls_directory/cert.pem"
private_key="$tls_directory/key.pem"
restart_pending="$tls_directory/.restart-pending"

fail() {
  printf 'voidstation certificate: %s\n' "$*" >&2
  exit 1
}

[[ $(id -u) -eq 0 ]] || fail 'must run as root.'

valid_hostname() {
  local value=$1
  [[ ${#value} -le 253 ]] &&
    [[ $value == *.ts.net ]] &&
    [[ $value == "${value,,}" ]] &&
    [[ $value =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$ ]]
}

config_hostname() {
  local directory mode
  directory=$(dirname "$hostname_file")
  [[ -d $directory && ! -L $directory ]] || fail "hostname configuration directory is unsafe: $directory"
  [[ $(stat -c %u "$directory") == 0 ]] || fail 'hostname configuration directory must be owned by root.'
  mode=$(stat -c %a "$directory")
  [[ $mode =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 8#022) == 0 )) || fail 'hostname configuration directory must not be group- or world-writable.'
  [[ -f $hostname_file && ! -L $hostname_file ]] || fail "hostname configuration is missing: $hostname_file"
  [[ $(stat -c %u "$hostname_file") == 0 ]] || fail 'hostname configuration must be owned by root.'
  mode=$(stat -c %a "$hostname_file")
  [[ $mode =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 8#022) == 0 )) || fail 'hostname configuration must not be group- or world-writable.'
  mapfile -t hostname_lines < "$hostname_file"
  ((${#hostname_lines[@]} == 1)) || fail 'hostname configuration must contain exactly one hostname.'
  valid_hostname "${hostname_lines[0]}" || fail 'hostname configuration must be a lowercase .ts.net DNS name.'
  printf '%s\n' "${hostname_lines[0]}"
}

write_hostname() {
  local value=$1 directory temporary
  valid_hostname "$value" || fail 'provisioned hostname must be a lowercase .ts.net DNS name.'
  directory=$(dirname "$hostname_file")
  if [[ -e $directory && ( ! -d $directory || -L $directory ) ]]; then
    fail "hostname configuration directory is unsafe: $directory"
  fi
  install -d -o 0 -g 0 -m 0755 "$directory"
  [[ $(stat -c %u "$directory") == 0 ]] || fail 'hostname configuration directory must be owned by root.'
  temporary=$(mktemp "$directory/.hostname.XXXXXX")
  printf '%s\n' "$value" > "$temporary"
  chown 0:0 "$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$hostname_file"
}

ensure_tls_directory() {
  if [[ -e $tls_directory && ( ! -d $tls_directory || -L $tls_directory ) ]]; then
    fail "TLS directory is unsafe: $tls_directory"
  fi
  install -d -o 0 -g 1000 -m 0750 "$tls_directory"
  [[ ! -L $tls_directory ]] || fail 'TLS directory must not be a symbolic link.'
  [[ $(stat -c %u "$tls_directory") == 0 ]] || fail 'TLS directory must be owned by root.'
  local mode
  mode=$(stat -c %a "$tls_directory")
  [[ $mode =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 8#022) == 0 )) || fail 'TLS directory must not be group- or world-writable.'
}

certificate_matches() {
  local candidate_cert=$1 candidate_key=$2 hostname=$3 san certificate_public_key private_public_key
  san=$(openssl x509 -in "$candidate_cert" -noout -ext subjectAltName) || return 1
  san="${san//[[:space:]]/}"
  [[ ",$san," == *"DNS:$hostname,"* ]] || return 1
  openssl x509 -in "$candidate_cert" -noout -checkend 0 || return 1
  certificate_public_key=$(openssl x509 -in "$candidate_cert" -noout -pubkey) || return 1
  private_public_key=$(openssl pkey -in "$candidate_key" -pubout) || return 1
  [[ -n $certificate_public_key && $certificate_public_key == "$private_public_key" ]]
}

select_restart_target() {
  local output
  output=$(docker ps --quiet \
    --filter label=com.docker.compose.project=voidstation-app \
    --filter label=com.docker.compose.service=dashboard) || fail 'could not list the dashboard container.'
  mapfile -t dashboard_containers < <(printf '%s\n' "$output" | grep -v '^$' || true)
  ((${#dashboard_containers[@]} <= 1)) || fail 'more than one running Voidstation dashboard container exists; certificate was not replaced.'
}

restart_selected_dashboard() {
  if ((${#dashboard_containers[@]} == 1)); then
    docker restart "${dashboard_containers[0]}" || fail 'certificate is installed but its dashboard restart remains pending.'
    rm -f -- "$restart_pending"
  else
    printf 'Certificate restart remains pending until the Dashboard is running.\n'
  fi
}

# Serialize the timer and an owner-initiated provision/renewal so their paired
# certificate/key replacements cannot interleave.
ensure_tls_directory
exec 9>"$tls_directory/.renew.lock"
flock -w 30 9 || fail 'another certificate operation is still running.'

provisioning=false
case "${1:-}" in
  '')
    (($# == 0)) || fail 'usage: voidstation-renew-certificate [--provision HOSTNAME]'
    hostname=$(config_hostname)
    if [[ -e $restart_pending && -f $certificate && -f $private_key ]] &&
        certificate_matches "$certificate" "$private_key" "$hostname" >/dev/null 2>&1; then
      select_restart_target
      restart_selected_dashboard
    fi
    if [[ -f $certificate && -f $private_key ]] &&
        openssl x509 -in "$certificate" -noout -checkend 2592000 >/dev/null 2>&1 &&
        certificate_matches "$certificate" "$private_key" "$hostname" >/dev/null 2>&1; then
      printf 'Voidstation certificate remains valid for more than 30 days.\n'
      exit 0
    fi
    ;;
  --provision)
    provisioning=true
    (($# == 2)) || fail 'usage: voidstation-renew-certificate --provision HOSTNAME'
    write_hostname "$2"
    hostname=$2
    ;;
  *)
    fail 'usage: voidstation-renew-certificate [--provision HOSTNAME]'
    ;;
esac

temporary_directory=$(mktemp -d "$tls_directory/.renew.XXXXXX")
trap 'rm -rf -- "$temporary_directory"' EXIT
candidate_certificate="$temporary_directory/cert.pem"
candidate_key="$temporary_directory/key.pem"
tailscale cert --min-validity=720h --cert-file="$candidate_certificate" --key-file="$candidate_key" "$hostname" || fail 'Tailscale did not issue a certificate.'
certificate_matches "$candidate_certificate" "$candidate_key" "$hostname" || fail 'Tailscale returned a certificate with the wrong name, expiry, or key.'
openssl x509 -in "$candidate_certificate" -noout -checkend 2592000 || fail 'replacement certificate expires within 30 days.'

# Provisioning precedes the separately authorized live cutover. It must not
# restart an existing legacy Dashboard before the owner reaches that step.
dashboard_containers=()
if [[ $provisioning == false ]]; then
  select_restart_target
fi

new_certificate="$temporary_directory/install-cert.pem"
new_key="$temporary_directory/install-key.pem"
install -o 1000 -g 1000 -m 0644 "$candidate_certificate" "$new_certificate"
install -o 1000 -g 1000 -m 0600 "$candidate_key" "$new_key"
if [[ $provisioning == false ]]; then
  # Record the obligation before replacement, so interruption cannot make new
  # files look healthy while the process still serves the old certificate.
  printf 'pending\n' > "$temporary_directory/restart-pending"
  mv -f -- "$temporary_directory/restart-pending" "$restart_pending"
fi
mv -f -- "$new_certificate" "$certificate"
mv -f -- "$new_key" "$private_key"

if [[ $provisioning == false ]]; then
  restart_selected_dashboard
fi
printf 'Voidstation certificate installed.\n'
