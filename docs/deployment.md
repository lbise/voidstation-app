# LAN and Tailscale HTTPS deployment

Issue [#13](https://github.com/lbise/voidstation-app/issues/13) replaces the Tailscale-only policy from #7. The same production Dashboard and Assistant are reachable through two explicitly configured HTTPS origins. LAN clients do not need Tailscale. Both listeners use the same local owner account and durable state. Separate browser logins are normal because the session cookies are host-only.

Use `./deploy.sh` for production updates. `npm run dev:network` is a separate development server, not a production deployment command. Stopping or updating development must not rebuild, restart, or replace production containers or write their state.

This runbook does not authorize live changes. Obtain approval before installing device trust, provisioning certificates, changing the firewall or its boot dependencies, or interrupting production. Earlier reports under `docs/verification/issue-5.md`, `issue-7.md`, and `issue-8.md` remain historical, not evidence that this policy has been deployed.

## Access decision

The owner selected the Server's reserved RFC1918 IPv4 address and port 3000 for LAN HTTPS, with a dedicated production private CA trusted on the owner's Arch Linux desktop/laptop and Android phone. Keep actual addresses in the private `.env`, not verification reports. The trusted LAN path is the owner's Ethernet interface and its configured subnet, not every private network on the Server.

| Path | Browser URL | Docker destination | Certificate |
| --- | --- | --- | --- |
| Tailscale | `VOIDSTATION_ORIGIN` | Dashboard `3000/tcp` | Existing local `.ts.net` identity |
| LAN | `VOIDSTATION_LAN_ORIGIN` | Dashboard `3443/tcp` | IP SAN signed by the dedicated production CA |

The preferred LAN URL is `https://LAN_IP:3000`. The Tailscale URL normally uses port 443. Two TLS listeners in one process avoid SNI ambiguity for IP-address URLs. Neither listener accepts the other listener's Host. There is no plaintext application listener or HTTP redirect. The internal authenticated worker still uses HTTP only within the Compose bridge and has no host publication.

No router DNS changes, DDNS, public proxy, Tailscale Serve, or Funnel are needed. Do not forward either port on the router or expose it through UPnP. Router policy and physical client reachability require owner verification.

## Requirements and configuration

Run on the Ubuntu Server as host UID 1000 with the local Docker socket. Required tools are Docker Engine with the iptables backend, Compose, Node.js 24, Python 3, OpenSSL, `findmnt`, `ss`, `ip`, `setpriv`, Bash, and Tailscale. Docker Desktop, remote Docker contexts, Docker's native nftables firewall backend, and reverse-proxy termination are unsupported. Preflight uses read-only privileged checks through `sudo -n`; run `sudo -v` in the owner's terminal first.

Copy `.env.example` to the ignored `.env`. Do not overwrite existing auth, worker, metrics, or TLS paths during migration. Configure:

- `VOIDSTATION_TAILSCALE_BIND_ADDRESS`: the Server's assigned Tailscale CGNAT IPv4 address from `tailscale status --json`.
- `VOIDSTATION_PORT`: its HTTPS host port, normally 443.
- `VOIDSTATION_ORIGIN`: exact lowercase HTTPS origin using this Server's `Self.DNSName`, without the trailing DNS dot. Include the port unless it is 443.
- `VOIDSTATION_LAN_BIND_ADDRESS`: the reserved LAN IPv4 address assigned to the approved Ethernet interface.
- `VOIDSTATION_LAN_HTTPS_PORT`: 3000, unless an overlapping listener requires a separately agreed port.
- `VOIDSTATION_LAN_ORIGIN`: exact `https://LAN_IP:PORT`, with no path, query, credentials, or trailing slash. Omit port 443 only when configured.
- `VOIDSTATION_LAN_INTERFACE`: the approved physical LAN interface, not a bridge, tunnel, loopback, or wildcard.
- `VOIDSTATION_LAN_SOURCE`: the approved canonical RFC1918 CIDR containing that address. Do not allow all RFC1918 ranges or `0.0.0.0/0`.
- `VOIDSTATION_LAN_TLS_DIRECTORY`: dedicated LAN certificate directory, default `/var/lib/voidstation/lan-tls`.

Preflight checks the actual assigned interface/address and both Docker bindings. A loopback-only native listener on port 3000 does not overlap a LAN-only publication, but a wildcard listener does. Never stop an unrelated service to free a port without its owner's approval.

Keep the two existing empty metrics probe directories. The root probe belongs to `/`; the data probe must belong to the configured separate filesystem and match its UUID. They are read-only inputs, not storage directories.

### Persistent state

Create these only for a new deployment. An update must reuse the existing directories and token, not bootstrap another owner or replace working credentials.

```sh
sudo install -d -o 1000 -g 1000 -m 0700 /var/lib/voidstation/auth
sudo install -d -o 1000 -g 1000 -m 0700 /var/lib/voidstation/conversations
sudo install -d -o 1000 -g 1000 -m 0700 /var/lib/voidstation/worker-credentials
# New deployments only. Never regenerate an existing worker token during an update.
sudo sh -c 'umask 077; head -c 48 /dev/urandom | base64 -w 0 > /var/lib/voidstation/worker-token'
sudo chown 1000:1000 /var/lib/voidstation/worker-token
sudo chmod 0600 /var/lib/voidstation/worker-token
```

The worker token is a file with at least 32 non-whitespace characters, not an environment value. Do not put it in logs, shell arguments, or browser responses. Conversation transcripts and private provider refresh state stay in separate worker-owned directories, distinct from Dashboard authentication. Complete the worker's [independent device-code login](../worker/README.md#codex-login) from an owner-controlled terminal. To enable OpenRouter, install its API key as `/var/lib/voidstation/worker-credentials/openrouter-api-key` with owner UID/GID 1000 and mode `0600`, then restart the worker. Never copy the Server's development Pi or Codex credentials.

### Media service configuration

The Assistant can find titles, inspect the Managed library, configure monitoring and quality, and start explicit download searches. It does not delete titles or expose arbitrary Radarr/Sonarr API requests. Create the worker-only directory with mode `0700`, owned by UID/GID 1000:

```sh
sudo install -d -o 1000 -g 1000 -m 0700 /var/lib/voidstation/media
sudo install -o 1000 -g 1000 -m 0600 /path/to/media-config.json /var/lib/voidstation/media/config.json
sudo install -o 1000 -g 1000 -m 0600 /path/to/radarr-key /var/lib/voidstation/media/radarr.key
sudo install -o 1000 -g 1000 -m 0600 /path/to/sonarr-key /var/lib/voidstation/media/sonarr.key
```

Use `/run/voidstation-media/radarr.key` and `/run/voidstation-media/sonarr.key` as the `keyFile` values inside the container config. The config must contain both services, HTTPS or HTTP endpoints without credentials or query strings, normalized root folders, positive profile IDs, and explicit quality mappings. The preflight validates those resources and the worker validates them again against each service. Do not put API keys, provider credentials, or real endpoint secrets in `.env`, chat, logs, or source control. A clean example is in `.env.example`; the actual JSON stays outside the repository.

Update shared skills from a committed dotfiles revision, then verify the resulting snapshot:

```sh
python3 scripts/update-worker-skills.py --update --source-root /path/to/dotfiles
python3 scripts/update-worker-skills.py --check
npm ci --prefix worker
```

The command records the dotfiles revision and SHA-256 files in `worker/skills/`. The worker image copies this snapshot and its fixed Python adapters into a read-only image layer. Runtime changes require an image rebuild. Do not mount the development Pi, dotfiles checkout, or a writable skill directory into the worker.

### Certificates

Run `scripts/setup-lan-certificates.sh` on the Arch laptop for scripted issuance/renewal, SSH transfer, and optionally Server installation. Follow [the per-machine certificate instructions](lan-certificates.md) for secure key storage, Arch/Android trust, and recovery. Mount only `cert.pem`, `key.pem`, and the public `ca.pem`; the CA signing key stays offline. Preflight verifies the IP, server purpose, CA chain, expiry, and key pair. A valid chain on the Server does not prove a phone trusts the CA. Verify each actual client without warning bypasses.

Keep Tailscale issuance and its renewal timer. Replace `name.tailnet.ts.net` below with the exact hostname from `VOIDSTATION_ORIGIN`:

```sh
sudo install -d -o root -g root -m 0755 /usr/local/libexec
sudo install -o root -g root -m 0755 scripts/host/voidstation-renew-certificate.sh /usr/local/libexec/voidstation-renew-certificate
sudo /usr/local/libexec/voidstation-renew-certificate --provision name.tailnet.ts.net
```

Provisioning records the hostname in root-owned `/etc/voidstation/hostname` and installs certificates under `/var/lib/voidstation/tls`. It does not restart production. The TLS directory is root-owned, group 1000, mode 0750; its private key is UID/GID 1000 mode 0600. Both certificate mounts are read-only inside the Dashboard.

The existing daily Tailscale renewal helper checks hostname, expiry, and key matching before replacing a pair. It serializes manual/timer runs with `flock`, restarts only the running Dashboard when a changed certificate needs reloading, and records failed restarts for retry. A healthy unchanged certificate causes no restart. Inspect `systemctl status voidstation-certificate-renewal.timer` and `journalctl -u voidstation-certificate-renewal.service`.

LAN renewal is owner-initiated with the password-protected CA on the laptop. Re-run the certificate wizard with the same state directory. Set a reminder 60 days before expiry; preflight refuses a leaf within 30 days of expiry. Certificate trust changes, initial signing, and certificate replacement remain owner-controlled.

## Persistent ingress and first cutover

Docker's destination bind address is insufficient: another interface can route packets to that address. The policy checks ingress interface, source subnet, translated container port, and conntrack's original destination address/port together. The dedicated bridge is `br-voidstation`; no unrelated workload may use it.

The first FORWARD rule must jump to DOCKER-USER. Its first rule sends traffic destined for `br-voidstation` to the dedicated `VOIDSTATION` chain. That chain permits reply traffic and internal bridge communication, then only these inbound paths:

- `tailscale0`, source `100.64.0.0/10`, original destination equal to the configured Tailscale publication, translated port 3000.
- The configured LAN interface and source CIDR, original destination equal to the configured LAN publication, translated port 3443.

Everything else destined for this bridge is dropped. In particular, LAN packets routed to the Tailscale address, an unapproved interface or source, direct Dashboard container-IP connections, and direct worker connections are not alternative access paths. Local host administrators remain trusted and can access Docker networks.

The host policy uses root-owned mode-0600 `/etc/voidstation/ingress.json`, under a root-owned non-writable directory. Its values must exactly match `.env` and effective Compose configuration. The shape is:

```json
{
  "lanInterface": "eno1",
  "lanSource": "192.168.50.0/24",
  "lanAddress": "192.168.50.10",
  "lanPort": 3000,
  "tailscaleAddress": "100.101.102.103",
  "tailscalePort": 443
}
```

These are examples, not the owner's addresses. Do not copy them unchanged. The helper does not source shell text from the configuration file.

Before changes, capture owner-only read-only snapshots of `iptables -S FORWARD`, `iptables -S DOCKER-USER`, the existing ingress helper/unit, effective Compose configuration, current Dashboard and worker image IDs, mounts, and network membership. Preserve the prior secure revision and images. Never flush chains, change UFW defaults, reorder unrelated rules, or restart Docker to install the policy.

After separate approval, install reviewed root-owned copies of the helper and units. Root services must not execute scripts from the writable checkout:

```sh
sudo install -d -o root -g root -m 0755 /usr/local/libexec /etc/voidstation
sudo install -o root -g root -m 0755 scripts/host/voidstation-ingress.sh /usr/local/libexec/voidstation-ingress
sudo install -o root -g root -m 0644 deploy/voidstation-ingress.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/voidstation-certificate-renewal.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/voidstation-certificate-renewal.timer /etc/systemd/system/
# Install the reviewed private ingress.json with owner-approved values first.
sudo install -o root -g root -m 0600 /path/to/private/ingress.json /etc/voidstation/ingress.json
```

The helper's migration option is an explicit owner-run operation, not something deployment performs automatically. It replaces only the known legacy Voidstation rule after installing the restricted new chain. Unexpected existing ordering or chain contents are a stop condition, not permission to overwrite them.

```sh
# Only after the owner approves the policy migration:
sudo /usr/local/libexec/voidstation-ingress --migrate
sudo /usr/local/libexec/voidstation-ingress --check
```

The ingress service remains required before Docker startup and participates in Docker restarts. If it cannot establish the policy, Docker startup fails. Retain this fail-closed dependency and obtain approval for the host-wide startup consequence. Installing units does not itself authorize a Docker restart.

```sh
sudo systemctl daemon-reload
sudo systemctl enable voidstation-ingress.service voidstation-certificate-renewal.timer
sudo systemctl start voidstation-ingress.service voidstation-certificate-renewal.timer
```

A first dual-access cutover cannot pass a before-update LAN probe against the old Tailscale-only listener. Use the deployment command's explicit cutover option only during the separately approved first LAN migration. It still requires the existing Tailscale login probe to pass. Normal updates must not silently skip before-update probes. Install certificates and device trust first, inspect ingress, then perform the cutover. Do not bootstrap a new owner, recreate storage, remove unrelated networks, or fall back to the former unauthenticated LAN release.

```sh
# This acknowledgment is not a substitute for the owner's approval.
VOIDSTATION_INITIAL_LAN_CUTOVER=approved ./deploy.sh --cutover
```

`deploy.sh` fast-forwards from `origin/main` before invoking the checked deployment command. Publish the reviewed revision first. It does not push local commits. Do not invoke it from an unreviewed or dirty checkout during cutover.

## Check and update

```sh
npm ci
npm ci --prefix worker
npm run typecheck
npm run typecheck --prefix worker
npm run docker:check
./deploy.sh
npm run docker:logs
```

Preflight resolves effective Compose configuration and rejects extra services, environment overrides, unsafe publication, invalid origins, mismatched certificates or policy, Funnel, inaccessible state, unexpected mounts, root execution, added capabilities, privilege escalation, or conflicting ports. It checks mounted inputs as UID/GID 1000 with supplementary groups cleared, so root's permissions cannot hide runtime failures.

Production updates check both existing HTTPS paths before changes, build only Dashboard and assistant-worker, inspect the built worker, and recheck configuration. They update the worker without forcing an unchanged image to restart, then recreate the Dashboard so changed certificate files load even when its image is unchanged. Postdeploy inspects both containers and requires certificate-verified login responses on both paths. `ca.pem` supplies trust only for the LAN probe; Tailscale uses normal public trust. Do not use `-k`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `next start`, or permissive CORS as a workaround. A failed probe must identify the path that failed. A successful Server-local probe does not prove remote reachability.

Both containers run as UID/GID 1000 with all capabilities dropped, no-new-privileges, read-only code, and a restricted `/tmp` tmpfs. The Dashboard retains its five narrow read-only metrics mounts, writable auth bind, read-only token, and two read-only TLS mounts. The worker has only the read-only token plus separate writable conversation and credential binds. Neither has a Docker socket or development workspace. The worker has no host port, TLS keys, Dashboard auth database, or host-metrics mounts.

### Rollback

Do not automate rollback over local work or use `git reset --hard`. `deploy.sh` pulls `origin/main`, so checking out an older revision and invoking it is **not** a rollback. Routine updates use `./deploy.sh`; the separately approved emergency procedure below restores saved images without pulling or building source.

Before changing the previous deployment's checkout or `.env`, capture its effective configuration and immutable running image IDs from that previous secure checkout. Use an owner-only directory outside the repository. Never make a rollback snapshot from the old unauthenticated HTTP release.

```sh
export ROLLBACK_DIR=/path/to/private/voidstation-rollback
install -d -m 0700 "$ROLLBACK_DIR"
umask 077
python3 - <<'PY'
import json, os, pathlib, subprocess
compose = ['docker', 'compose', '--project-name', 'voidstation-app']
config = json.loads(subprocess.check_output(compose + ['config', '--format', 'json']))
if not set(config['services']).issubset({'dashboard', 'assistant-worker'}):
    raise SystemExit('Unexpected services: stop and inspect.')
for service in list(config['services']):
    ids = subprocess.check_output(compose + ['ps', '--quiet', service], text=True).split()
    if not ids and service == 'assistant-worker':
        del config['services'][service]
        continue
    if len(ids) != 1:
        raise SystemExit('Expected one running container for ' + service)
    container = json.loads(subprocess.check_output(['docker', 'inspect', ids[0]]))[0]
    config['services'][service].pop('build', None)
    config['services'][service]['image'] = container['Image']
output = pathlib.Path(os.environ['ROLLBACK_DIR']) / 'compose.json'
if output.exists():
    raise SystemExit('Refusing to overwrite an existing rollback snapshot.')
output.write_text(json.dumps(config, indent=2) + '\n')
output.chmod(0o600)
PY
```

Review the snapshot against `docker inspect` before accepting it. In particular, confirm the publication, mount sources, listener environment, and hardening describe the **running** secure deployment, not unshipped Compose edits. Retain its image IDs locally and do not prune them. Keep an encrypted state snapshot and the prior valid certificate pairs separately. If no known-good configuration snapshot exists, stop and reconstruct one from the saved inspection evidence with the owner; do not guess at bind mounts.

After explicit rollback authorization, stop only Voidstation's active work, then recreate from the saved configuration. This uses current durable state; it does not restore an older database or replay conversation turns.

```sh
# Stop the current project services that are running. No other workloads.
docker compose --project-name voidstation-app stop dashboard assistant-worker
docker compose --project-name voidstation-app \
  --file "$ROLLBACK_DIR/compose.json" up --no-build --pull never --force-recreate -d --no-deps
```

For a prior dual-access deployment, verify both certificate-verified login paths and inspect the resulting containers. The current `node scripts/deployment-preflight.mjs --postdeploy` can verify it when current `.env` describes exactly the restored configuration. Do not treat a preflight failure as permission to weaken security.

For the first migration, the saved secure configuration may support only Tailscale. Restoring it is an acceptable temporary loss of LAN access, not permission to restore HTTP or remove login. Retain the new restricted ingress policy: the old Tailscale publication still matches its allowed path, and the absence of a LAN listener leaves LAN access closed. The saved configuration must have no LAN publication when its image lacks the LAN listener. A worker absent from the saved configuration stays stopped. Ensure Tailscale renewal still matches the retained certificate. Verify Tailscale TLS/login, actual mounts/publication/hardening, and plaintext/backend refusal; record LAN as unavailable. Neither the old single-rule preflight nor the new dual-listener preflight can certify this transitional combination automatically. Use the saved inspection evidence and owner-reviewed runtime checks, then plan a fresh authorized cutover. Never flush or weaken the firewall to make an old check pass.

## Owner login and recovery

Only a new deployment needs bootstrap. Run from an interactive terminal; the password is hidden by default:

```sh
docker compose --project-name voidstation-app run --rm --no-deps dashboard \
  node scripts/owner.ts bootstrap
```

An "already exists" result means the owner is configured; it did not replace the password. Use the existing account. Administrative recovery resets the password and invalidates all sessions on both origins:

```sh
docker compose --project-name voidstation-app run --rm --no-deps dashboard \
  node scripts/owner.ts recover
```

Both commands also accept `--password-stdin` for an approved secret handoff. Never put the password in `.env`, arguments, logs, or shell history. Do not override the fixed in-container `VOIDSTATION_AUTH_DB=/var/lib/voidstation/auth.sqlite`.

## Encrypted backup and restore

Use an owner-controlled terminal and an installed `age` binary. Obtain approval before stopping active work. Stop only Voidstation, and keep both containers stopped throughout a snapshot so application records, SQLite, Pi transcripts, and credentials are consistent.

```sh
set -o pipefail
export BACKUP=/path/to/private/voidstation-backup.tar.age
export AGE_RECIPIENT=age1... # The owner's public age recipient, not a credential.
umask 077
docker compose --project-name voidstation-app stop dashboard assistant-worker
sudo tar -C /var/lib/voidstation -cf - auth conversations worker-credentials media worker-token \
  | age -r "$AGE_RECIPIENT" -o "$BACKUP"
# Confirm the entire pipeline succeeded before restarting.
docker compose --project-name voidstation-app start assistant-worker dashboard
```

Substitute configured host paths when they differ. Keep TLS server keys in a separate encrypted backup; keep the CA signing key's encrypted offline backup off the Server. Back up private deployment and root ingress configuration separately. Never archive private state unencrypted.

To restore, preserve current state as another encrypted snapshot first. Decrypt a trusted archive into an empty owner-only staging directory while both containers are stopped:

```sh
export RESTORE=/path/to/private/restore-staging
export AGE_IDENTITY=/path/to/private/age-identity
install -d -m 0700 "$RESTORE"
age -d -i "$AGE_IDENTITY" "$BACKUP" | tar -xf - -C "$RESTORE"
```

Verify the entries are the intended auth, conversations, worker-credentials, and media directories plus the worker-token file. Replace only corresponding stopped-deployment state. Restore directories to UID/GID 1000 mode 0700 and the token and auth database to UID/GID 1000 mode 0600. Run static preflight before restarting. For restoration into the same validated configuration, use `docker compose --project-name voidstation-app start assistant-worker dashboard`, then `node scripts/deployment-preflight.mjs --postdeploy`. If containers need replacement, use the saved-image recovery procedure above instead of bypassing ordinary update readiness checks. Check both paths afterward.

Worker startup marks unfinished turns interrupted and never replays them. Future action and approval records must follow this lifecycle: a restored approval is not an execution queue, expired approvals stay expired, and uncertain effects need current-service evidence before another request. Deleting an idle conversation removes current transcripts and associated future action/approval records, never media. Retained backups still contain deleted history. Set a retention period and remove expired encrypted backups yourself; automatic scheduling and retention are not implemented.

## Verify the release

Follow [issue #13 verification](verification/issue-13.md). A completed release needs all of these, not just local readiness:

1. Physical Arch laptop/desktop and Android browser checks on the LAN with Tailscale disabled: trusted TLS with no warning, login, Dashboard, Assistant history where available, logout.
2. An off-LAN client with Tailscale enabled: the same checks against the existing hostname and the same saved history. Do not require cross-host single sign-on.
3. Hostile Host/Origin/forwarding-header checks, plaintext refusal, direct backend/worker refusal, and publication/ingress inspection. Physical tests must include an unapproved ingress path where available.
4. Production identity and writable state unchanged after starting and stopping development. Use isolated debug credentials, not the production account or worker.
5. Router forwarding/UPnP and Tailscale ACL/Funnel inspection. Do not change unrelated network services during verification.

An owner-authorized `scripts/verify-ingress.py` packet check uses a temporary namespace to test rejection through an untrusted interface and observe matching counters. It probes both publications, both direct Dashboard ports, and the worker. It is not a physical LAN or off-LAN Tailscale client. Creation of network objects needs separate approval. It removes only its own namespace/veth objects. A timeout without the expected counter increase is incomplete evidence.

```sh
sudo python3 scripts/verify-ingress.py \
  --tailscale-origin https://name.tailnet.ts.net \
  --lan-origin https://LAN_IP:3000
```

Use the exact configured origins, including a non-default Tailscale port when required.

The existing `scripts/verify-owner-metrics.py` command is a Tailscale-origin-only diagnostic, not a dual-access release verifier. It checks the local Tailscale identity, prompts without echo, creates a temporary owner session, compares host measurements, and attempts logout. Keep it for that narrow role:

```sh
python3 scripts/verify-owner-metrics.py https://name.tailnet.ts.net ROOT_PROBE DATA_PROBE
```

No bootstrap, recovery, provider login, media mutation, reboot, firewall change, or device trust installation is implied by a verification request. Record unavailable checks explicitly and coordinate final release verification with #12.
