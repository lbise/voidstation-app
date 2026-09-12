# Issue #7 verification

## Local automated checks

Final checks passed: `npm run typecheck`, production build, `npm test` with 73 tests across five files, and `git diff --check`. The two-axis code review's deployment findings were fixed and rechecked.

The production HTTPS lifecycle uses disposable Linux-format metrics inputs, a private owner database, and a self-signed certificate trusted only by its test client. It covers anonymous pages and metrics, future Assistant paths, login assets, correct and incorrect passwords, cookie attributes, forged cookies, logout replay, recovery of multiple sessions, concurrent owner-wide rate limiting, Origin rejection, and plaintext HTTP rejection. Existing host measurements and Dashboard loading, stale, unavailable, and recovery tests remain in the suite.

Owner CLI tests cover bootstrap, repeated bootstrap refusal, password validation, explicit stdin, recovery, and private database permissions. Deployment CLI tests substitute Docker, Tailscale, OpenSSL, and filesystem ownership at external boundaries. They exercise safe configuration and rejection of LAN publication, extra services, command/capability/environment overrides, replacement builds, external networks, noncanonical origins, hostname/certificate mismatch, missing Docker ingress protection, runtime-UID access failure, and Funnel. Postdeploy coverage uses a real local CA-signed HTTPS login server and verifies the request hostname and certificate validation. These tests do not prove the Server's live configuration.

## Agent-browser

Verified against the production TLS launcher on local loopback with disposable credentials, at desktop 1440 by 1000 and mobile 375 by 812:

- Anonymous Dashboard navigation redirects to login with no Server details.
- Wrong password shows an accessible error; correct password opens the Dashboard.
- Dashboard navigation and sign-out work at both sizes. Revisiting `/` after logout shows login.
- Administrative recovery revokes a displayed Dashboard session. Its next metrics poll redirects to login instead of retaining stale private readings.
- Mobile login has no horizontal overflow. CPU, RAM, Disk space, and Uptime remain in the Dashboard.

Screenshots are in ignored `artifacts/issue-7/`: `login-desktop.png`, `login-mobile.png`, `dashboard-desktop.png`, and `dashboard-mobile.png`. These are local machine readings, not measurements of the home Server.

Chromium's sandbox could not start under this environment's user-namespace policy. The isolated verification browser used `--no-sandbox` and `--ignore-https-errors` only against the disposable local HTTPS origin. The HTTP tests validate their temporary certificate through an explicit CA instead. No production certificate validation was disabled.

## Disposable Docker image

Built `voidstation-issue7-check` and ran an isolated, hardened container with a loopback-only HTTPS publication. Container-side bootstrap worked. Wrong login returned 401, correct login returned 200 with a secure session cookie, metrics changed from 401 to 200 after login, recovery invalidated the old cookie, and plaintext HTTP failed. Docker inspection confirmed UID 1000, read-only root, dropped capabilities, no-new-privileges, restricted tmpfs, and narrow mounts. The disposable container and temporary inputs were removed. This verifies the package, not the live Tailscale publication.

## Deployment limits

No live access cutover, Tailscale changes, certificate provisioning, reboot, or disruption of unrelated services was authorized or performed. The old local `.env` was left untouched and must be migrated by the owner before deployment.

Still requires owner authorization and host-specific verification:

- Provision the Tailscale hostname certificate and its renewal procedure, bootstrap the persistent account, and run preflight with the real filesystem UUID and dedicated paths.
- Authorize and install the narrow DOCKER-USER ingress rule. Persist it before Docker container startup and verify its ordering. This agent did not modify the firewall or test real packets against that rule.
- Replace the old LAN/HTTP publications and inspect the running container, including plaintext requests to its IP. Do not leave the prior unauthenticated release running alongside this one.
- Verify HTTPS and login from a desktop/mobile Tailscale client, including an off-LAN peer. Confirm a device without Tailscale cannot reach the application through the LAN address or by routing to its Tailscale/container address with the correct HTTPS hostname.
- Check tailnet ACLs, router/UPnP forwarding, alternate proxies, and Funnel. Local Docker configuration cannot prove absence of every external forwarding path.
- Repeat authenticated host/API measurement comparisons, crash recovery, boot-order inspection, and unrelated-service continuity checks.

The provisioning and recovery procedure is in [the deployment runbook](../deployment.md). Earlier issue #5 evidence concerns the superseded LAN/HTTP release and is not evidence of this cutover.
