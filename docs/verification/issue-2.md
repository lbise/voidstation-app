# Issue #2 verification

## Automated checks

- `npm run typecheck` passes.
- `npm run test:unit` passes 16 cases through `collectHostMetrics`, the agreed public module boundary. Cases cover RAM arithmetic, reclaimable memory, valid zeros, independent observation times, unavailable sources, and invalid Linux inputs.
- `npm run test:http` builds and starts the real production Next.js application with temporary host-input files. The HTTP case verifies values, observation-time bounds, changed readings without caching, partial failure, recovery to zero RAM usage, ignored input-control query parameters, and HTTP 405 for POST.
- `npm test` builds production output and runs both test files. GitHub Actions runs this command after type checking.
- `npm audit --omit=dev` reported no vulnerabilities during implementation.

No test uses private Server access. Module tests substitute only `HostInput`. The HTTP test uses the production file adapter and real endpoint, not mocked collection or HTTP responses.

## Browser checks

Agent-run Chromium checks against the production server on loopback, using controlled Linux-format files. No Playwright test suite or screenshot-diff framework was added.

| Check | Result |
| --- | --- |
| Initial response delayed by a browser init script | Visible loading labels and placeholders, no fabricated zero |
| 90,061.25 seconds Uptime; 8 GiB total, 3 GiB available | 1 day 1 hour 1 minute; 5.0 GiB used, 3.0 GiB available, 8.0 GiB total; 63% rounded bar label |
| Remove the RAM source after success | RAM retains its value and timestamp with Stale reading; Uptime stays current |
| Abort metrics requests in the browser | Both prior measurements stay stale; original timestamps remain unchanged; visible request-failure alert |
| Reload with RAM source still missing | RAM shows unavailable and no observation; Uptime remains current |
| Restore sources with zero Uptime and zero used RAM | Automatic recovery to current 0 seconds and 0.0 GiB, not unavailable |
| Remove browser request blocking without reloading | Both cards recover and request warning disappears |
| Poll cadence during active viewing | Four successive intervals measured 5000, 4999, 5000, and 5000 ms |
| Desktop, 1440 × 900 | Side-by-side cards and readable last-updated information |
| Widths 320, 375, 414, 768 px | Stacked cards; document scroll width equals viewport width at each size |
| Stale state at 320 px | Badges, warning, values, and dated observation times fit without horizontal scrolling |
| axe-core WCAG 2 A/AA | 20 checks passed, 0 violations, 0 incomplete checks |
| Browser page errors | None reported |

The local Linux browser sandbox was unavailable. Agent-browser used `--args '--no-sandbox'` only for this isolated loopback browser check. This is not a Docker application setting or a deployment recommendation.

Screenshots are agent-run evidence, not repeatable automated regression coverage:

- [Desktop](issue-2/desktop.png)
- [Mobile, 375 px](issue-2/mobile.png)
- [Initial loading](issue-2/loading.png)
- [Stale readings and request warning, 320 px](issue-2/stale-mobile.png)
- [Initial unavailable RAM](issue-2/unavailable.png)
- [Recovery with valid zero readings](issue-2/recovery.png)

## Local Docker package checks

Built `voidstation:issue-2` from `Dockerfile`. Ran it with a read-only root filesystem, all capabilities dropped, `no-new-privileges`, two read-only file mounts, a loopback-only published port, and a 256 MiB memory limit.

- `id` inside the application container reported UID/GID 1000, `node`.
- Docker inspection showed exactly `/proc/uptime` and `/proc/meminfo` bound read-only to `/host/proc/`.
- The API reported host Uptime of 832007.51 seconds; the next host sample was 832007.52 seconds.
- API total RAM and host `MemTotal` both reported 8,098,074,624 bytes, not the container's 256 MiB limit.
- API available RAM was 5,150,629,888 bytes; the following host sample was 5,149,368,320 bytes. The small difference reflects separate observation times.
- Running the same image without source mounts returned both metrics unavailable, with null values/timestamps. It did not fall back to `/proc` inside the container.
- `docker compose config --quiet` passed.
- Test containers were removed. No existing containers or host services were stopped.

## Not verified here

Actual Ubuntu Server deployment, LAN/Tailscale reachability, private-only exposure, daemon boot configuration, and restart-after-crash/reboot behavior belong to the deployment ticket. The local Docker comparison is not proof about the home Server or Docker Desktop hosts. Device suspension scheduling and a broad mobile-browser matrix were not tested.
