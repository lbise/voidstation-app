# Voidstation

A private Dashboard for Server CPU, RAM, Disk space, and Uptime, plus a saved-chat Assistant backed by an isolated Pi worker. One local owner account protects both pages. The Assistant can perform read-only Radarr/Sonarr media lookup and status checks; it cannot execute Server actions or media mutations. Dashboard access does not require a model provider.

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

The password prompt does not echo input. Run `npm run owner -- recover` to replace the password and invalidate every session. Use a password of at least 12 characters. There is no registration or user-management UI. Production uses dedicated persistent state, a Tailscale-issued certificate for remote access, and a dedicated private-CA certificate for LAN access. It never uses development certificates.

### Development over the local network

```sh
npm run dev:network
```

This selects the Server's private LAN IPv4 address and prints an HTTPS URL on port 3443. No Tailscale is needed. The first run prompts for a separate debug owner password and creates a self-signed development certificate. Accept its certificate warning on the laptop. Debug state lives in `/tmp/voidstation-debug`, not the production authentication directory. Stop with Ctrl+C.

If multiple LAN addresses are available, select one with `VOIDSTATION_DEV_HOST`. `VOIDSTATION_DEV_PORT` changes the port and `VOIDSTATION_DEV_STATE_DIR` changes the debug state directory. For example, `VOIDSTATION_DEV_PORT=3444 npm run dev:network` uses port 3444. Only use this development server on a trusted LAN. Production has separate LAN and Tailscale HTTPS listeners and is updated only through `./deploy.sh`. This command starts the development web server, not Docker or the production Assistant worker. It must not read or write production credentials, conversations, or authentication state.

On Linux, the application reads this machine's `/proc/stat`, `/proc/uptime`, `/proc/meminfo`, `/proc/loadavg`, and `/proc/pressure/*`. Host status (reboot, updates, drive health) stays unavailable in development unless `VOIDSTATION_HOST_STATUS` names a helper-written file. Other operating systems show unavailable measurements unless supplied with Linux-format source files. Local readings describe the development machine, not the home Server.

```sh
npm ci --prefix worker
npm run typecheck
npm run typecheck --prefix worker
npm run test:unit          # Fast deterministic host-metrics tests
npm run test:http          # Production build, then real HTTP integration test
npm test                   # Production build, then the full Vitest suite
npm run build             # Standalone production build only
npm start                 # TLS-only production server; requires TLS cert/key and origin env
```

GitHub Actions runs installation, type checking, and `npm test`. The HTTP test starts the real TLS-only production server on a temporary loopback port with a temporary trusted certificate and owner database. It exercises protected pages, metrics, login, logout, throttling, recovery, and origin rejection, alongside measurement regressions. The Assistant HTTP tests also run the real Pi worker with deterministic model responses. They cover saved history, two device sessions, streamed replies, competing turns, disconnects, restart, deletion, provider failures, and secret canaries. No live Codex credentials are used. Tests remove their files and processes afterward. OpenSSL, Python 3, and Bash are required for the Linux test suite. No private-network access or root privileges are needed.

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
  "swap": {
    "status": "available",
    "value": { "used": 536870912, "total": 2147483648 },
    "unit": "bytes",
    "observedAt": "2026-01-02T03:04:05.001Z"
  },
  "load": {
    "status": "available",
    "value": { "one": 0.58, "five": 1.25, "fifteen": 2, "cores": 8 },
    "unit": "tasks",
    "observedAt": "2026-01-02T03:04:05.001Z"
  },
  "pressure": {
    "status": "available",
    "value": {
      "cpu": { "avg10": 1.5, "avg60": 0.75 },
      "memory": { "avg10": 0, "avg60": 0 },
      "io": { "avg10": 12.34, "avg60": 4.2 }
    },
    "unit": "percent",
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
  },
  "hostStatus": {
    "status": "available",
    "value": {
      "rebootRequired": true,
      "rebootPackages": ["linux-base"],
      "updates": { "total": 12, "security": 3 },
      "drives": [
        {
          "device": "sda", "model": "WDC WD40EFRX", "passed": true, "standby": false,
          "temperatureCelsius": 34, "powerOnHours": 21000, "reallocatedSectors": 0,
          "pendingSectors": 0, "mediaErrors": null, "percentageUsed": null
        }
      ]
    },
    "unit": "status",
    "observedAt": "2026-01-02T02:50:00.000Z"
  }
}
```

An unavailable measurement has `status: "unavailable"`, `value: null`, `observedAt: null`, and retains its unit. A failed observation has no measurement timestamp. A successful source gets its own timestamp immediately after reading. No raw host input, filesystem path, or error detail appears in the response.

- CPU is overall Server utilization from successive aggregate `/proc/stat` samples. The first sample establishes a baseline and is unavailable; invalid or reset counter deltas are unavailable rather than fabricated.
- Uptime is the first value in the host's `/proc/uptime`, in seconds since boot. It is not Node.js process uptime.
- RAM used is `MemTotal - MemAvailable`. Linux's `kB` fields are converted with 1024 bytes per unit. `MemAvailable` accounts for reclaimable memory; `MemFree` alone does not. Missing or invalid available memory is unavailable, not a fallback estimate.
- Swap used is `SwapTotal - SwapFree` from the same `/proc/meminfo` read. A total of 0 is a valid reading: the Server has no swap.
- Load is the 1-, 5-, and 15-minute run-queue averages from `/proc/loadavg`, with `cores` counted from the `cpuN` lines of the same `/proc/stat` read that feeds CPU. `/proc/stat` is read once per request so the CPU interval baseline is unaffected.
- Pressure is the kernel's pressure stall information: the `some` line's `avg10` and `avg60` percentages from `/proc/pressure/cpu`, `memory`, and `io`. All three must parse or the whole measurement is unavailable.
- Host status comes from one small JSON file written every 15 minutes by a root helper on the Server (see [Host status helper](#host-status-helper)). Its `observedAt` is the helper's check time, not the request time. A file older than three hours, dated more than five minutes in the future, larger than 64 KiB, not a regular file, or failing strict validation is unavailable. `updates` is null when pending updates could not be counted; `drives` is null when smartmontools is not installed. A drive with `standby: true` was asleep and deliberately not woken, so its readings are null.
- Disk space is measured independently for the root and data mounted filesystems. Used space is total minus filesystem free blocks; Available is the unprivileged-user `bavail` capacity, so reserved space is not incorrectly counted as available. A data path on the same filesystem as the root path is unavailable.
- The Dashboard labels all memory quantities in GiB, where 1 GiB is 1,073,741,824 bytes.
- Readings refresh every five seconds during active viewing. Browser suspension can pause scheduling. Resuming a visible page triggers a refresh.
- Before the first response, cards show loading. A failed metric with no prior success shows unavailable. After a failure, any previous successful value stays visible as a **Stale reading**, with its original observation time. Request failures show a warning and retry automatically. Successful retries clear the stale state. Zero remains a valid reading.

`src/lib/host-metrics.ts` exposes `collectHostMetrics(input)` and the single `HostInput` substitution interface. Tests supply source text and observation times there. Linux file access lives in `src/lib/linux-host-input.ts`; parsing, validation, and calculations stay in the host-metrics module. `src/lib/metrics-contract.ts` is safe to import in the UI. Additional CPU and Disk space measurements can use the same per-metric contract without putting Linux collection in React.

`VOIDSTATION_HOST_PROC` selects the source directory at server startup. Only the fixed filenames `stat`, `uptime`, `meminfo`, `loadavg`, and `pressure/{cpu,memory,io}` are read. `VOIDSTATION_HOST_STATUS` selects the host-status file at startup (default `/host/status/status.json`); it is opened without following a final symbolic link, must be a regular file, and is read up to 64 KiB. `VOIDSTATION_HOST_ROOT_FS` and `VOIDSTATION_HOST_DATA_FS` select the two filesystem probe directories at startup. The adapter reads filesystem capacity and device identity from those fixed paths; it does not accept paths from HTTP requests. There is no test endpoint, fixture mode, arbitrary file query, or query-string input substitution. Do not point these variables at untrusted files or named pipes.

## Docker package

Follow [the deployment runbook](docs/deployment.md) to configure the ignored `.env`, reuse or bootstrap the owner account, provision both HTTPS certificates, and verify filesystem identities. Production serves the same application and durable state through explicit LAN and Tailscale HTTPS origins. LAN clients work with Tailscale disabled. The owner selected a reserved LAN IP on port 3000 and a dedicated private CA, with [one-time trust installation on Arch Linux and Android](docs/lan-certificates.md). No router DNS or DDNS change is needed. There is no plaintext application listener, public registration, or Funnel.

For certificate setup, run `bash scripts/setup-lan-certificates.sh LAN_IP` **on the Arch laptop**, not the Server. The wizard issues or renews the certificate, offers SSH transfer and Server installation, and prepares the Arch/Android trust files. It never deploys the app or changes the firewall. See [the per-machine commands](docs/lan-certificates.md).

```sh
npm run docker:check    # Validate both TLS paths, ingress policy, mounts, and ports
./deploy.sh             # Check, build, and update Dashboard, assistant-worker, and searxng
npm run docker:logs
```

The Tailscale publication targets Dashboard container port 3000; the LAN publication targets container port 3443. Both are TLS-only listeners in one process, with separate certificates and listener-specific Host checks. `assistant-worker` has no host publication. The Dashboard calls it only on the Compose bridge at `http://assistant-worker:3001`, authenticated with a shared token file. Conversation transcripts and provider refresh state remain in separate durable worker directories. A persistent DOCKER-USER policy permits only the configured ingress interfaces, source ranges, and original published destinations to `br-voidstation`. It blocks unconfigured ingress and direct backend/worker access. The owner must authorize and persist that policy before cutover. Existing Dashboard bindings are permitted during updates; unrelated port owners are not displaced. See the runbook for pre/post checks and rollback that retains login and HTTPS.

The Dashboard and worker run as UID/GID 1000. Compose drops capabilities, prevents gaining new privileges, uses a read-only root filesystem, and gives each service only its own writable state plus a restricted `/tmp` tmpfs. The Dashboard binds only the required narrow read-only inputs:

| Host source | Container target |
| --- | --- |
| `/proc/stat` | `/host/proc/stat` |
| `/proc/uptime` | `/host/proc/uptime` |
| `/proc/meminfo` | `/host/proc/meminfo` |
| `${VOIDSTATION_ROOT_FILESYSTEM_PATH}` | `/host/filesystems/root` |
| `${VOIDSTATION_DATA_FILESYSTEM_PATH}` | `/host/filesystems/data` |
| `/proc/loadavg` | `/host/proc/loadavg` |
| `/proc/pressure` (directory) | `/host/proc/pressure` |
| `${VOIDSTATION_HOST_STATUS_DIRECTORY:-/var/lib/voidstation/host-status}` | `/host/status` |

Set the two filesystem variables to dedicated existing empty directories on the selected root and data filesystems. There are no default probe paths. Configure the expected data filesystem UUID too; preflight verifies it and checks that the root probe belongs to `/`. The image uses `VOIDSTATION_HOST_PROC=/host/proc` plus fixed filesystem targets and never falls back to container sources if those mounts fail. Missing source files or directories make Compose fail rather than create them. Unreadable or invalid sources report unavailable. Do not work around access failures with root, privileged mode, the Docker socket, or an entire host filesystem mount.

### Host status helper

Reboot-required flags, pending update counts, and SMART drive health need root on the host. The Dashboard container never gets that access. Instead, a root helper runs on the Server every 15 minutes (and two minutes after boot) from a systemd timer and writes `/var/lib/voidstation/host-status/status.json` atomically (root-owned directory `0755`, file `0644`). The Dashboard mounts only that directory, read-only, and validates the file strictly. The directory is mounted rather than the file because the helper replaces the file by rename.

The helper (`scripts/host/voidstation-host-status.py`, Python 3 standard library only) reads `/run/reboot-required` and `/run/reboot-required.pkgs`, runs `/usr/lib/update-notifier/apt-check` for pending update counts (it never runs `apt update`), and, when smartmontools is installed, runs `smartctl --scan-open` then `smartctl -n standby -H -A -i` per drive. `-n standby` means a sleeping HDD is reported as in standby and never spun up. Serial numbers are not recorded. Every subprocess has a timeout. The unit keeps only `CAP_SYS_RAWIO` and `CAP_SYS_ADMIN` for SMART pass-through, with no network, a read-only file system except its output directory, and a system-call filter.

Install or update it on the Server before deploying this release; Compose refuses to start the Dashboard without the directory:

```sh
sudo apt install --no-install-recommends smartmontools   # optional: drive health
sudo scripts/install-host-status.sh
```

The script is idempotent. It installs root-owned copies of the helper to `/usr/local/libexec/voidstation-host-status` and the units to `/etc/systemd/system/`, creates the directory, enables `voidstation-host-status.timer`, and runs the helper once. Re-run it after pulling helper changes. Inspect with `systemctl list-timers voidstation-host-status.timer` and `journalctl -u voidstation-host-status.service`. The directory path is fixed in the unit; `VOIDSTATION_HOST_STATUS_DIRECTORY` only needs setting if the unit is changed to match.

The worker has outbound network access for its configured provider and for fetching web pages. Web search goes through the internal `searxng` service at `http://searxng:8080` (`VOIDSTATION_SEARCH_PROVIDER=searxng`). SearXNG uses a digest-pinned upstream image and runs as the image's own UID/GID 977 with a read-only root, no capabilities, no host port, the committed read-only `deploy/searxng/settings.yml`, and a private secret file named by `VOIDSTATION_SEARXNG_SECRET_FILE`. See [the runbook](docs/deployment.md#web-search-searxng). The worker has no Docker socket, host metrics mounts, TLS mount, application auth mount, development workspace, or host Pi configuration. Its token is read-only. Conversation storage and worker credential storage are separate writable UID-1000 directories. Use the worker's [independent device-code login](worker/README.md#codex-login). Never copy an interactive Pi or Codex credential into either directory.

### Download queue

The Dashboard shows a read-only download queue from Radarr and Sonarr through the assistant worker (`GET /media/queue`, called by the signed-in `GET /api/downloads`). It uses the same `VOIDSTATION_MEDIA_CONFIG_FILE` and API key files as the Assistant's media tools and does not need a model provider. Each service is reported independently: a service missing from the config, or whose key file is unreadable, appears as not configured without hiding the other. The worker reads at most one page of 200 records per service and caches the result for 10 seconds, so Dashboard polling adds no meaningful load on Radarr or Sonarr. The Dashboard validates the response against `src/lib/downloads-contract.ts`; `worker/src/downloads-contract.ts` is a copy that a test keeps identical.

Back up `auth`, `conversations`, `worker-credentials`, and `worker-token` as one encrypted, owner-only snapshot while both containers are stopped. Restore them only while both containers remain stopped, restore UID/GID 1000 and the documented modes, then run preflight before starting either container. A restored unfinished turn stays interrupted. Do not replay it. A future action approval restored from backup must be rechecked against current service state before execution; expired approvals stay expired. Deleting an idle conversation removes its transcript and its future action and approval records. It never reverses media changes.

`restart: unless-stopped` restarts each container after crashes and Docker daemon restarts, provided the daemon starts at boot. A manually stopped container stays stopped. No reboot is needed to build or test this package.

Do not expose Voidstation publicly or enable Tailscale Funnel. Do not assume host firewall defaults restrict Docker-published ports. Docker Desktop measures its Linux VM, not a macOS or Windows host. Earlier [issue #5 evidence](docs/verification/issue-5.md) describes the superseded deployment, not proof of this release's secure publication.

## Authentication boundary

`src/proxy.ts` denies access by default, including future Assistant pages, API routes, RSC requests, and public files. Only login, its POST endpoint, and an asset allowlist generated from the login build are public. The metrics handler also validates its session before collecting Server measurements. Each TLS listener rejects unexpected Host headers and client-supplied forwarding or Tailscale identity headers. The application selects the configured origin corresponding to the request Host.

Sessions are opaque random tokens in `__Host-voidstation-session`, with Secure, HttpOnly, SameSite=Strict, and an eight-hour lifetime. The private SQLite database stores token hashes, a salted scrypt password hash, and a persistent owner-wide login limiter. It contains no model-provider credentials. Five sign-in attempts per rolling 15-minute window bound password hashing, including concurrent attempts. Changing IP or forwarding headers cannot reset that limit. Administrative recovery resets the limiter and invalidates all sessions, including sessions in other running application processes sharing the database.

All mutations require the exact configured HTTPS Origin corresponding to the request Host, including login and logout. Supplying the other allowed origin is still rejected. Cross-site and same-site-but-other-origin requests fail; missing Origin fails too. No HTTP-to-HTTPS redirect listener exists. Never use `next start` as a production shortcut.

## Assistant verification

The worker has its own exact Pi pins and lockfile. Docker checks run real test and production images against synthetic Pi resources and temporary state, not the owner's development credentials.

```sh
docker build --target build -t voidstation-assistant-worker:test worker
docker build --target runtime -t voidstation-assistant-worker:check worker
npm run worker:runtime:inspect
node scripts/compose-runtime-check.mjs
```

For a disposable browser fixture, build both applications, then run `npm run assistant:browser-fixture`. It prints the local HTTPS origin and writes temporary fixture details to ignored `artifacts/assistant/browser-fixture.json`. Map its test hostname to loopback in the test browser. Stop the fixture with Ctrl+C. See [issue #8 verification](docs/verification/issue-8.md) for the checked scenarios and remaining owner-run steps.

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
