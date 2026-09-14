#!/usr/bin/env python3
"""Verify Voidstation's dual LAN and Tailscale Docker ingress policy.

The namespace probes are deliberately untrusted-veth probes. They do not pretend to
be a physical LAN client or a Tailscale peer. An owner must perform allowed-path
checks from those physical clients separately.
"""

import argparse
import ipaddress
import json
import os
import re
import secrets
import shlex
import signal
import stat
import subprocess
import sys
import time
from urllib.parse import urlsplit

TEST_NETWORK = ipaddress.IPv4Network("192.0.2.0/30")
DEADLINE_SECONDS = 40
PROCESS_DEADLINE = None


class VerificationError(Exception):
    pass


def fail(message):
    raise VerificationError(message)


def run(argv, description, check=True, timeout=5, respect_deadline=True):
    remaining = PROCESS_DEADLINE - time.monotonic() if PROCESS_DEADLINE else timeout
    if respect_deadline and remaining <= 0:
        fail("Ingress verification timed out.")
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, timeout=min(timeout, remaining) if respect_deadline else timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        fail(f"{description} failed.")
    if check and result.returncode:
        fail(f"{description} failed.")
    return result


def private(address):
    return any(address in network for network in (ipaddress.IPv4Network("10.0.0.0/8"), ipaddress.IPv4Network("172.16.0.0/12"), ipaddress.IPv4Network("192.168.0.0/16")))


def read_config(path, test_config):
    if path != "/etc/voidstation/ingress.json" and not test_config:
        fail("Ingress configuration path is fixed.")
    try:
        if not test_config:
            current = "/"
            for component in path.strip("/").split("/")[:-1]:
                current = os.path.join(current, component)
                details = os.lstat(current)
                if stat.S_ISLNK(details.st_mode) or details.st_uid != 0 or details.st_mode & 0o022:
                    fail("Ingress configuration ancestors are not trusted.")
            details = os.lstat(path)
            if stat.S_ISLNK(details.st_mode) or not stat.S_ISREG(details.st_mode) or details.st_uid != 0 or (details.st_mode & 0o777) != 0o600:
                fail("Ingress configuration must be root-owned, mode 0600, and not a symlink.")
        with open(path, encoding="utf-8") as source:
            config = json.load(source)
    except (OSError, json.JSONDecodeError) as error:
        fail(f"Reading ingress configuration failed: {error}")
    keys = {"lanInterface", "lanSource", "lanAddress", "lanPort", "tailscaleAddress", "tailscalePort"}
    if not isinstance(config, dict) or set(config) != keys:
        fail("Ingress configuration has unexpected fields.")
    try:
        lan_address = ipaddress.IPv4Address(config["lanAddress"])
        lan_source = ipaddress.IPv4Network(config["lanSource"], strict=True)
        tailscale_address = ipaddress.IPv4Address(config["tailscaleAddress"])
    except (ValueError, TypeError):
        fail("Ingress configuration has invalid addresses.")
    if (not isinstance(config["lanInterface"], str) or not config["lanInterface"] or
            str(lan_source) != config["lanSource"] or not private(lan_address) or lan_address not in lan_source or
            not private(lan_source.network_address) or not private(lan_source.broadcast_address) or
            tailscale_address not in ipaddress.IPv4Network("100.64.0.0/10")):
        fail("Ingress configuration has invalid LAN or Tailscale values.")
    for key in ("lanPort", "tailscalePort"):
        if type(config[key]) is not int or not 1 <= config[key] <= 65535:
            fail("Ingress configuration has invalid ports.")
    return config


def parse_origin(value, tailnet=False):
    try:
        parsed = urlsplit(value)
        port = parsed.port or 443
    except ValueError:
        fail("Origin must be a canonical HTTPS origin.")
    host = parsed.hostname
    if parsed.scheme != "https" or not host or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment or not 1 <= port <= 65535:
        fail("Origin must be a canonical HTTPS origin.")
    canonical = f"https://{host}" + ("" if port == 443 else f":{port}")
    if value != canonical or (tailnet and not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.ts\.net", host)):
        fail("Origin must be a canonical HTTPS origin.")
    return host, port


def expected_rules(config):
    return [
        "-A VOIDSTATION -m conntrack --ctstate RELATED,ESTABLISHED --ctdir REPLY -j RETURN",
        "-A VOIDSTATION -i br-voidstation -j RETURN",
        f"-A VOIDSTATION -s 100.64.0.0/10 -i tailscale0 -p tcp -m tcp --dport 3000 -m conntrack --ctstate NEW,ESTABLISHED --ctorigdst {config['tailscaleAddress']} --ctorigdstport {config['tailscalePort']} --ctdir ORIGINAL -j RETURN",
        f"-A VOIDSTATION -s {config['lanSource']} -i {config['lanInterface']} -p tcp -m tcp --dport 3443 -m conntrack --ctstate NEW,ESTABLISHED --ctorigdst {config['lanAddress']} --ctorigdstport {config['lanPort']} --ctdir ORIGINAL -j RETURN",
        "-A VOIDSTATION -j DROP",
    ]


def normalized_tokens(rule):
    tokens = shlex.split(rule)
    if "--ctstate" in tokens:
        index = tokens.index("--ctstate") + 1
        tokens[index] = ",".join(sorted(tokens[index].split(",")))
    return tokens


def verify_policy(config):
    def rules(chain):
        return [line for line in run(["iptables", "-w", "5", "-S", chain], f"Reading {chain} rules").stdout.splitlines() if line.startswith("-A ")]
    forward = rules("FORWARD")
    docker_user = rules("DOCKER-USER")
    voidstation = rules("VOIDSTATION")
    if not forward or forward[0] != "-A FORWARD -j DOCKER-USER":
        fail("DOCKER-USER is not the first FORWARD rule.")
    hook = "-A DOCKER-USER -o br-voidstation -j VOIDSTATION"
    if not docker_user or docker_user[0] != hook:
        fail("VOIDSTATION is not the first DOCKER-USER rule.")
    expected = expected_rules(config)
    if len(voidstation) != len(expected) or any(normalized_tokens(actual) != normalized_tokens(wanted) for actual, wanted in zip(voidstation, expected)):
        fail("VOIDSTATION does not match the audited dual-ingress policy.")


def route_overlaps_test_network():
    try:
        routes = json.loads(run(["ip", "-json", "route", "show", "table", "all"], "Reading routes").stdout)
    except json.JSONDecodeError:
        fail("Reading routes failed.")
    if not isinstance(routes, list):
        fail("Reading routes failed.")
    for route in routes:
        destination = route.get("dst") if isinstance(route, dict) else None
        if not isinstance(destination, str) or destination == "default":
            continue
        try:
            if ipaddress.ip_network(destination, strict=False).overlaps(TEST_NETWORK):
                return True
        except ValueError:
            continue
    return False


def dashboard_ips():
    identifier = run(["docker", "compose", "--project-name", "voidstation-app", "ps", "--quiet", "dashboard"], "Finding dashboard container").stdout.strip()
    worker = run(["docker", "compose", "--project-name", "voidstation-app", "ps", "--quiet", "assistant-worker"], "Finding worker container").stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{12,64}", identifier) or not re.fullmatch(r"[0-9a-f]{12,64}", worker):
        fail("Dashboard and Assistant containers must be uniquely running.")
    def inspect(container, label):
        try:
            networks = json.loads(run(["docker", "inspect", container, "--format", "{{json .NetworkSettings.Networks}}"], f"Inspecting {label}").stdout)
            addresses = [network.get("IPAddress") for network in networks.values() if isinstance(network, dict) and network.get("IPAddress")]
        except json.JSONDecodeError:
            fail(f"Inspecting {label} failed.")
        if len(addresses) != 1:
            fail(f"{label} must have one internal address.")
        return addresses[0]
    return inspect(identifier, "dashboard"), inspect(worker, "Assistant")


def drop_packets():
    output = run(["iptables", "-w", "5", "-nvx", "-L", "VOIDSTATION", "--line-numbers"], "Reading VOIDSTATION counter").stdout
    for line in output.splitlines():
        match = re.match(r"\s*5\s+(\d+)\s+\d+\s+DROP\b", line)
        if match:
            return int(match.group(1))
    fail("VOIDSTATION drop counter is unavailable.")


def raw_drop_packets(address):
    try:
        result = run(["iptables-save", "-c", "-t", "raw"], "Reading Docker direct-container drop", check=False)
    except VerificationError:
        return None
    if result.returncode:
        return None
    expected = f"-A PREROUTING -d {address}/32 ! -i br-voidstation -j DROP"
    matches = [int(match.group(1)) for line in result.stdout.splitlines()
               if (match := re.fullmatch(r"\[(\d+):\d+\] (.+)", line)) and match.group(2) == expected]
    return matches[0] if len(matches) == 1 else None


def curl_arguments(host, port, address, scheme="https"):
    resolve = ["--resolve", f"{host}:{port}:{address}"] if host else []
    url_host = host or address
    return ["curl", "--noproxy", "*", "--connect-timeout", "2", "--max-time", "3", *resolve, "--write-out", "%{http_code}", "--output", "/dev/null", f"{scheme}://{url_host}:{port}/login"]


def check_blocked(namespace, label, command, direct_address=None):
    before = drop_packets()
    raw_before = raw_drop_packets(direct_address) if direct_address else None
    result = run(["ip", "netns", "exec", namespace, *command], "Blocked ingress probe", check=False, timeout=5)
    after = drop_packets()
    raw_after = raw_drop_packets(direct_address) if direct_address else None
    if result.returncode != 28:
        fail(f"{label}: timeout was not proven.")
    if after > before:
        print(f"PASS: {label}: untrusted namespace traffic timed out, VOIDSTATION DROP packets {before} -> {after}.", flush=True)
        return
    if raw_before is not None and raw_after is not None and raw_after > raw_before:
        print(f"PASS: {label}: untrusted namespace traffic timed out, Docker raw direct-container DROP packets {raw_before} -> {raw_after}.", flush=True)
        return
    fail(f"{label}: timeout and a matching DROP counter increase were not both proven.")


def cleanup(namespace, host_veth, namespace_created, veth_created):
    failures = []
    for command, name in ((["ip", "link", "del", "dev", host_veth], host_veth) if veth_created else (None, None), (["ip", "netns", "del", namespace], namespace) if namespace_created else (None, None)):
        if command and run(command, "Removing test network object", check=False, timeout=2, respect_deadline=False).returncode:
            failures.append(name)
    if failures:
        fail("Cleanup failed; inspect only these test objects: " + ", ".join(failures))


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tailscale-origin", required=True)
    parser.add_argument("--lan-origin", required=True)
    parser.add_argument("--config", default="/etc/voidstation/ingress.json")
    parser.add_argument("--test-config", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--report-results", action="store_true")
    return parser.parse_args()


def main():
    global PROCESS_DEADLINE
    PROCESS_DEADLINE = time.monotonic() + DEADLINE_SECONDS
    args = arguments()
    if run(["id", "-u"], "Checking root access").stdout.strip() != "0":
        fail("Run this owner-authorized check as root.")
    config = read_config(args.config, args.test_config)
    tail_host, tail_port = parse_origin(args.tailscale_origin, tailnet=True)
    if tail_port != config["tailscalePort"]:
        fail("Tailscale origin port must match the configured Tailscale port.")
    lan_host, lan_origin_port = parse_origin(args.lan_origin)
    if lan_host != config["lanAddress"] or lan_origin_port != config["lanPort"]:
        fail("LAN origin must be the configured LAN IP and port.")
    verify_policy(config)
    if route_overlaps_test_network():
        fail("Existing route overlaps the reserved test subnet.")
    dashboard, worker = dashboard_ips()
    token = secrets.token_hex(3)
    namespace, host_veth, namespace_veth = f"vs-check-{token}", f"vsch{token}", f"vscn{token}"
    namespace_created = veth_created = False
    try:
        run(["ip", "netns", "add", namespace], "Creating test namespace"); namespace_created = True
        run(["ip", "link", "add", host_veth, "type", "veth", "peer", "name", namespace_veth], "Creating test veth"); veth_created = True
        run(["ip", "link", "set", namespace_veth, "netns", namespace], "Moving test veth")
        run(["ip", "addr", "add", "192.0.2.1/30", "dev", host_veth], "Configuring test veth")
        run(["ip", "link", "set", host_veth, "up"], "Enabling test veth")
        run(["ip", "-n", namespace, "link", "set", "lo", "up"], "Enabling test loopback")
        run(["ip", "-n", namespace, "addr", "add", "192.0.2.2/30", "dev", namespace_veth], "Configuring test namespace")
        run(["ip", "-n", namespace, "link", "set", namespace_veth, "up"], "Enabling test namespace veth")
        run(["ip", "-n", namespace, "route", "add", "default", "via", "192.0.2.1", "dev", namespace_veth], "Configuring test namespace route")
        check_blocked(namespace, "unauthorized-interface-and-source-to-tailscale", curl_arguments(tail_host, tail_port, config["tailscaleAddress"]))
        check_blocked(namespace, "unauthorized-interface-and-source-to-lan", curl_arguments(lan_host, lan_origin_port, config["lanAddress"]))
        check_blocked(namespace, "direct-dashboard-backend", curl_arguments(tail_host, 3000, dashboard), dashboard)
        check_blocked(namespace, "direct-LAN-backend", curl_arguments(lan_host, 3443, dashboard), dashboard)
        check_blocked(namespace, "direct-Assistant-worker", curl_arguments(None, 3001, worker, scheme="http"), worker)
    finally:
        cleanup(namespace, host_veth, namespace_created, veth_created)
    print("PASS: audited dual-ingress rules and untrusted-veth rejections verified. This namespace is not a physical LAN or Tailscale client; the owner must verify allowed LAN and off-LAN Tailscale HTTPS paths separately.")


if __name__ == "__main__":
    signal.signal(signal.SIGINT, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        main()
    except KeyboardInterrupt:
        print("FAIL: ingress verification interrupted.", file=sys.stderr)
        sys.exit(1)
    except VerificationError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
