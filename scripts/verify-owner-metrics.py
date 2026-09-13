#!/usr/bin/env python3
"""Log in as the production owner, run the HTTPS metrics smoke check, and log out.

The password is read only from the controlling terminal. The session stays in
memory and is passed to docker-smoke.py without being printed or persisted.
"""

import argparse
import getpass
import http.cookiejar
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import warnings


class VerificationError(RuntimeError):
    """A diagnostic that is safe to show without exposing credentials."""


def validate_origin(origin):
    try:
        parsed = urllib.parse.urlsplit(origin)
        port = parsed.port or 443
    except ValueError as error:
        raise VerificationError("origin must be a canonical HTTPS Tailscale origin") from error
    host = parsed.hostname
    canonical = f"https://{host}" + ("" if port == 443 else f":{port}")
    if (parsed.scheme != "https" or not host or not host.endswith(".ts.net") or
            parsed.username is not None or parsed.password is not None or
            parsed.path or parsed.query or parsed.fragment or origin != canonical):
        raise VerificationError("origin must be a canonical HTTPS Tailscale origin")
    try:
        result = subprocess.run(["tailscale", "status", "--json"], capture_output=True,
                                text=True, check=True, timeout=5)
        status = json.loads(result.stdout)
        if (status.get("BackendState") != "Running" or
                status["Self"]["DNSName"].rstrip(".").lower() != host):
            raise VerificationError("origin must match this Server's running Tailscale hostname")
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise VerificationError("could not verify this Server's Tailscale identity") from error


def read_password():
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            return getpass.getpass("Production owner password: ")
    except getpass.GetPassWarning as error:
        raise VerificationError(
            "could not securely read the password from the controlling terminal; "
            "run the wizard from an interactive terminal"
        ) from error
    except (EOFError, KeyboardInterrupt) as error:
        raise VerificationError("password entry was cancelled") from error


def login(client, origin, password):
    request = urllib.request.Request(
        origin.rstrip("/") + "/api/auth/login",
        data=urllib.parse.urlencode({"password": password}).encode(),
        headers={"Origin": origin, "Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with client.open(request, timeout=10) as response:
            if response.status != 200:
                raise VerificationError(f"login returned HTTP {response.status}")
    except urllib.error.HTTPError as error:
        raise VerificationError(f"login returned HTTP {error.code}") from error
    except urllib.error.URLError as error:
        raise VerificationError("could not reach the HTTPS login endpoint") from error


def session_cookie(jar):
    cookies = [
        cookie for cookie in jar
        if cookie.name == "__Host-voidstation-session" and cookie.secure
    ]
    if len(cookies) != 1:
        raise VerificationError("login did not issue exactly one secure owner session cookie")
    return cookies[0]


def logout(client, origin):
    request = urllib.request.Request(
        origin.rstrip("/") + "/api/auth/logout",
        data=b"",
        headers={"Origin": origin},
        method="POST",
    )
    try:
        with client.open(request, timeout=10) as response:
            if response.status != 200:
                raise VerificationError(f"logout returned HTTP {response.status}")
    except urllib.error.HTTPError as error:
        raise VerificationError(f"logout returned HTTP {error.code}") from error
    except urllib.error.URLError as error:
        raise VerificationError("could not reach the HTTPS logout endpoint") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin", help="HTTPS Tailscale origin")
    parser.add_argument("root", help="Root filesystem probe directory")
    parser.add_argument("data", help="Separate data filesystem probe directory")
    args = parser.parse_args()
    try:
        validate_origin(args.origin)
    except VerificationError as error:
        parser.error(str(error))

    jar = http.cookiejar.CookieJar()
    client = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar)
    )
    logged_in = False
    result = 1
    phase = "password entry"
    try:
        password = read_password()
        phase = "HTTPS login"
        login(client, args.origin, password)
        password = None
        logged_in = True
        phase = "session cookie validation"
        cookie = session_cookie(jar)
        phase = "metrics comparison"
        completed = subprocess.run(
            ["python3", "scripts/docker-smoke.py", args.origin, args.root, args.data],
            env={**os.environ, "VOIDSTATION_SMOKE_COOKIE": cookie.name + "=" + cookie.value},
            timeout=30,
        )
        result = completed.returncode
    except subprocess.TimeoutExpired:
        print("Authenticated smoke check failed: metrics comparison exceeded 30 seconds.", file=sys.stderr)
    except VerificationError as error:
        print(f"Authenticated smoke check failed: {error}. No credentials were recorded.", file=sys.stderr)
    except Exception as error:
        print(f"Authenticated smoke check failed during {phase} ({type(error).__name__}). No credentials were recorded.", file=sys.stderr)
    finally:
        if logged_in:
            try:
                logout(client, args.origin)
            except VerificationError as error:
                print(f"Smoke-check logout failed: {error}. Recover the owner account if session invalidation is required.", file=sys.stderr)
                result = 1
            except Exception as error:
                print(f"Smoke-check logout failed ({type(error).__name__}). Session invalidation was not confirmed.", file=sys.stderr)
                result = 1
        jar.clear()
    return result


if __name__ == "__main__":
    raise SystemExit(main())
