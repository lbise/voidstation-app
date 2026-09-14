# Issue #13 dual-access verification

This report covers the repository change for [#13](https://github.com/lbise/voidstation-app/issues/13). It is not evidence of a production cutover. Earlier reports for #5, #7, and #8 remain unchanged and describe their original releases.

## Decisions and authorization

The owner confirmed a reserved LAN IPv4 address, HTTPS port 3000, a dedicated private production CA, and manual trust installation on Arch Linux desktop/laptop and Android. The existing Tailscale hostname remains a separate HTTPS origin. Read-only inspection confirmed the LAN address/interface/subnet and the existing Tailscale-only Docker publication. A loopback listener on port 3000 did not occupy the LAN address. Actual private addresses are not recorded here.

The owner approved tests at the real application HTTP boundary, deployment and ingress commands, and development/production separation. No live cutover, certificate issuance, client trust changes, firewall changes, production container interruption, provider login, or media mutations were authorized or performed.

Issues #6 and #12 now require the clarified LAN/Tailscale access policy. Keep #13 open until owner-run cutover and physical-client checks are recorded.

## Local checks

- Application and worker typechecks passed during implementation.
- The production application and worker builds passed during implementation.
- The deployment entry-point regression test failed when `deploy.sh` dropped `--cutover`, then passed after argument forwarding was added.
- The existing host-measurement tests passed, 26 tests.
- The LAN certificate runbook's signing, chain/purpose/IP verification, minimum validity, and public-key comparison commands passed with disposable certificates in a temporary directory. Verification rejected a different IP. The temporary keys were removed; no certificate was installed in any trust store.

The first full run passed 139 tests and failed five with HTTP/dev timeouts. The Server was under memory pressure. The Assistant file subsequently passed all 16 cases alone. The dev fixture hang also reproduced in isolation: its nested checkout fixture and external dependency symlink conflicted with Turbopack's root. The fixture now uses a temporary independent root and local dependencies, with a bounded HTTP response deadline. Production development still uses the real checkout and live source edits. File-level Vitest execution is serial to avoid running multiple Next/Pi process fixtures alongside the dev compiler; scenario-level concurrency tests remain unchanged.

Final `npm test` passed **147 tests across 13 files**, including production application/worker builds, in 55 seconds. Both typechecks, the synthetic effective Compose check, shell syntax checks, and `git diff --check` passed. The certificate and rollback runbook's shell blocks and embedded Python were syntax-checked. Production Dashboard inspection still showed the original container and its pre-task start timestamp. No deployed-container rebuild, live ingress probe, or physical-browser verification was performed.

## Standards

The independent review found one issue: a dirty checkout could reach deployment despite the runbook's clean-source requirement. `deploy.sh` now rejects staged, unstaged, and untracked changes before pulling or building. The CLI regression test passed, and the reviewer confirmed resolution. No remaining Standards findings.

## Spec

The independent review found two issues: the rollback instructions would pull `main` instead of deploying the saved revision, and first cutover skipped the existing Tailscale readiness probe. The runbook now restores saved immutable image IDs and configuration without building or pulling. `--precutover` requires the existing Tailscale HTTPS login before any build and both paths after deployment. Direct preflight and driver tests assert that a failed pre-cutover probe exits nonzero and prevents builds. The reviewer confirmed both findings and the follow-up assertion gap resolved. No remaining Spec findings.

Review totals: Standards 1 finding resolved; Spec 2 findings resolved. Unauthorized live operations remain pending, not passed.

## Repeatable checks

Run without live provider credentials:

```sh
npm ci
npm ci --prefix worker
npm run typecheck
npm run typecheck --prefix worker
npm test
node scripts/compose-runtime-check.mjs
```

The automated HTTP tests use disposable certificates and temporary owner/worker state. They exercise both configured origins, origin-specific redirects and session security, Host/Origin mismatch rejection, hostile forwarding headers, authenticated mutations and streams, and shared saved conversation state. A certificate trusted explicitly by the test client is not proof that the owner's browser trusts the production CA.

Deployment tests use command-boundary fixtures rather than altering the Server's firewall or running production containers. Inspect both effective Compose and deployed-container configuration during the owner-authorized cutover. A synthetic passing fixture is not evidence that host rules, systemd units, or router forwarding match it.

## Owner-run cutover checks

Follow [the runbook](../deployment.md) and [certificate instructions](../lan-certificates.md). Confirm each operation before executing it. Preserve the previous secure images, private configuration, and an encrypted state snapshot. No fallback may remove login, use plaintext HTTP, expose the worker, or broaden ingress.

Before and after an ordinary `./deploy.sh` update, both certificate-verified login probes must pass. The explicit first-LAN-cutover mode skips only LAN readiness before deployment; it still requires the existing Tailscale login probe and both probes afterward. Owner approval must be recorded. Offline rollback uses the runbook's saved-image procedure rather than bypassing update checks. Record failures by path instead of treating one successful origin as proof of both.

Inspect the deployed Dashboard and worker with `docker inspect` and effective Compose with `docker compose --project-name voidstation-app config`. Keep raw output owner-only; it includes private deployment values. Confirm:

- Exactly the configured Tailscale-to-3000 and LAN-to-3443 TCP publications, no wildcard, IPv6, extra port, host networking, or alternate backend publication.
- No worker host binding and only the dedicated Compose bridge.
- UID/GID 1000, read-only root filesystem, all capabilities dropped, no-new-privileges, restricted tmpfs, and the expected narrow read-only/writable mounts.
- The same owner database, worker token, conversations, and worker credential paths before and after replacement.
- The first FORWARD and DOCKER-USER rules, exact dedicated ingress chain, root-owned persistent policy configuration, enabled startup dependency, and certificate-renewal timer.

### Physical-client matrix

All rows below remain **not performed**. A local container, browser viewport, or namespace does not substitute for these vantage points.

| Client | Network | Required check | Status |
| --- | --- | --- | --- |
| Arch laptop | Home LAN, Tailscale disabled | Trusted IP HTTPS, login, Dashboard, saved Assistant history, logout | Not performed |
| Arch desktop | Home LAN, Tailscale disabled | Same checks in its actual browser | Not performed |
| Android phone | Home Wi-Fi, Tailscale disabled | Same checks, usable mobile navigation, no certificate warning | Not performed |
| Phone or laptop | Off-LAN with Tailscale | Existing hostname, trusted HTTPS, login, Dashboard, same saved history | Not performed |
| Unapproved ingress client | Other interface/source where available | Both publications and direct container/worker access rejected | Not performed |

For shared-history verification, create a harmless conversation from one origin and read it from the other after a separate login. A model/provider login is not required to list saved history. If history is unavailable in the deployed release, record that limitation rather than enabling live provider access as test setup.

Confirm both origins reject unknown Host and missing, forged, or cross-origin mutation Origin headers. Supplying the other allowed origin on this Host must still fail. Client `Forwarded`, `X-Forwarded-*`, and Tailscale identity headers must fail, not change redirect, cookie, or authorization behavior. Check unauthenticated pages, history, and event streams return no private data. Login throttling applies to the shared owner account, and administrative recovery invalidates sessions on both origins. Recovery changes the password and requires separate explicit authorization; do not run it as routine smoke-test cleanup.

Plain HTTP must not return an application response on either published endpoint. Probe direct Dashboard container ports and worker port from outside the Docker bridge, including a LAN request routed to the Tailscale destination. A failed connection alone cannot prove the intended firewall rule handled it. Correlate the request with the expected drop counter. The optional namespace packet verifier requires separate authorization and proves only its explicitly reported rejected paths.

### Development separation

Record production container IDs, image IDs, start timestamps, mount sources, and owner-visible history. Start `npm run dev:network` with a disposable password and separate state. Verify its URL uses the development port, then stop it with Ctrl+C. Repeat read-only production inspection and both login probes. Production identities and writable state must be unchanged by development. Do not use the production account, token, worker URL, or provider credentials in the development process.

### Remaining operations

Certificate issuance, Arch/Android trust installation, persistent firewall migration, both-path runtime probes, physical-device verification, router port-forward/UPnP review, off-LAN tailnet ACL checks, live packet probes, and production rollback exercise remain unperformed. Final release verification belongs with #12. No public exposure or Funnel check is inferred from successful local tests.
