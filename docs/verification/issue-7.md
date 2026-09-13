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

## Production cutover preparation

Issue #7 was reopened because the earlier SSH-tunnel test did not complete the production deployment. The owner authorized preparation of a Voidstation-only HTTPS cutover with no reboot or unrelated service restarts.

The owner-run read-only host audit found Docker's DOCKER-USER jump first in FORWARD and an empty DOCKER-USER chain. UFW is installed but inactive. The old LAN/HTTP Dashboard remains running until the cutover is explicitly confirmed. Private audit output and the owner-run wizard are in ignored `artifacts/issue-7-cutover/`.

New host-support scripts install the narrow ingress rule before Docker startup and renew the certificate on a timer. The wizard requires explicit approval for the Docker startup dependency, including its fail-closed effect if policy loading fails. Preflight now checks that dependency and the active renewal timer. An owner-authorized namespace probe can verify real non-Tailscale drops without modifying existing interfaces or firewall rules.

Preparation also found and fixed an owner CLI hang and prompt-echo race during terminal password entry. A pseudo-terminal regression test verifies successful exit without password echo.

Follow-up checks: `npm test` passed all 93 tests, `npm run typecheck` passed, and the revised Docker image built successfully. Its owner bootstrap CLI passed in a disposable, network-disabled, read-only container as UID/GID 1000. The owner wizard passed Bash syntax checks, all six embedded Python blocks parsed, and its shared library matches the template unchanged.

Review fixes include serialized certificate replacement, a persistent restart obligation after renewal failure, private TLS-directory permissions, and one provisioning path shared by the wizard and runbook. The wizard offers an authenticated host-metrics comparison with a private, short-lived session, followed by the packet-level ingress check. At that preparation checkpoint, neither live check had run. Standards and Spec/security reviews passed after fixes, including a resumed-run edge: renewal activation now waits until the owner has approved Dashboard interruption.

Those preparation checks did not themselves prove a live cutover. The owner-run execution below happened afterward.

## Owner-run cutover and incomplete verification

The owner ran the wizard through deployment and account bootstrap. Stage 5 passed post-deploy inspection but failed the authenticated smoke check with a generic error. The isolated packet probe timed out without increasing the expected DOCKER-USER counter. A subsequent bootstrap attempt correctly refused to overwrite the account.

Read-only follow-up inspection confirmed:

- The Dashboard is running with a single publication on the Server's Tailscale IPv4, port 443. The old port-3000 publications are gone.
- Python reaches `/login` with HTTP 200 and normal certificate verification.
- The dedicated bridge is `br-voidstation`; the ingress service and renewal timer are active and enabled.
- All 12 unrelated containers in the latest wizard baseline retained their IDs, start times, and restart counts. Docker and Tailscale process identities also match that baseline.

Neither verification failure proves its cause. The authenticated-check error hid the failing phase; the updated CLI reports terminal, HTTP, and session errors without credentials. A synthetic HTTPS/terminal test verifies host-only secure-cookie handling, logout, and error reporting. This does not establish why the owner's particular login attempt failed.

The packet verifier now identifies each probe separately and offers private read-only diagnostics for earlier firewall counters, interface traffic, and routing. It still refuses to treat a timeout alone as proof of ingress protection. The agent cannot repeat the privileged probe unattended because sudo requires the owner's password.

A separate owner-run verification-only wizard is prepared under ignored `artifacts/issue-7-cutover/verify-only.sh`. It does not rebuild, redeploy, install services, change firewall rules, bootstrap, or reset the password. The ticket remains open. The follow-up changes passed all 95 tests, typecheck, and Standards/Spec security reviews. The owner-metrics CLI now validates the local Tailscale identity before requesting a password.

## Remaining deployment verification

- Determine why the packet counter did not increase and complete real ingress verification. No firewall changes have been made by the agent to hide or bypass this failure.
- Verify HTTPS and login from a desktop/mobile Tailscale client, including an off-LAN peer. Confirm a device without Tailscale cannot reach the application through the LAN address or by routing to its Tailscale/container address with the correct HTTPS hostname.
- Check tailnet ACLs, router/UPnP forwarding, alternate proxies, and Funnel. Local Docker configuration cannot prove absence of every external forwarding path.
- Repeat authenticated host/API measurement comparisons, crash recovery, boot-order inspection, and unrelated-service continuity checks.

The provisioning and recovery procedure is in [the deployment runbook](../deployment.md). Earlier issue #5 evidence concerns the superseded LAN/HTTP release and is not evidence of this cutover.
