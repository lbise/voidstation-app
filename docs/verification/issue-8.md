# Issue #8 verification

Verified on 2026-09-13 using temporary owner accounts, certificates, state directories, and deterministic Pi model responses. No development-agent credentials or sessions were inspected.

## Automated checks

- Application and worker typechecks passed.
- `npm test` passed all 124 tests across 10 files, including 16 real Assistant HTTP tests.
- Both production images built successfully.
- Worker runtime inspection passed against separately built test and production stages.
- Synthetic effective Compose inspection passed.

Commands:

```sh
npm ci
npm ci --prefix worker
npm run typecheck
npm run typecheck --prefix worker
npm test
docker build --target build -t voidstation-assistant-worker:test worker
docker build --target runtime -t voidstation-assistant-worker:check worker
npm run worker:runtime:inspect
node scripts/compose-runtime-check.mjs
docker build -t voidstation-dashboard:issue8-check .
```

The HTTP tests use the real HTTPS application and Pi worker. They cover separate conversations, two authenticated devices, competing submissions, partial text streaming, disconnect/reconnect, crash and graceful restart, deletion, stream revocation after logout, provider failures, noncooperative cancellation, and provider exceptions. Synthetic canaries check browser responses, model context, transcripts, and logs.

The image checks verify exact installed Pi versions, authenticated internal HTTP, no host port publication, unprivileged execution, read-only code, dropped capabilities, narrow mounts, production rejection of test configuration, and fresh-container restart. A real Pi turn in the test image runs with synthetic host Pi settings, credentials, skills, extensions, and a fake Pi executable. Its captured system prompt and tools show no resource discovery.

## Browser checks

Used agent-browser with separate desktop and mobile sessions against `npm run assistant:browser-fixture`.

- Desktop viewport 1440 by 900; mobile viewport 390 by 844.
- Owner login and Dashboard/Assistant navigation worked in both sessions.
- Desktop showed partial text and a working state. Navigating away did not cancel the turn; mobile resumed its saved reply.
- Provider limits displayed a failure explanation while saved messages remained readable.
- Mobile deletion used an explicit confirmation dialog. The desktop stream then reported the conversation removed.
- Desktop document height stayed at 900 pixels with the composer visible. Mobile had no horizontal overflow.
- The checked screens had zero axe WCAG 2 A/AA violations.

Screenshots are local, ignored artifacts under `artifacts/assistant/`, including `desktop-streaming.png`, `desktop.png`, `mobile.png`, `mobile-provider-failure.png`, and `mobile-delete-confirmation.png`.

The browser required `--no-sandbox` because this host disables Chromium's unprivileged namespace sandbox. This flag applied only to the temporary test browser. Worker container hardening was not relaxed.

## Review

Separate Standards and Spec reviews found no remaining actionable findings after fixes. The review fixes include holding conversation locks through actual Pi cleanup and sanitizing synchronous and asynchronous provider stream failures before Pi can persist them.

## Owner-run checks still required

No production deployment, live Codex login, subscription request, or media action was performed. Provision the shared worker token and private state paths, complete the independent device-code login described in `worker/README.md`, and authorize deployment separately. Verify the deployed Tailscale ingress and real provider access from owner-controlled devices. Separate login stores may still share subscription limits.
