# Issue #13 certificate automation checks

This supplements `issue-13.md` without changing its historical results. The owner requested scripts and exact per-machine instructions for the agreed private-CA setup.

Implemented `scripts/setup-lan-certificates.sh` and `scripts/lan-certificates.py`. The wizard runs on the Arch laptop, keeps the encrypted CA key there, and separately confirms local trust, SSH transfer, and remote Server installation. It prepares public PEM/DER exports for the Arch desktop and Android and saves deferred commands in a private handoff file. Android approval remains a manual device operation. Neither script deploys the application or changes firewall rules.

The production update command now recreates the Dashboard to load changed certificate mounts even when its image is unchanged. It does not force an unchanged worker to restart. This was tested through the deployment CLI with fake Docker commands, not applied to production.

## Results

- Final `npm test`: 158 tests passed across 15 files, including application and worker builds.
- Application and worker typechecks passed.
- Certificate CLI tests use real OpenSSL and disposable state. They cover stable-CA renewal, wrong passwords/IPs, incomplete state, invalid keys/CAs, symlinks, FIFO rejection, expiry handling, backup preservation, and fingerprint-bound trust imports.
- Root-install tests replace only OS ownership/effective-UID operations in a temporary filesystem fixture. They exercise real OpenSSL, private copying, and Linux `renameat2` exchange. They do not prove real Server ownership, mount reloads, or sudo configuration.
- Wizard tests replace SSH, SCP, trust, and certificate issuance at command boundaries. They check allowlisted transfer files, explicit approval gates, and saved handoff instructions. They perform no network transfer or trust installation.
- The unchanged wizard-library prefix, Bash syntax, Python compilation, documented shell snippets, and diff whitespace checks passed. ShellCheck was unavailable.

## Standards

The independent Standards review found no documented-standard violations or baseline code smells. The wizard library remains unchanged and the installer is self-contained for copying between machines.

## Spec

The independent Spec review found no missing requirements or scope issues in the requested automation. Machine-specific instructions, confirmation gates, CA-key isolation, and the separate deployment boundary are present.

Review totals: Standards 0 findings; Spec 0 findings.

No production CA was issued, no device trust was installed, and no live Server certificate, firewall, container, or router configuration was changed. Physical Arch/Android and off-LAN Tailscale verification remains pending after owner-authorized setup and cutover.
