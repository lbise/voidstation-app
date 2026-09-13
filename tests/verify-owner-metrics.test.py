#!/usr/bin/env python3
"""Focused public-CLI regression check for scripts/verify-owner-metrics.py."""

import json
import os
import pty
import select
import ssl
import subprocess
import sys
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs


PASSWORD = "synthetic-owner-password"
COOKIE = "synthetic-owner-session"
HOSTNAME = "dashboard.test-tailnet.ts.net"


class State:
    login_requests = 0
    metric_requests = 0
    logout_requests = 0
    bad_cookie = False
    reject_login = False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", "0")))

    def respond(self, status, headers=(), body=b""):
        self.send_response(status)
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self.body()
        if self.path == "/api/auth/login":
            State.login_requests += 1
            if State.reject_login or parse_qs(body.decode()).get("password") != [PASSWORD]:
                self.respond(401)
                return
            self.respond(200, [("Set-Cookie", "__Host-voidstation-session=" + COOKIE + "; Secure; HttpOnly; Path=/; Max-Age=60")])
            return
        if self.path == "/api/auth/logout":
            State.logout_requests += 1
            State.bad_cookie |= self.headers.get("Cookie") != "__Host-voidstation-session=" + COOKIE
            self.respond(200)
            return
        self.respond(404)

    def do_GET(self):
        if self.path != "/api/metrics":
            self.respond(404)
            return
        State.metric_requests += 1
        State.bad_cookie |= self.headers.get("Cookie") != "__Host-voidstation-session=" + COOKIE
        unavailable = {"status": "unavailable", "value": None, "unit": "bytes", "observedAt": None}
        metrics = {
            "cpu": {**unavailable, "unit": "percent"},
            "uptime": {**unavailable, "unit": "seconds"},
            "ram": unavailable,
            "rootFilesystem": unavailable,
            "dataFilesystem": unavailable,
        }
        self.respond(200, [("Cache-Control", "no-store"), ("Content-Type", "application/json")], json.dumps(metrics).encode())


def run_with_tty(command, env):
    master, slave = pty.openpty()

    def control_tty():
        os.setsid()
        import fcntl
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

    child = subprocess.Popen(command, stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env=env, text=True, preexec_fn=control_tty)
    os.close(slave)
    prompt = b""
    deadline = time.monotonic() + 10
    while b"Production owner password: " not in prompt and time.monotonic() < deadline:
        if select.select([master], [], [], .1)[0]:
            prompt += os.read(master, 4096)
    if b"Production owner password: " not in prompt:
        child.kill()
        raise AssertionError("owner-password prompt was not sent to the controlling terminal")
    os.write(master, (PASSWORD + "\n").encode())
    code = child.wait(timeout=20)
    stdout, stderr = child.communicate()
    os.close(master)
    return code, stdout, stderr


def main():
    repo = Path(__file__).resolve().parents[1]
    if not Path("/dev/shm").is_dir():
        raise SystemExit("SKIP: /dev/shm is required as a distinct data filesystem")
    with tempfile.TemporaryDirectory(prefix="voidstation-owner-metrics-") as directory:
        directory = Path(directory)
        certificate, key = directory / "cert.pem", directory / "key.pem"
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=" + HOSTNAME, "-addext", "subjectAltName=DNS:" + HOSTNAME,
            "-keyout", key, "-out", certificate,
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        bin_directory = directory / "bin"
        bin_directory.mkdir()
        tailscale = bin_directory / "tailscale"
        tailscale.write_text("#!/bin/sh\nprintf '%s\\n' '" + json.dumps({"BackendState": "Running", "Self": {"DNSName": HOSTNAME + "."}}) + "'\n")
        tailscale.chmod(0o755)
        # Mock only DNS resolution and the external Tailscale CLI. Requests still
        # use real HTTPS and validate the fixture hostname against its certificate.
        (directory / "sitecustomize.py").write_text(
            "import socket\noriginal = socket.getaddrinfo\n"
            "def resolve(host, *args, **kwargs):\n"
            f"    return original('127.0.0.1' if host == {HOSTNAME!r} else host, *args, **kwargs)\n"
            "socket.getaddrinfo = resolve\n")
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certificate, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            origin = f"https://{HOSTNAME}:{server.server_port}"
            command = [sys.executable, "scripts/verify-owner-metrics.py", origin, "/", "/dev/shm"]
            env = {**os.environ, "SSL_CERT_FILE": str(certificate), "PYTHONPATH": str(directory),
                   "PATH": str(bin_directory) + os.pathsep + os.environ["PATH"]}
            for invalid in ("https://attacker.example", "https://other.tailnet.ts.net", origin + "/path",
                            origin + "?query=1", origin + "#fragment", "https://user:secret@" + HOSTNAME):
                rejected = subprocess.run([command[0], command[1], invalid, "/", "/dev/shm"], env=env,
                                          stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                          start_new_session=True, timeout=10)
                assert rejected.returncode != 0
                assert "origin must" in rejected.stderr
                assert "password" not in rejected.stderr.lower()
                assert "user:secret" not in rejected.stderr
                assert State.login_requests == 0
            detached = subprocess.run(command, env=env, stdin=subprocess.DEVNULL,
                                      capture_output=True, text=True, start_new_session=True, timeout=10)
            assert detached.returncode == 1
            assert "controlling terminal" in detached.stderr
            assert State.login_requests == 0

            State.reject_login = True
            code, stdout, stderr = run_with_tty(command, env)
            assert code == 1
            assert "login returned HTTP 401" in stderr
            assert PASSWORD not in stdout + stderr
            assert COOKIE not in stdout + stderr
            assert State.metric_requests == State.logout_requests == 0
            State.reject_login = False
            State.login_requests = 0

            code, stdout, stderr = run_with_tty(
                command, env,
            )
        finally:
            server.shutdown()
            thread.join()

    # The deterministic unavailable response makes docker-smoke red, while the
    # request counts prove the public CLI retained and replayed the host-only cookie.
    assert code == 1, (code, stdout, stderr)
    assert State.login_requests == 1
    assert State.metric_requests == 2
    assert State.logout_requests == 1
    assert not State.bad_cookie
    assert COOKIE not in stdout + stderr
    assert PASSWORD not in stdout + stderr
    print("PASS: host-only owner cookie reaches metrics and logout; smoke failure remains visible")


if __name__ == "__main__":
    main()
