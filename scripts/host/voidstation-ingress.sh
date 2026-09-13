#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'voidstation ingress: %s\n' "$*" >&2
  exit 1
}

[[ $(id -u) -eq 0 ]] || fail 'must run as root.'
(($# == 0)) || fail 'usage: voidstation-ingress'

if ! docker_user_rules="$(iptables -w -S DOCKER-USER 2>/dev/null)"; then
  iptables -w -N DOCKER-USER || fail 'DOCKER-USER is unavailable and could not be created.'
  docker_user_rules='-N DOCKER-USER'
fi

forward_rules="$(iptables -w -S FORWARD)" || fail 'could not read the FORWARD chain.'
mapfile -t forward_appends < <(printf '%s\n' "$forward_rules" | grep '^-A FORWARD ' || true)
docker_user_jumps=()
for rule in "${forward_appends[@]}"; do
  if [[ $rule =~ (^|[[:space:]])-j[[:space:]]+DOCKER-USER([[:space:]]|$) ]]; then
    docker_user_jumps+=("$rule")
  fi
done

if ((${#docker_user_jumps[@]} == 0)); then
  iptables -w -I FORWARD 1 -j DOCKER-USER
elif ((${#docker_user_jumps[@]} != 1)) || [[ ${forward_appends[0]:-} != '-A FORWARD -j DOCKER-USER' ]]; then
  fail 'the existing DOCKER-USER jump is not the first FORWARD rule; refusing to reorder firewall rules.'
fi

drop_rule='-A DOCKER-USER ! -i tailscale0 -o br-voidstation -m conntrack --ctstate NEW -j DROP'
mapfile -t docker_user_appends < <(printf '%s\n' "$docker_user_rules" | grep '^-A DOCKER-USER ' || true)
drop_matches=()
for rule in "${docker_user_appends[@]}"; do
  [[ $rule == "$drop_rule" ]] && drop_matches+=("$rule")
done

if ((${#drop_matches[@]} == 0)); then
  iptables -w -I DOCKER-USER 1 ! -i tailscale0 -o br-voidstation -m conntrack --ctstate NEW -j DROP
elif ((${#drop_matches[@]} != 1)) || [[ ${docker_user_appends[0]:-} != "$drop_rule" ]]; then
  fail 'the Voidstation ingress drop rule is present but is not first; refusing to reorder firewall rules.'
fi

printf 'Voidstation ingress policy is loaded.\n'
