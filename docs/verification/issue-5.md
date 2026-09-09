# Issue #5 deployment verification

Verification ran on the Ubuntu Server at the working-tree revision, without rebooting the Server or stopping unrelated containers. Deployment-specific addresses, paths, and filesystem UUIDs remain in the ignored `.env` and are intentionally absent from this record.

## Results

- Docker Engine and Compose were available. The active Docker context used the local Unix socket.
- A port recheck found the selected host port available for the Voidstation project. The updated container publishes exactly one configured LAN IPv4 binding and one configured Tailscale IPv4 binding. No wildcard binding was present in `docker inspect` or `ss -ltn`.
- Preflight passed after resolving the Compose file and again immediately before `docker compose up`. It rejected a missing data probe path during a negative check.
- The two probe directories were non-mount directories. `findmnt` and device IDs showed the root probe on `/` and the data probe on the separate data filesystem. The configured data UUID matched. The root and data devices differed.
- The container ran as `node` with `restart=unless-stopped`, a read-only root filesystem, all capabilities dropped, `no-new-privileges`, and only three `/proc` files plus the two read-only filesystem probe directories mounted.
- The HTTP smoke check sampled the real LAN endpoint over five seconds. CPU, RAM, host Uptime, and root/data Disk space were available. Host totals matched the API, Uptime stayed within the host sample bracket, CPU stayed within the five-point comparison tolerance, and used/available values matched within the documented sampling tolerance. Reserved filesystem space was retained rather than forcing used plus available to equal total.
- A disposable copy of the built image used the same five narrow read-only mounts, a loopback-only port, a 256 MiB memory limit, and a half-CPU quota. Its cgroup reported `268435456` bytes and `50000 100000`, while the API still reported the host's roughly 8.1 GiB RAM total and the host root/data filesystem totals. Its host-wide CPU, Uptime, RAM, and both Disk space readings matched the independent host samples. This rules out the normal container limit and container-only sources as the origin of those readings. The disposable container was removed.
- A host-PID `SIGKILL` against the Dashboard application process caused Docker to restart the same container. The restart count changed from 0 to 1, and the endpoint responded afterward.
- `docker` and `tailscaled` were both enabled and active. The Server was not rebooted, so boot-time startup was inspected rather than exercised.
- Existing containers remained running through the update and restart check.

## Network limits

A local check reached both configured addresses from the Server itself. No independent LAN device or off-LAN Tailscale peer was available in this session, so those two routes remain unverified from their intended vantage points. Local reachability does not prove private-only exposure. The owner must still confirm that the router has no port forwarding or UPnP mapping, Tailscale Funnel is not enabled, and no reverse proxy forwards this port publicly. Docker-published ports must not be treated as protected by host firewall defaults.

Direct LAN HTTP is unencrypted. Tailscale encrypts traffic carried through Tailscale. Both routes show the same read-only metrics without application login. Public exposure, HTTPS, and authentication were not added.

## Repeat the checks

Use the commands in [`docs/deployment.md`](../deployment.md), especially `npm run docker:check`, `npm run docker:up`, `docker inspect`, `ss -ltn`, and `scripts/docker-smoke.py`. Keep raw output under the ignored `artifacts/issue-5/` directory. Do not commit `.env` or raw output containing private deployment values.
