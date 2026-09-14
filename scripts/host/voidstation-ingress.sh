#!/usr/bin/env bash
set -euo pipefail

config_path=/etc/voidstation/ingress.json
legacy_rule='-A DOCKER-USER ! -i tailscale0 -o br-voidstation -m conntrack --ctstate NEW -j DROP'
hook_rule='-A DOCKER-USER -o br-voidstation -j VOIDSTATION'

fail() {
  printf 'voidstation ingress: %s\n' "$*" >&2
  exit 1
}

usage() {
  fail 'usage: voidstation-ingress [--check|--migrate]'
}

[[ $(id -u) -eq 0 ]] || fail 'must run as root.'
mode=apply
case $# in
  0) ;;
  1) case $1 in --check) mode=check ;; --migrate) mode=migrate ;; *) usage ;; esac ;;
  *) usage ;;
esac

# This parser is embedded so the installed root command does not execute a helper
# from the deployment checkout. It emits only validated scalar values.
if ! config_values="$(python3 - "$config_path" <<'PY'
import ipaddress
import json
import os
import re
import stat
import subprocess
import sys


def reject(message):
    raise ValueError(message)


def private(address):
    return any(address in network for network in (
        ipaddress.IPv4Network("10.0.0.0/8"),
        ipaddress.IPv4Network("172.16.0.0/12"),
        ipaddress.IPv4Network("192.168.0.0/16"),
    ))

try:
    path = sys.argv[1]
    if path != "/etc/voidstation/ingress.json":
        reject("ingress configuration path is fixed")
    current = "/"
    ancestors = [current]
    for component in path.strip("/").split("/")[:-1]:
        current = os.path.join(current, component)
        ancestors.append(current)
    for ancestor in ancestors:
        details = os.lstat(ancestor)
        if stat.S_ISLNK(details.st_mode) or details.st_uid != 0 or details.st_mode & 0o022:
            reject("configuration ancestors must be root-owned and not writable by group or others")
    details = os.lstat(path)
    if stat.S_ISLNK(details.st_mode) or not stat.S_ISREG(details.st_mode) or details.st_uid != 0 or (details.st_mode & 0o777) != 0o600:
        reject("configuration must be a root-owned non-symlink regular file with mode 0600")
    with open(path, encoding="utf-8") as source:
        config = json.load(source)
    keys = {"lanInterface", "lanSource", "lanAddress", "lanPort", "tailscaleAddress", "tailscalePort"}
    if not isinstance(config, dict) or set(config) != keys:
        reject("configuration must contain exactly lanInterface, lanSource, lanAddress, lanPort, tailscaleAddress, tailscalePort")
    interface = config["lanInterface"]
    if not isinstance(interface, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,15}", interface) or interface in {"lo", "tailscale0"}:
        reject("lanInterface is invalid")
    lan_address = ipaddress.IPv4Address(config["lanAddress"])
    lan_source = ipaddress.IPv4Network(config["lanSource"], strict=True)
    if str(lan_source) != config["lanSource"] or not private(lan_address) or not lan_address in lan_source or not private(lan_source.network_address) or not private(lan_source.broadcast_address):
        reject("LAN address and source must be canonical RFC1918 values on the same network")
    tailscale_address = ipaddress.IPv4Address(config["tailscaleAddress"])
    if tailscale_address not in ipaddress.IPv4Network("100.64.0.0/10"):
        reject("tailscaleAddress must be in 100.64.0.0/10")
    for name in ("lanPort", "tailscalePort"):
        value = config[name]
        if type(value) is not int or not 1 <= value <= 65535:
            reject(f"{name} must be a TCP port")
    try:
        links = json.loads(subprocess.run(["ip", "-details", "-j", "link", "show", "dev", interface], check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout)
        addresses = json.loads(subprocess.run(["ip", "-j", "-4", "addr", "show", "dev", interface], check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout)
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError):
        reject("lanInterface cannot be inspected")
    if len(links) != 1 or len(addresses) != 1:
        reject("lanInterface does not identify one real interface")
    link = links[0]
    kind = link.get("linkinfo", {}).get("info_kind")
    forbidden = {"bridge", "veth", "tun", "tap", "wireguard", "vxlan", "gre", "gretap", "ipip", "sit", "dummy", "ifb"}
    if link.get("link_type") == "loopback" or "LOOPBACK" in link.get("flags", []) or kind in forbidden:
        reject("lanInterface must not be a loopback, tunnel, or bridge")
    assigned = {item.get("local") for item in addresses[0].get("addr_info", []) if item.get("family") == "inet"}
    if str(lan_address) not in assigned:
        reject("lanAddress is not assigned to lanInterface")
    print(interface)
    print(lan_source)
    print(lan_address)
    print(config["lanPort"])
    print(tailscale_address)
    print(config["tailscalePort"])
except (ValueError, KeyError, TypeError, ipaddress.AddressValueError, json.JSONDecodeError, OSError) as error:
    print(f"invalid ingress configuration: {error}", file=sys.stderr)
    sys.exit(1)
PY
)"; then
  fail 'could not validate /etc/voidstation/ingress.json.'
fi
mapfile -t values <<<"$config_values"
((${#values[@]} == 6)) || fail 'could not validate /etc/voidstation/ingress.json.'
lan_interface=${values[0]}
lan_source=${values[1]}
lan_address=${values[2]}
lan_port=${values[3]}
tailscale_address=${values[4]}
tailscale_port=${values[5]}

expected_rules=(
  '-A VOIDSTATION -m conntrack --ctstate RELATED,ESTABLISHED --ctdir REPLY -j RETURN'
  '-A VOIDSTATION -i br-voidstation -j RETURN'
  "-A VOIDSTATION -s 100.64.0.0/10 -i tailscale0 -p tcp -m tcp --dport 3000 -m conntrack --ctstate NEW,ESTABLISHED --ctorigdst $tailscale_address --ctorigdstport $tailscale_port --ctdir ORIGINAL -j RETURN"
  "-A VOIDSTATION -s $lan_source -i $lan_interface -p tcp -m tcp --dport 3443 -m conntrack --ctstate NEW,ESTABLISHED --ctorigdst $lan_address --ctorigdstport $lan_port --ctdir ORIGINAL -j RETURN"
  '-A VOIDSTATION -j DROP'
)

# iptables -S can reorder conntrack states. Everything else remains exact.
rules_equal() {
  python3 - "$1" "$2" <<'PY'
import shlex
import sys

def normalize(rule):
    tokens = shlex.split(rule)
    try:
        state = tokens.index("--ctstate") + 1
    except ValueError:
        return tokens
    tokens[state] = ",".join(sorted(tokens[state].split(",")))
    return tokens

sys.exit(0 if normalize(sys.argv[1]) == normalize(sys.argv[2]) else 1)
PY
}

chain_matches() {
  local actual=() index
  mapfile -t actual < <(printf '%s\n' "$1" | grep '^-A VOIDSTATION ' || true)
  ((${#actual[@]} == ${#expected_rules[@]})) || return 1
  for index in "${!expected_rules[@]}"; do
    rules_equal "${actual[$index]}" "${expected_rules[$index]}" || return 1
  done
}

if docker_user_rules="$(iptables -w -S DOCKER-USER 2>/dev/null)"; then
  docker_user_exists=yes
else
  docker_user_exists=no
  docker_user_rules=''
fi
forward_rules="$(iptables -w -S FORWARD)" || fail 'could not read the FORWARD chain.'
if voidstation_rules="$(iptables -w -S VOIDSTATION 2>/dev/null)"; then
  voidstation_exists=yes
  chain_matches "$voidstation_rules" || fail 'the existing VOIDSTATION chain differs from the audited policy; refusing to overwrite it.'
else
  voidstation_exists=no
fi

mapfile -t forward_appends < <(printf '%s\n' "$forward_rules" | grep '^-A FORWARD ' || true)
docker_user_jumps=()
for rule in "${forward_appends[@]}"; do
  [[ $rule =~ (^|[[:space:]])-j[[:space:]]+DOCKER-USER([[:space:]]|$) ]] && docker_user_jumps+=("$rule")
done
if ((${#docker_user_jumps[@]})); then
  ((${#docker_user_jumps[@]} == 1)) && [[ ${forward_appends[0]:-} == '-A FORWARD -j DOCKER-USER' ]] || fail 'the existing DOCKER-USER jump is not the first FORWARD rule; refusing to reorder firewall rules.'
  forward_missing=no
else
  forward_missing=yes
fi

mapfile -t docker_user_appends < <(printf '%s\n' "$docker_user_rules" | grep '^-A DOCKER-USER ' || true)
hooks=()
legacy=()
voidstation_references=()
for rule in "${docker_user_appends[@]}"; do
  [[ $rule == "$hook_rule" ]] && hooks+=("$rule")
  [[ $rule == "$legacy_rule" ]] && legacy+=("$rule")
  [[ $rule =~ (^|[[:space:]])-j[[:space:]]+VOIDSTATION([[:space:]]|$) ]] && voidstation_references+=("$rule")
done
if ((${#voidstation_references[@]} != ${#hooks[@]})) || ((${#hooks[@]} > 1)); then
  fail 'an unexpected DOCKER-USER reference to VOIDSTATION exists; refusing to alter firewall rules.'
fi
if ((${#hooks[@]} == 1)) && [[ ${docker_user_appends[0]:-} != "$hook_rule" ]]; then
  fail 'the VOIDSTATION hook is not the first DOCKER-USER rule; refusing to reorder firewall rules.'
fi
if ((${#legacy[@]})); then
  [[ $mode == migrate && ${#legacy[@]} == 1 ]] || fail 'the legacy broad ingress rule is present; rerun with --migrate after owner authorization.'
fi
hook_missing=$(( ${#hooks[@]} == 0 ? 1 : 0 ))

if [[ $mode == check ]]; then
  [[ $docker_user_exists == yes && $voidstation_exists == yes && $forward_missing == no && $hook_missing == 0 && ${#legacy[@]} == 0 ]] || fail 'the expected ingress policy is not loaded.'
  printf 'Voidstation ingress policy is loaded.\n'
  exit 0
fi

# Build the terminal policy before connecting it to Docker forwarding.
if [[ $voidstation_exists == no ]]; then
  iptables -w -N VOIDSTATION || fail 'could not create the VOIDSTATION chain.'
  for rule in "${expected_rules[@]}"; do
    read -r -a arguments <<<"${rule#-A VOIDSTATION }"
    iptables -w -A VOIDSTATION "${arguments[@]}" || fail 'could not add a VOIDSTATION rule.'
  done
fi
if [[ $docker_user_exists == no ]]; then
  iptables -w -N DOCKER-USER || fail 'DOCKER-USER is unavailable and could not be created.'
fi
if ((hook_missing)); then
  iptables -w -I DOCKER-USER 1 -o br-voidstation -j VOIDSTATION || fail 'could not hook VOIDSTATION into DOCKER-USER.'
fi
# The new hook is now first and restrictive. Removing this exact known legacy
# rule cannot open a forwarding window.
if ((${#legacy[@]})); then
  iptables -w -D DOCKER-USER ! -i tailscale0 -o br-voidstation -m conntrack --ctstate NEW -j DROP || fail 'could not remove the legacy ingress rule.'
fi
if [[ $forward_missing == yes ]]; then
  iptables -w -I FORWARD 1 -j DOCKER-USER || fail 'could not hook DOCKER-USER into FORWARD.'
fi

printf 'Voidstation ingress policy is loaded.\n'
