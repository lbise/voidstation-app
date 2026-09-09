# First release

## Agreed scope

- Monitor the home Ubuntu server. No commands or server-changing actions.
- Show CPU usage, RAM usage, disk space, and uptime.
- Refresh metrics every five seconds. No historical charts, alerts, or service checks.
- Allow access from the home network and through Tailscale. No direct public access.
- Use HTTP initially. Direct LAN traffic is unencrypted; Tailscale encrypts traffic passing through its network. HTTPS is desired later, outside this release.
- Bind published Docker ports only to intended LAN and Tailscale addresses. Check actual Docker exposure rather than assuming firewall defaults protect published ports.
- Give both users the same information. No roles or user-management screens.
- No app login for this read-only release. Anyone with permitted network access can view metrics. Restrict access to LAN and Tailscale; revisit authentication before adding controls or sensitive data.
- Deploy with Docker, with automatic restart after crashes and host reboots.
- Read host metrics through narrow read-only mounts. Dedicated empty directories on the root and data filesystems may be created to query filesystem capacity. Do not use privileged mode, the Docker socket, or an entire host filesystem mount. Verify readings against the host rather than assuming container readings describe it.
- Monitor root and the separate data filesystem individually. Show used, available, and total space. Exclude boot, EFI, virtual filesystems, and physical-disk health checks.
- On connection failure, retain the last successful values, mark them stale with their timestamp, show a warning, and retry automatically. Missing readings must not appear as zero.
- Define CPU usage as overall host utilization, RAM usage as total minus available host memory, and uptime as time since host boot.
- Handle failures per metric so successful readings remain usable. Show loading placeholders before the first reading and unavailable or stale states as appropriate.
- Use Next.js with React, TypeScript, Tailwind CSS, and shadcn/ui.
- Support mobile browsers with responsive layouts and touch-friendly controls. Installation and offline support are out of scope.
- Start with a dark shadcn dashboard, metric cards, separate storage bars, and a last-updated indicator. Stack cards on mobile and omit a theme switcher. Refine visual details during implementation.
- Keep metric collection separate from the UI. Defer database and ORM selection until a persistent feature needs them.

## Proposed delivery checks

- Verify host CPU, memory, uptime, and filesystem readings against Ubuntu readings, allowing for sample timing and unit conversion.
- Test metric calculations, initial loading, partial failures, stale readings, and recovery.
- Check narrow mobile and desktop layouts, readable labels, and touch targets.
- Verify LAN and Tailscale reachability and intended port bindings without disturbing existing workloads.
- Verify container restart behavior and inspect boot-start configuration. Do not reboot the home server as part of testing without separate permission.

## Approval

Scope decisions are settled. Final confirmation of the plan and delivery checks is pending before implementation.

