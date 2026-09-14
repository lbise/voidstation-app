# Tailscale HTTPS deployment

Run these commands on the Ubuntu Server as host UID 1000, or with `sudo`, using the local Docker socket. This deployment needs Docker Engine with its iptables firewall backend, Compose, Node.js 24, Python 3, `findmnt`, `ss`, `openssl`, `setpriv`, and Tailscale. Preflight uses read-only privileged checks through `sudo -n`; run `sudo -v` in the owner's terminal first. Docker's native nftables backend is not supported by these ingress checks. It does not use Docker Desktop, a remote Docker context, a reverse proxy, Tailscale Serve, or Funnel.

Voidstation listens only with TLS. Docker publishes one TCP port from the Server's assigned Tailscale CGNAT IPv4 address to container port 3000. There is no LAN binding, wildcard binding, HTTP listener, or HTTP-to-HTTPS redirect. Plain HTTP to either the published address or the container IP gets no HTTP response. Network access does not replace application login. A checked DOCKER-USER rule, not the destination-address binding alone, rejects non-Tailscale ingress to Voidstation's dedicated bridge.

## Configure the host

Copy `.env.example` to the ignored `.env`. Set `VOIDSTATION_TAILSCALE_BIND_ADDRESS` to an address reported for this Server by `tailscale status --json`. Set `VOIDSTATION_ORIGIN` to `https://` plus this Server's `Self.DNSName`, lowercase and without the trailing DNS dot. Add `:VOIDSTATION_PORT` unless the port is 443. Do not add a trailing slash or guess either value.

Keep the two existing empty metrics probe directories. The root probe must be on `/`; the data probe must be on the configured separate filesystem and match its UUID. They remain read-only container inputs.

Create the dedicated authentication directory before first bootstrap. It holds `auth.sqlite`, so it must be writable by the unprivileged container and must not contain unrelated data.

```sh
sudo install -d -o 1000 -g 1000 -m 0700 /var/lib/voidstation/auth
```

Create worker-owned state separately. The shared internal token is a file, not an environment value. This command writes it without echoing it to the terminal. Do not put the token in `.env`, logs, a shell argument, or a browser response.

```sh
sudo install -d -o 1000 -g 1000 -m 0700 /var/lib/voidstation/conversations
sudo install -d -o 1000 -g 1000 -m 0700 /var/lib/voidstation/worker-credentials
sudo sh -c 'umask 077; head -c 48 /dev/urandom | base64 -w 0 > /var/lib/voidstation/worker-token'
sudo chown 1000:1000 /var/lib/voidstation/worker-token
sudo chmod 0600 /var/lib/voidstation/worker-token
```

Set these three paths in `.env`. The worker token must contain at least 32 characters after surrounding whitespace is removed. `conversations` holds worker-owned transcripts. `worker-credentials` holds private provider refresh state. Do not merge either with the Dashboard authentication directory. The worker's `worker/README.md` documents its own Codex device-code login and renewal. Complete that login from an owner-controlled terminal, never by copying an interactive Pi or Codex credential from the Server.

Provision the certificate through the reviewed host helper. Replace the hostname with the exact hostname in `VOIDSTATION_ORIGIN`, without its scheme or port. The helper validates the hostname, expiry, and key pair before installing them. Initial provisioning does not restart an existing Dashboard or perform a live cutover.

```sh
sudo install -d -o root -g root -m 0755 /usr/local/libexec
sudo install -o root -g root -m 0755 scripts/host/voidstation-renew-certificate.sh /usr/local/libexec/voidstation-renew-certificate
sudo /usr/local/libexec/voidstation-renew-certificate --provision name.tailnet.ts.net
```

The TLS directory uses root ownership, group 1000, and mode 0750. Its private key belongs to UID/GID 1000 with mode 0600. The container can read the key through its read-only bind but cannot write it. Other local users cannot list the directory.

The host TLS directory is persistent. The container mounts it read-only at `/run/voidstation-tls`. The renewal timer below reloads changed certificates by restarting only the Dashboard. If certificates are replaced manually outside that helper, run preflight and explicitly recreate only the Dashboard; an unchanged image might otherwise keep the old certificate in memory:

```sh
npm run docker:check
docker compose --project-name voidstation-app up -d --no-deps --no-build --force-recreate dashboard
node scripts/deployment-preflight.mjs --postdeploy
```

Provisioning records the exact hostname in `/etc/voidstation/hostname`, owned and readable only by root. The installed renewal service explicitly selects this configuration and `/var/lib/voidstation/tls`; preflight checks that its target matches the application.

The host-support installation below enables daily renewal checks. The helper keeps the current certificate until a replacement has passed hostname, validity, and key-pair checks. It restarts only the running container with this project's Dashboard labels when a certificate changes. A valid certificate outside the renewal window causes no container restart unless an earlier restart remains pending. The helper records that obligation before replacing files and retries it after a failed restart. It serializes timer and manual execution with `flock`. Inspect status with `systemctl status voidstation-certificate-renewal.timer` and `journalctl -u voidstation-certificate-renewal.service`.

Certificate authorization, the renewal timer, ACLs, and MagicDNS remain owner-controlled. Never enable Funnel or add a public reverse proxy. Do not reboot the Server or stop unrelated containers.

## Owner-authorized ingress and cutover

Do not run this section without separate authorization for the live access cutover. A LAN peer can route to a Tailscale destination address without using Tailscale. Docker publication alone therefore does not meet the access policy.

The dedicated Docker bridge is named `br-voidstation`. Before starting this release, the owner must install this rule as the first DOCKER-USER rule. It blocks new connections to this bridge unless they arrive through `tailscale0`, including direct container-IP connections. Return traffic for application-initiated connections is unaffected. The rule targets only Voidstation's bridge.

```sh
sudo iptables -S FORWARD
sudo iptables -S DOCKER-USER
# Inspect existing rules first. After authorization:
sudo iptables -I DOCKER-USER 1 ! -i tailscale0 -o br-voidstation \
  -m conntrack --ctstate NEW -j DROP
```

The first FORWARD rule must jump to DOCKER-USER. If another rule runs before it, ask the host administrator to resolve the ordering; do not flush chains or reorder unrelated rules. Preflight verifies both first rules and refuses deployment when either is absent. Only the standard `tailscale0` interface and this dedicated bridge are supported.

The rule must load **before Docker starts containers at boot**. The repository supplies a root-owned oneshot unit for this, rather than enabling UFW or changing its configuration. The unit installs only the Voidstation rule and is required before Docker startup. It participates in Docker restarts so the rule is checked again.

This dependency affects Docker startup: if the rule cannot load, Docker will not start until the failure is fixed. Obtain the owner's explicit approval for that tradeoff. Installing the unit does not restart a running Docker daemon or its containers. Do not disable the dependency to work around a failure while Voidstation can auto-start.

Install the reviewed scripts and units as root-owned copies. Root services must not execute scripts from the writable checkout:

```sh
sudo install -d -o root -g root -m 0755 /usr/local/libexec
sudo install -o root -g root -m 0755 scripts/host/voidstation-ingress.sh /usr/local/libexec/voidstation-ingress
sudo install -o root -g root -m 0755 scripts/host/voidstation-renew-certificate.sh /usr/local/libexec/voidstation-renew-certificate
sudo install -o root -g root -m 0644 deploy/voidstation-ingress.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/voidstation-certificate-renewal.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/voidstation-certificate-renewal.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable voidstation-ingress.service voidstation-certificate-renewal.timer
sudo systemctl start voidstation-ingress.service voidstation-certificate-renewal.timer
```

Before installing the rule, verify that no unrelated network uses the `br-voidstation` interface name. The ingress helper refuses unexpected existing FORWARD ordering rather than reordering unrelated rules. It never flushes a chain, deletes a rule, or changes UFW. Preflight checks the active rules, the enabled startup dependency, and the renewal timer. Inspect boot ordering without rebooting the Server.

For the previous LAN release, remove its Dashboard container before starting this release. The old default network must also be recreated to obtain the named bridge. Inspect `docker network inspect voidstation-app_default` first; if it contains any unrelated container, stop and resolve that conflict with its owner. After separate cutover authorization, stop/remove only the old Dashboard, remove its now-empty network, and run `npm run docker:up`. Never leave the old unauthenticated instance running as a fallback. Rollbacks must retain the login/HTTPS/ingress boundary; do not restore the old LAN publication.

## Check and deploy

```sh
npm ci
npm run typecheck
npm run docker:check
npm run docker:up
npm run docker:logs
```

`docker:check` reads Compose, Docker, Tailscale status, certificate metadata, firewall rules, and filesystem metadata. It also checks mounted inputs as UID/GID 1000 with supplementary groups cleared, so root's permissions cannot hide an access failure. It does not create directories, obtain a certificate, alter Tailscale, or displace a service. It rejects a remote Docker context, a non-Tailscale publication, wildcard or LAN publication, an unexpected service, unsafe Compose overrides, extra mounts, root execution, capabilities, privilege escalation, changed listener/origin/auth paths, a mismatched hostname, invalid or mismatched certificate/key, Funnel, missing probes, or a conflicting port.

`docker:up` runs preflight before and after both image builds. It updates only `dashboard` and `assistant-worker`, then inspects both containers and waits up to 30 seconds for a running Dashboard and a certificate-verified HTTPS login response. Keep the prior secure revision/image until verification passes. A failed postdeploy check requires owner investigation; it is not a reason to weaken TLS or mount permissions. Do not use `git reset --hard` over local work.

Preflight resolves the effective Compose configuration and checks the worker build path, internal URL, shared token mount, separate conversation and credential mounts, UID 1000 ownership, modes, read-only root filesystem, dropped capabilities, and lack of host publication. It does not read an existing Pi installation or provider credential. CI builds the worker from its package lock and inspects the resulting runtime image separately.

## Encrypted backup and restore

Stop both containers before taking or restoring a snapshot. Keep the archive owner-only and encrypted. `age` is one suitable tool. It prompts for a passphrase and does not put it in command history.

```sh
mkdir -p "$HOME/voidstation-backups"
docker compose --project-name voidstation-app stop dashboard assistant-worker
sudo tar -C /var/lib/voidstation -cf - auth conversations worker-credentials worker-token \
  | age -p > "$HOME/voidstation-backups/voidstation-$(date +%F).tar.age"
```

Restore only after separately confirming the archive and passphrase. Leave both containers stopped. Extract into `/var/lib/voidstation`, restore `auth`, `conversations`, and `worker-credentials` to UID/GID 1000 mode 0700, and restore `worker-token` to UID/GID 1000 mode 0600. Then run `npm run docker:check` before `npm run docker:up`.

A restore preserves saved history but does not restart a turn. Treat restored unfinished turns as interrupted and reconcile their effects before a new request. Do not replay transcript tool calls. Future action approvals must remain subject to their expiry and current-service recheck. Deleting an idle conversation must remove its transcript and associated future action and approval records, but never undo media already changed by an approved action.

## Bootstrap and recovery

After the first successful deployment, create the sole local owner account from an interactive terminal. The command hides password input by default.

```sh
docker compose --project-name voidstation-app run --rm --no-deps dashboard \
  node scripts/owner.ts bootstrap
```

If a password must come from an approved secret handoff, use standard input. Do not put it in shell history, `.env`, Compose, or a process argument.

```sh
printf '%s' "$NEW_OWNER_PASSWORD" | docker compose --project-name voidstation-app run --rm --no-deps dashboard \
  node scripts/owner.ts bootstrap --password-stdin
```

Administrative recovery resets the owner password and invalidates every application session:

```sh
docker compose --project-name voidstation-app run --rm --no-deps dashboard \
  node scripts/owner.ts recover
# or: printf '%s' "$NEW_OWNER_PASSWORD" | docker compose --project-name voidstation-app run --rm --no-deps dashboard \
#   node scripts/owner.ts recover --password-stdin
```

An "already exists" bootstrap error means the account is configured; it did not replace the existing password. Do not repeat the cutover to retry verification. Use the existing account, or explicitly choose recovery if its password is lost.

The `bootstrap` and `recover [--password-stdin]` commands use `VOIDSTATION_AUTH_DB`, which Compose fixes at `/var/lib/voidstation/auth.sqlite`. Do not override that path.

## Verify exposure and HTTPS

Use a Tailscale peer to open `VOIDSTATION_ORIGIN`, sign in, and verify the Dashboard. For a local TLS check that does not depend on name resolution, replace the placeholders with values from `.env`:

```sh
curl --noproxy '*' --resolve name.tailnet.ts.net:PORT:TAILSCALE_IP \
  --fail https://name.tailnet.ts.net:PORT/login
if curl --noproxy '*' --max-time 5 http://TAILSCALE_IP:PORT/; then
  echo 'Unsafe: plaintext HTTP returned a response' >&2
  exit 1
fi
```

The first request should negotiate the certificate for the Tailscale name and return the login page. The second must not receive an HTTP response because the published port speaks TLS only. Do not use `-k` for the certificate check.

Inspect the actual Docker publication and hardening:

```sh
cid=$(docker compose --project-name voidstation-app ps -q dashboard)
docker inspect "$cid" --format '{{json .NetworkSettings.Ports}}'
docker inspect "$cid" --format '{{.Config.User}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}} {{json .Mounts}}'
ss -ltn
```

There must be exactly one `3000/tcp` publication, on the configured `100.64.0.0/10` address and configured port. It must not show `0.0.0.0`, `::`, a LAN address, or another publication. `assistant-worker` must show no host binding for `3001/tcp`. The Dashboard uses `HOSTNAME=0.0.0.0` only inside Docker so its bridge publication works. The worker's `VOIDSTATION_WORKER_HOST=0.0.0.0` is only its bridge listener, not a host publication. The launcher defaults to loopback when Compose does not set `HOSTNAME`.

Both images run as UID/GID 1000 with all capabilities dropped, no-new-privileges, a read-only root filesystem, and a restricted `/tmp` tmpfs. The Dashboard has five unchanged read-only metrics mounts, a writable UID-1000 auth bind, a read-only TLS bind, and the read-only worker token. The worker has only that read-only token plus writable UID-1000 conversation and credential binds.

An owner-authorized local packet check is available after deployment:

```sh
sudo python3 scripts/verify-ingress.py \
  --origin https://name.tailnet.ts.net \
  --tailscale-ip TAILSCALE_IP --container-ip DASHBOARD_CONTAINER_IP
```

It first requires certificate-verified host HTTPS access, then creates a disposable namespace and veth pair to send real non-Tailscale requests. Both probes must time out and increase a matching drop counter. The published-address probe must hit the first DOCKER-USER rule. For the direct-container probe, either that rule or Docker's earlier raw/PREROUTING rule qualifies. The earlier rule must match the inspected container IP exactly and exclude ingress from `br-voidstation`; unrelated, ambiguous, or unchanged counters do not qualify. It removes only its own network objects, and refuses an existing route conflict. It does not alter firewall rules, forwarding settings, or existing routes/interfaces. This exercises the ingress rule, not remote DNS or tailnet ACLs.

From a separate LAN client without Tailscale, verify even a request routed to the Tailscale address with the correct HTTPS hostname cannot connect. From an authorized Tailscale peer, verify that it can. Inspect the DOCKER-USER rule counters to confirm which rule handles the refused attempt. The Docker host administrator remains trusted; local host processes can access container networks.

Preflight cannot prove router forwarding, UPnP, tailnet ACL policy, DNS resolution from another peer, physical network reachability, or that no owner later enables Funnel. The owner must separately authorize any cutover and verify from an off-LAN Tailscale device that the HTTPS origin works and that no public forwarding path exists. Record unavailable checks instead of assuming a firewall protects Docker-published ports.

If a packet probe times out without increasing the expected counter, verification remains incomplete. Add `--diagnostics` to capture read-only raw-table counters, forwarding counters, test-interface statistics, and route lookup results. These private snapshots distinguish an earlier firewall drop from a delivery problem. They do not relax the pass criteria. Keep the output in an owner-only local report.

## Authenticated metrics smoke check

Run this from an interactive terminal on the Server. Before prompting, it requires a canonical HTTPS `.ts.net` origin matching this Server's running Tailscale identity. It reads the existing owner's password with echo disabled, creates a temporary session, runs the comparison, and attempts logout afterward. It does not bootstrap or reset the account.

```sh
python3 scripts/verify-owner-metrics.py https://name.tailnet.ts.net ROOT_PROBE DATA_PROBE
```

Errors identify terminal input, login HTTP status, or session handling without printing credentials. HTTP 401 means login was rejected; HTTP 429 means wait before retrying. The lower-level `scripts/docker-smoke.py` also accepts an approved test session through `VOIDSTATION_SMOKE_COOKIE`, without logging it.

The script disables proxy use and performs the same independent host comparison as the prior deployment check. Keep raw output under ignored `artifacts/`. Do not commit cookies, IP addresses, certificate paths, UUIDs, or auth data.

## Encrypted backup and restore

Use an owner-controlled terminal and an installed `age` binary. These commands stop only Voidstation. Choose a private backup directory and the owner's public age recipient. Do not run backup or restore during active work unless interruption is intended.

```sh
set -o pipefail
export BACKUP=/path/to/private/voidstation-backup.tar.age
export AGE_RECIPIENT=age1... # Public recipient, not a provider credential.
umask 077
docker compose stop dashboard assistant-worker
sudo tar -C /var/lib/voidstation -cf - auth conversations worker-credentials worker-token \
  | age -r "$AGE_RECIPIENT" -o "$BACKUP"
# Check that the entire pipeline completed successfully before restarting.
docker compose start assistant-worker dashboard
```

Substitute the configured host state paths if they differ from the documented defaults. Stopping both containers gives SQLite, application records, Pi transcripts, and credentials one consistent backup point. Never archive these directories unencrypted. Retained backups still contain deleted conversations. Set a retention period and remove expired encrypted backups yourself; automated retention is not implemented.

To restore a trusted backup, stop both containers first. Preserve the current state as a separate encrypted backup before replacing it. Decrypt and extract into an empty, owner-only staging directory, not on top of running databases:

```sh
export RESTORE=/path/to/private/restore-staging
export AGE_IDENTITY=/path/to/private/age-identity
install -d -m 0700 "$RESTORE"
age -d -i "$AGE_IDENTITY" "$BACKUP" | tar -xf - -C "$RESTORE"
```

Verify the staged directories are `auth`, `conversations`, and `worker-credentials`, plus `worker-token`. Replace the stopped deployment's corresponding state with those entries. Restore UID/GID 1000 ownership, directory mode 0700, and token mode 0600. Keep provider credentials only in the worker credential directory. Run `npm run docker:check` before restarting. Worker startup marks unfinished turns interrupted and never replays them. Future action and approval records must follow this same deletion, backup, and reconciliation lifecycle; a restored approval must never become an execution queue.

## Local HTTPS launcher

For local launcher tests, build first and provide a disposable certificate and key. The launcher binds `127.0.0.1` by default, which is intentional for local tests. Set a loopback `HOSTNAME` only when needed. It always needs an HTTPS `VOIDSTATION_ORIGIN`, `VOIDSTATION_TLS_CERT`, and `VOIDSTATION_TLS_KEY`.

```sh
npm run build
VOIDSTATION_ORIGIN=https://voidstation.test-tailnet.ts.net:3443 \
VOIDSTATION_TLS_CERT=/tmp/cert.pem VOIDSTATION_TLS_KEY=/tmp/key.pem PORT=3443 \
node scripts/https-server.mjs
```
