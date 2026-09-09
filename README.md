# Voidstation

A read-only Dashboard for Server CPU, RAM, Disk space, and Uptime. Both users see the same readings without application login. This implements [issue #3](https://github.com/lbise/voidstation-app/issues/3), building on [issue #2](https://github.com/lbise/voidstation-app/issues/2).

## Local development

Use Node.js 24 and npm. No database, credentials, or private Server connection is needed.

```sh
npm ci
npm run dev
# Open http://127.0.0.1:3000
```

On Linux, the application reads this machine's `/proc/uptime` and `/proc/meminfo`. Other operating systems show unavailable measurements unless supplied with Linux-format source files. Local readings describe the development machine, not the home Server.

```sh
npm run typecheck
npm run test:unit          # Fast deterministic host-metrics tests
npm run test:http          # Production build, then real HTTP integration test
npm test                   # Production build, then the full Vitest suite
npm run build             # Standalone production build only
npm start                 # Serve the production build on 127.0.0.1:3000
```

GitHub Actions runs installation, type checking, and `npm test`. The HTTP test starts a real Next.js production server on a temporary loopback port, reads temporary Linux-format files through the production adapter, and removes its files/process afterward. It asserts values, observation timestamps, partial failure, recovery, caching headers, and rejection of writes. It does not mock the endpoint or require private-network access.

## Measurements and the HTTP contract

`GET /api/metrics` uses the Node.js runtime. Responses carry `Cache-Control: no-store`; Next.js route caching and browser fetch caching are also disabled. Partial or total collection failure still returns HTTP 200 with per-metric status. Unsupported write methods return HTTP 405.

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

Follow [the deployment runbook](docs/deployment.md) to configure the ignored `.env`, verify filesystem identities, and publish on explicit LAN and Tailscale IPv4 addresses. There is no automatic address selection or wildcard fallback.

```sh
npm run docker:check      # Validate local addresses, mounts, and port availability
npm run docker:up        # Build, recheck, and update only the Dashboard
npm run docker:logs
```

Both publications target container port 3000. Set `VOIDSTATION_LAN_PORT` and `VOIDSTATION_TAILSCALE_PORT` to the same free host port, or choose separate free ports. Existing Dashboard bindings are permitted during updates; unrelated port owners are not displaced.

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

Never expose this unauthenticated application publicly. Specific Docker bindings do not restrict source addresses or rule out router forwarding. Do not assume host firewall defaults restrict Docker-published ports. Docker Desktop measures its Linux VM, not a macOS or Windows host. See [deployment verification](docs/verification/issue-5.md) for host comparisons, crash recovery, and network verification limits.

HTTP is unencrypted on a direct LAN connection. Tailscale encrypts traffic carried through its network. Anyone allowed network access sees the same metrics. Authentication and HTTPS are outside this release; revisit authentication before adding server controls or sensitive information.

## Browser verification

Agent-browser is a development dependency, not application runtime code. Install its Chromium browser once:

```sh
npx agent-browser install
# Start npm run dev in another terminal.
export AGENT_BROWSER_SESSION="$(npx agent-browser session id --scope worktree --prefix voidstation)"
npx agent-browser open http://127.0.0.1:3000
npx agent-browser set viewport 375 812
npx agent-browser snapshot
npx agent-browser screenshot artifacts/dashboard-mobile.png
npx agent-browser close
```

See `docs/verification/issue-2.md` for the agent-run checks and limitations. These are not an automated screenshot regression suite; repeatable coverage comes from Vitest and the HTTP test.
