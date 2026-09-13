#!/usr/bin/env python3
"""Verify Docker's ingress drop with an isolated RFC 5737 TEST-NET-1 veth namespace.

This creates only a short-lived namespace, its veth pair and connected subnet. It
does not alter existing routes, forwarding settings, firewall rules, Docker or UFW.
"""

import argparse
import ipaddress
import json
import re
import secrets
import signal
import subprocess
import sys
import time
from urllib.parse import urlsplit

EXPECTED_RULE = "-A DOCKER-USER ! -i tailscale0 -o br-voidstation -m conntrack --ctstate NEW -j DROP"
TEST_NETWORK = ipaddress.IPv4Network("192.0.2.0/30")
DEADLINE_SECONDS = 30
PROCESS_DEADLINE = None


class VerificationError(Exception):
    pass


def fail(message):
    raise VerificationError(message)


def run(argv, description, check=True, timeout=5, respect_deadline=True):
    remaining = PROCESS_DEADLINE - time.monotonic() if PROCESS_DEADLINE else timeout
    if respect_deadline and remaining <= 0:
        fail("Ingress verification timed out.")
    command_timeout = min(timeout, remaining) if respect_deadline else timeout
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, timeout=command_timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        fail(f"{description} failed.")
    if check and result.returncode:
        fail(f"{description} failed.")
    return result


def parse_origin(value):
    try:
        parsed = urlsplit(value)
        port = parsed.port or 443
    except ValueError:
        fail("Origin must be a canonical HTTPS Tailscale origin.")
    host = parsed.hostname
    if (parsed.scheme != "https" or not host or parsed.username or parsed.password or
            parsed.path or parsed.query or parsed.fragment or port < 1 or port > 65535 or
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.ts\.net", host)):
        fail("Origin must be a canonical HTTPS Tailscale origin.")
    canonical = f"https://{host}" + ("" if port == 443 else f":{port}")
    if value != canonical:
        fail("Origin must be a canonical HTTPS Tailscale origin.")
    return host, port


def parse_address(value, network, description):
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        fail(f"{description} must be an IPv4 address in its required range.")
    if network and address not in network:
        fail(f"{description} must be an IPv4 address in its required range.")
    return address


def parse_container_address(value):
    address = parse_address(value, None, "Container address")
    private_ranges = (ipaddress.IPv4Network("10.0.0.0/8"), ipaddress.IPv4Network("172.16.0.0/12"),
                      ipaddress.IPv4Network("192.168.0.0/16"))
    if not any(address in network for network in private_ranges):
        fail("Container address must be RFC1918.")
    return address


def route_overlaps_test_network():
    try:
        routes = json.loads(run(["ip", "-json", "route", "show", "table", "all"], "Reading routes").stdout)
    except json.JSONDecodeError:
        fail("Reading routes failed.")
    if not isinstance(routes, list):
        fail("Reading routes failed.")
    for route in routes:
        if not isinstance(route, dict):
            continue
        destination = route.get("dst")
        # A default route does not reserve TEST-NET-1. The connected /30 added
        # below takes precedence; any explicit destination route would conflict.
        if not isinstance(destination, str) or destination == "default":
            continue
        try:
            existing = ipaddress.ip_network(destination, strict=False)
        except ValueError:
            continue
        if existing.version == 4 and existing.overlaps(TEST_NETWORK):
            return True
    return False


def dashboard_has_container_ip(container_ip):
    result = run(["docker", "compose", "--project-name", "voidstation-app", "ps", "--quiet", "dashboard"],
                 "Finding dashboard container")
    container_id = result.stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{12,64}", container_id):
        fail("Dashboard container is not uniquely running.")
    inspection = run(["docker", "inspect", container_id, "--format", "{{json .NetworkSettings.Networks}}"],
                     "Inspecting dashboard container")
    try:
        networks = json.loads(inspection.stdout)
    except json.JSONDecodeError:
        fail("Inspecting dashboard container failed.")
    if not isinstance(networks, dict) or not any(
            isinstance(network, dict) and network.get("IPAddress") == str(container_ip)
            for network in networks.values()):
        fail("Container address does not belong to the dashboard.")


def first_rule_is_expected():
    rules = run(["iptables", "-w", "5", "-S", "DOCKER-USER"], "Reading Docker ingress rule").stdout.splitlines()
    appended = [line for line in rules if line.startswith("-A ")]
    if not appended or appended[0] != EXPECTED_RULE:
        fail("Docker ingress rule is not the first DOCKER-USER rule.")


def rule_packets():
    output = run(["iptables", "-w", "5", "-nvx", "-L", "DOCKER-USER", "--line-numbers"],
                 "Reading Docker ingress counter").stdout
    for line in output.splitlines():
        match = re.match(r"\s*1\s+(\d+)\s+\d+\s+\S+", line)
        if match:
            return int(match.group(1))
    fail("Docker ingress counter is unavailable.")


def curl_arguments(host, port, address):
    return ["curl", "--noproxy", "*", "--connect-timeout", "2", "--max-time", "3",
            "--resolve", f"{host}:{port}:{address}", "--write-out", "%{http_code}",
            "--output", "/dev/null", f"https://{host}:{port}/login"]


def check_readiness(host, port, tailscale_ip):
    result = run(curl_arguments(host, port, tailscale_ip), "TLS login readiness", check=False, timeout=5)
    if result.returncode != 0 or result.stdout.strip() != "200":
        fail("TLS login readiness failed.")


def check_blocked(namespace, host, port, address):
    before = rule_packets()
    result = run(["ip", "netns", "exec", namespace, *curl_arguments(host, port, address)],
                 "Blocked ingress probe", check=False, timeout=5)
    after = rule_packets()
    if result.returncode != 28:
        fail("Blocked ingress probe did not time out.")
    if after <= before:
        fail("Docker ingress counter did not increase.")
    return after


def cleanup(namespace, host_veth, namespace_created, veth_created):
    commands = []
    if veth_created:
        commands.append((["ip", "link", "del", "dev", host_veth], host_veth))
    if namespace_created:
        commands.append((["ip", "netns", "del", namespace], namespace))
    failures = []
    for command, name in commands:
        try:
            result = run(command, "Removing test network object", check=False,
                         timeout=2, respect_deadline=False)
            if result.returncode:
                failures.append(name)
        except VerificationError:
            failures.append(name)
    if failures:
        fail("Cleanup failed; inspect only these test objects: " + ", ".join(failures))


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--tailscale-ip", required=True)
    parser.add_argument("--container-ip", required=True)
    parser.add_argument("--report-results", action="store_true")
    return parser.parse_args()


def main():
    global PROCESS_DEADLINE
    PROCESS_DEADLINE = time.monotonic() + DEADLINE_SECONDS
    args = arguments()
    if run(["id", "-u"], "Checking root access").stdout.strip() != "0":
        fail("Run this owner-authorized check as root.")
    host, port = parse_origin(args.origin)
    tailscale_ip = parse_address(args.tailscale_ip, ipaddress.IPv4Network("100.64.0.0/10"), "Tailscale address")
    container_ip = parse_container_address(args.container_ip)
    dashboard_has_container_ip(container_ip)
    first_rule_is_expected()
    check_readiness(host, port, tailscale_ip)
    if route_overlaps_test_network():
        fail("Existing route overlaps the reserved test subnet.")

    token = secrets.token_hex(3)
    namespace, host_veth, namespace_veth = f"vs-check-{token}", f"vsch{token}", f"vscn{token}"
    namespace_created = veth_created = False
    try:
        run(["ip", "netns", "add", namespace], "Creating test namespace")
        namespace_created = True
        run(["ip", "link", "add", host_veth, "type", "veth", "peer", "name", namespace_veth], "Creating test veth")
        veth_created = True
        run(["ip", "link", "set", namespace_veth, "netns", namespace], "Moving test veth")
        run(["ip", "addr", "add", "192.0.2.1/30", "dev", host_veth], "Configuring test veth")
        run(["ip", "link", "set", host_veth, "up"], "Enabling test veth")
        run(["ip", "-n", namespace, "link", "set", "lo", "up"], "Enabling test loopback")
        run(["ip", "-n", namespace, "addr", "add", "192.0.2.2/30", "dev", namespace_veth], "Configuring test namespace")
        run(["ip", "-n", namespace, "link", "set", namespace_veth, "up"], "Enabling test namespace veth")
        run(["ip", "-n", namespace, "route", "add", "default", "via", "192.0.2.1", "dev", namespace_veth], "Configuring test namespace route")
        check_blocked(namespace, host, port, tailscale_ip)
        container_packets = check_blocked(namespace, host, 3000, container_ip)
    finally:
        cleanup(namespace, host_veth, namespace_created, veth_created)
    if args.report_results:
        print(f"PASS: readiness=200, tailscale-blocked=yes, container-blocked=yes, rule-packets={container_packets}; owner must still check desktop/off-LAN access.")
    else:
        print("PASS: local readiness and blocked traffic verified; owner must still check desktop/off-LAN access.")


def interrupt(_signal, _frame):
    raise KeyboardInterrupt


if __name__ == "__main__":
    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGTERM, interrupt)
    try:
        main()
    except KeyboardInterrupt:
        print("FAIL: ingress verification interrupted.", file=sys.stderr)
        sys.exit(1)
    except VerificationError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
