# Voidstation

A private Dashboard for Server CPU, RAM, Disk space, and Uptime. One local owner account protects all pages and measurements. [Issue #7](https://github.com/lbise/voidstation-app/issues/7) replaces the earlier unauthenticated LAN access policy. No model provider is required.

## Local development

Use Node.js 24 and npm. Local development needs a disposable owner account, not a private Server connection or provider credentials. Keep its database outside the repository.

```sh
npm ci
install -d -m 700 /tmp/voidstation-dev-auth
export VOIDSTATION_AUTH_DB=/tmp/voidstation-dev-auth/auth.sqlite
export VOIDSTATION_ORIGIN=https://localhost:3000
npm run owner -- bootstrap
npm run dev
# Open https://localhost:3000 and trust the local development certificate.
```

The password prompt does not echo input. Run `npm run owner -- recover` to replace the password and invalidate every session. Use a password of at least 12 characters. There is no registration or user-management UI. Production uses a dedicated persistent state directory and Tailscale-issued TLS certificates, not development certificates.

On Linux, the application reads this machine's `/proc/uptime` and `/proc/meminfo`. Other operating systems show unavailable measurements unless supplied with Linux-format source files. Local readings describe the development machine, not the home Server.

```sh
npm run typecheck
npm run test:unit          # Fast deterministic host-metrics tests
npm run test:http          # Production build, then real HTTP integration test
npm test                   # Production build, then the full Vitest suite
npm run build             # Standalone production build only
npm start                 # TLS-only production server; requires TLS cert/key and origin env
```

GitHub Actions runs installation, type checking, and `npm test`. The HTTP test starts the real TLS-only production server on a temporary loopback port with a temporary trusted certificate and owner database. It exercises protected pages, metrics, login, logout, throttling, recovery, and origin rejection, alongside measurement regressions. It removes its files and process afterward. OpenSSL is required. No private-network access is needed.

## Measurements and the HTTP contract

`GET /api/metrics` requires a valid owner session and uses the Node.js runtime. Unauthenticated requests return HTTP 401 without readings. Responses carry `Cache-Control: no-store`; Next.js route caching and browser fetch caching are also disabled. Partial or total collection failure still returns HTTP 200 with per-metric status. Authenticated unsupported writes with a valid Origin return HTTP 405; mutations without the exact application Origin return HTTP 403.

```json
{
  "cpu": {
    "status": "available",
    "value": 42.8571428571,
    "unit": "percent",
    "observedAt": "2026-01-02T03:04:05.000Z"
  },
  "uptime": {
    "status": "available",
    "value": 90061.25,
    "unit": "seconds",
    "observedAt": "2026-01-02T03:04:05.000Z"
  },
  "ram": {
    "status": "available",
    "value": { "used": 5368709120, "available": 3221225472, "total": 8589934592 },
    "unit": "bytes",
    "observedAt": "2026-01-02T03:04:05.001Z"
  },
  "rootFilesystem": {
    "status": "available",
    "value": { "used": 400000000000, "available": 50000000000, "total": 500000000000 },
    "unit": "bytes",
    "observedAt": "2026-01-02T03:04:05.002Z"
  },
  "dataFilesystem": {
    "status": "available",
    "value": { "used": 700000000000, "available": 300000000000, "total": 1000000000000 },
    "unit": "bytes",
    "observedAt": "2026-01-02T03:04:05.003Z"
  }
}
```

An unavailable measurement has `status: "unavailable"`, `value: null`, `observedAt: null`, and retains its unit. A failed observation has no measurement timestamp. A successful source gets its own timestamp immediately after reading. No raw host input, filesystem path, or error detail appears in the response.

- CPU is overall Server utilization from successive aggregate `/proc/stat` samples. The first sample establishes a baseline and is unavailable; invalid or reset counter deltas are unavailable rather than fabricated.
- Uptime is the first value in the host's `/proc/uptime`, in seconds since boot. It is not Node.js process uptime.
- RAM used is `MemTotal - MemAvailable`. Linux's `kB` fields are converted with 1024 bytes per unit. `MemAvailable` accounts for reclaimable memory; `MemFree` alone does not. Missing or invalid available memory is unavailable, not a fallback estimate.
- Disk space is measured independently for the root and data mounted filesystems. Used space is total minus filesystem free blocks; Available is the unprivileged-user `bavail` capacity, so reserved space is not incorrectly counted as available. A data path on the same filesystem as the root path is unavailable.
- The Dashboard labels all memory quantities in GiB, where 1 GiB is 1,073,741,824 bytes.
- Readings refresh every five seconds during active viewing. Browser suspension can pause scheduling. Resuming a visible page triggers a refresh.
- Before the first response, cards show loading. A failed metric with no prior success shows unavailable. After a failure, any previous successful value stays visible as a **Stale reading**, with its original observation time. Request failures show a warning and retry automatically. Successful retries clear the stale state. Zero remains a valid reading.

`src/lib/host-metrics.ts` exposes `collectHostMetrics(input)` and the single `HostInput` substitution interface. Tests supply source text and observation times there. Linux file access lives in `src/lib/linux-host-input.ts`; parsing, validation, and calculations stay in the host-metrics module. `src/lib/metrics-contract.ts` is safe to import in the UI. Additional CPU and Disk space measurements can use the same per-metric contract without putting Linux collection in React.

`VOIDSTATION_HOST_PROC` selects the source directory at server startup. Only the fixed filenames `stat`, `uptime`, and `meminfo` are read. `VOIDSTATION_HOST_ROOT_FS` and `VOIDSTATION_HOST_DATA_FS` select the two filesystem probe directories at startup. The adapter reads filesystem capacity and device identity from those fixed paths; it does not accept paths from HTTP requests. There is no test endpoint, fixture mode, arbitrary file query, or query-string input substitution. Do not point these variables at untrusted files or named pipes.

## Docker package

Follow [the deployment runbook](docs/deployment.md) to configure the ignored `.env`, bootstrap the owner account, provision Tailscale HTTPS certificates, and verify filesystem identities. Publish only HTTPS on an explicit Tailscale IPv4 address. Tailscale clients are required at home and away. There is no LAN binding, HTTP backend, public registration, or Funnel.

```sh
npm run docker:check      # Validate TLS, Tailscale, container restrictions, mounts, and ports
npm run docker:up        # Build, recheck, and update only the Dashboard
npm run docker:logs
```

The single Tailscale publication targets container port 3000, which accepts TLS only. A preflight-verified DOCKER-USER rule blocks non-Tailscale ingress to the dedicated `br-voidstation` bridge. The owner must authorize and persist that rule before deployment. A Tailscale destination address alone does not prevent routed LAN access. Choose a free HTTPS host port. Existing Dashboard bindings are permitted during updates; unrelated port owners are not displaced. See the runbook for the separately authorized cutover from the old two-port deployment.

The image runs as the unprivileged `node` user. Compose drops capabilities, prevents gaining new privileges, uses a read-only root filesystem, and binds only the required narrow read-only inputs:

| Host source | Container target |
| --- | --- |
| `/proc/stat` | `/host/proc/stat` |
| `/proc/uptime` | `/host/proc/uptime` |
| `/proc/meminfo` | `/host/proc/meminfo` |
| `${VOIDSTATION_ROOT_FILESYSTEM_PATH}` | `/host/filesystems/root` |
| `${VOIDSTATION_DATA_FILESYSTEM_PATH}` | `/host/filesystems/data` |

Set the two filesystem variables to dedicated existing empty directories on the selected root and data filesystems. There are no default probe paths. Configure the expected data filesystem UUID too; preflight verifies it and checks that the root probe belongs to `/`. The image uses `VOIDSTATION_HOST_PROC=/host/proc` plus fixed filesystem targets and never falls back to container sources if those mounts fail. Missing source files or directories make Compose fail rather than create them. Unreadable or invalid sources report unavailable. Do not work around access failures with root, privileged mode, the Docker socket, or an entire host filesystem mount.

`restart: unless-stopped` restarts the container after crashes and Docker daemon restarts, provided the daemon starts at boot. A manually stopped container stays stopped. No reboot is needed to build or test this package.

Do not expose Voidstation publicly or enable Tailscale Funnel. Do not assume host firewall defaults restrict Docker-published ports. Docker Desktop measures its Linux VM, not a macOS or Windows host. Earlier [issue #5 evidence](docs/verification/issue-5.md) describes the superseded deployment, not proof of this release's secure publication.

## Authentication boundary

`src/proxy.ts` denies access by default, including future Assistant pages, API routes, RSC requests, and public files. Only login, its POST endpoint, and an asset allowlist generated from the login build are public. The metrics handler also validates its session before collecting Server measurements. The TLS launcher rejects unexpected Host headers and ignores forwarded identity and protocol headers.

Sessions are opaque random tokens in `__Host-voidstation-session`, with Secure, HttpOnly, SameSite=Strict, and an eight-hour lifetime. The private SQLite database stores token hashes, a salted scrypt password hash, and a persistent owner-wide login limiter. It contains no model-provider credentials. Five sign-in attempts per rolling 15-minute window bound password hashing, including concurrent attempts. Changing IP or forwarding headers cannot reset that limit. Administrative recovery resets the limiter and invalidates all sessions, including sessions in other running application processes sharing the database.

All mutations require the exact configured HTTPS Origin, including login and logout. Cross-site and same-site-but-other-origin requests fail; missing Origin fails too. No HTTP-to-HTTPS redirect listener exists. Never use `next start` as a production shortcut.

## Browser verification

Agent-browser is a development dependency, not application runtime code. Install its Chromium browser once:

```sh
npx agent-browser install
# Start npm run dev in another terminal.
export AGENT_BROWSER_SESSION="$(npx agent-browser session id --scope worktree --prefix voidstation)"
npx agent-browser --ignore-https-errors open https://localhost:3000
npx agent-browser set viewport 375 812
npx agent-browser snapshot
npx agent-browser screenshot artifacts/dashboard-mobile.png
npx agent-browser close
```

See `docs/verification/issue-7.md` for login/logout and Dashboard checks and deployment limits. These are not an automated screenshot regression suite; repeatable coverage comes from Vitest and the production HTTPS test. Use `--ignore-https-errors` only with disposable local test certificates.
