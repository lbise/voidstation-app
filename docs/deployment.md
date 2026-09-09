# Private Server deployment

Run these commands on the Ubuntu Server using a user allowed to run Docker. Docker Desktop and remote Docker contexts are not supported by the deployment helper. Requirements are Docker Engine with Compose, Node.js 24, Python 3, `findmnt`, and `ip`. CI does not deploy to the Server.

## Configure once

Copy `.env.example` to the ignored `.env` and fill in the intended LAN IPv4 address, Tailscale IPv4 address, free port, two probe directories, and expected data filesystem UUID. Never commit `.env` or paste its contents into GitHub issues. Addresses are explicit, not guessed from a default route. The helper accepts private LAN addresses and Tailscale's IPv4 range, and requires both addresses to exist on this Server.

Before creating directories, identify the intended filesystems:

```sh
findmnt -o TARGET,SOURCE,FSTYPE,UUID,MAJ:MIN /
findmnt -o TARGET,SOURCE,FSTYPE,UUID,MAJ:MIN /path/to/data/mount
```

Confirm the data mount is actually mounted and note its UUID. Create one dedicated empty directory on each filesystem, readable and searchable by container UID/GID 1000. For example, use mode 0755 with no files inside. Do not create a data probe while its filesystem is absent. Do not use `/`, a mount root, a directory containing user files, or a symlink as a probe.

The preflight compares the root probe's device with `/`, checks the data probe against the configured UUID, and rejects a data probe on the root filesystem. This catches a missing data mount that leaves a directory on the root filesystem. It also refuses missing, nonempty, or redirected probe directories. Compose never creates missing bind sources. If access fails, fix the narrow source's permissions or report the blocker. Do not add container root, privileged mode, the Docker socket, or an entire host filesystem mount.

Reserve stable LAN addressing through your existing network administration process. Tailscale must already be running and authorized. This deployment does not reconfigure either service.

## Start or update

```sh
npm ci
npm run typecheck
npm run docker:check
npm run docker:up
npm run docker:logs
```

`docker:up` validates configuration, builds the image, then rechecks filesystem identity and both ports immediately before updating only `dashboard`. It permits this Compose project's existing Dashboard bindings during an update, but refuses unrelated Docker publications and native listeners. Port 3000 is a suggestion, not an assumption. Inspect `ss -ltn` and `docker ps` when a conflict is reported. Choose a free port rather than stopping its owner.

For updates, first fetch and select the intended Git revision, then repeat the commands above. Do not use `git reset --hard` on a working tree with local changes. Only Voidstation is recreated. Keep the previous image/revision until verification passes. To roll back, select that revision and repeat its documented deployment procedure, keeping `.env` private.

The image runs as UID/GID 1000, drops all capabilities, has a read-only root filesystem, and prevents new privileges. Its five read-only host mounts are `/proc/stat`, `/proc/uptime`, `/proc/meminfo`, and the two empty capacity probes. `/tmp` is a size-limited tmpfs. The adapter uses only the fixed container paths and does not fall back to container metrics when a source fails.

## Inspect actual exposure

Resolve the local values from `.env` when replacing placeholders below. Do not publish the resulting Docker inspection output without removing private deployment details.

```sh
cid=$(docker compose ps -q dashboard)
docker inspect "$cid" --format '{{json .NetworkSettings.Ports}}'
docker inspect "$cid" --format '{{json .HostConfig.PortBindings}}'
docker port "$cid"
ss -ltn
curl --noproxy '*' --fail http://LAN_ADDRESS:PORT/api/metrics
curl --noproxy '*' --fail http://TAILSCALE_ADDRESS:PORT/api/metrics
```

There must be exactly two IPv4 publications for container port 3000, on the configured addresses. No `0.0.0.0`, `::`, unexpected address, or extra publication is acceptable. Container-internal `HOSTNAME=0.0.0.0` is needed to serve Docker's bridge and is not a host wildcard publication. Inspect the container's mounts, user, capabilities, and security options too:

```sh
docker inspect "$cid" --format '{{.Config.User}} {{json .HostConfig}} {{json .Mounts}}'
```

Docker can bypass host firewall rules for published ports. Specific destination-address bindings are not source-address access controls. Do not claim private-only exposure from these local checks. From a separate LAN device, open the LAN URL. From a permitted Tailscale peer, preferably off the LAN, open the Tailscale URL. Record the vantage point and result for each. A Tailscale ping alone does not prove HTTP reachability.

The owner must confirm there is no router port forwarding, UPnP mapping, Tailscale Funnel, reverse proxy, or other forwarding path exposing this port publicly. Inspect Docker forwarding rules with an authorized administrator if needed. Do not change existing firewall or network services as part of verification. Record any unavailable access rather than assuming firewall defaults protect Docker.

Direct LAN HTTP is unencrypted. Tailscale encrypts traffic carried through Tailscale. Anyone allowed network access sees the same read-only metrics without an account. Public exposure, HTTPS, and application login remain out of scope.

## Compare host measurements

Close other Dashboard tabs during the CPU comparison because each request advances the shared CPU sample. Run on the Server, not inside the container:

```sh
mkdir -p artifacts/issue-5
python3 scripts/docker-smoke.py http://LAN_ADDRESS:PORT ROOT_PROBE DATA_PROBE \
  > artifacts/issue-5/smoke.json
```

The script reads Ubuntu `/proc` and `statvfs` independently of the application, samples the real HTTP endpoint five seconds apart, and fails on unavailable or mismatched readings. It requires exact RAM and filesystem totals. Uptime must be within one second of the host sample bracket; CPU within five percentage points. RAM used/available allow the greater of 64 MiB or 1% of total, and filesystem used/available allow the greater of 16 MiB or 0.001% of total for concurrent workloads. Review discrepancies instead of widening tolerances blindly. Filesystem free and unprivileged available blocks differ because of reserved space.

To rule out container-only readings, inspect the exact read-only proc mounts and compare the API Uptime with both host boot time and container start time. Compare host totals with container cgroup limits, not only container `/proc`, which can itself show host values. A disposable copy of this image with the same narrow mounts, a 256 MiB memory limit, and a half-CPU quota can provide stronger evidence: run the smoke check against a free loopback-only port and confirm it still reports host totals and host-wide CPU. Remove only that disposable container afterward. Never apply the experimental limits to unrelated workloads.

## Crash recovery and boot startup

Compose uses `restart: unless-stopped`. A manually stopped container stays stopped under that policy. Wait until the container has been running at least ten seconds before testing crash recovery. Kill Node inside this application, not with `docker stop` or `docker kill`, which represent an intentional Docker stop:

```sh
cid=$(docker compose ps -q dashboard)
docker inspect "$cid" --format '{{.RestartCount}} {{.State.StartedAt}}'
app_pid=$(docker top "$cid" -eo pid | tail -n 1 | tr -d ' ')
kill -KILL "$app_pid"
# Wait for restart, then repeat the HTTP smoke check.
docker inspect "$cid" --format '{{.RestartCount}} {{.State.StartedAt}}'
systemctl is-enabled docker tailscaled
systemctl is-active docker tailscaled
```

The `kill` targets the application PID reported by this container only. Run it as the Docker/container owner. The container drops `CAP_KILL`, so an in-container signal may not be permitted; do not add a capability just for this check.

Do not reboot the Server or restart Docker or Tailscale to test boot behavior. Inspect that Docker is enabled and active instead. Docker may race address or filesystem availability during boot; if that happens, the owner must add an ordered startup unit through the normal host administration process. This release does not add a host service or change boot ordering.

After startup and crash testing, compare unrelated container IDs, start times, and restart counts with a pre-deployment inventory. A brief interval while Voidstation is recreated is expected; unrelated workloads must remain running.

## Evidence

Record the Git revision, Ubuntu and Docker versions, port recheck, filesystem identity checks, security inspection, host/API comparisons, crash recovery, boot configuration, unrelated workload continuity, and LAN/Tailscale vantage points. Keep raw files under ignored `artifacts/issue-5/` and commit a summary without private addresses or UUIDs. See [issue #5 verification](verification/issue-5.md) for this deployment's results and remaining checks.
