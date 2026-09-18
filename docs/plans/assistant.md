# Assistant planning

A later owner decision adds provider/model selection to the Assistant. That decision supersedes the initial Codex-only and no-settings release boundary where it conflicts below. The selector supports OpenAI Codex and OpenRouter, including free and paid OpenRouter models. Provider credentials remain worker-owned.

This records the agreed design discussion. The implementation specification is published as [GitHub issue #6](https://github.com/lbise/voidstation-app/issues/6), labeled `ready-for-agent`. Use that issue as the authoritative specification. No application implementation or deployment was performed during this planning session.

## Agreed direction

- Use Pi SDK for the assistant runtime. Vercel AI SDK and Codex app-server were considered; the owner explicitly selected Pi after discussing skill support and subscription authentication.
- Use the owner's existing OpenAI Codex subscription initially. Pi's OAuth compatibility is not an OpenAI guarantee for third-party integrations. Keep provider flexibility without building a new compatibility layer.
- Require owner login for all of Voidstation, including the dashboard, assistant endpoints, and conversation history. Use one local owner account, no registration, rate-limited login, and an administrative recovery command. Require HTTPS before transmitting login credentials over the LAN. Application login is separate from model-provider authentication.
- Save conversations so the owner can start on a laptop and resume on a smartphone. Keep history until the owner deletes it. Deleting a conversation does not undo its media actions.
- Provide a dedicated Assistant page with a conversation list, mobile-friendly chat, and structured action results alongside model-generated prose.
- Build a general assistant with explicitly enabled capabilities, initially limited to media management.
- Use four typed media tools backed by fixed Radarr/Sonarr adapters. Do not load service-specific agent skills or expose a general-purpose shell.
- Keep the adapters and their Python dependency pinned in the worker image. The Assistant cannot install executable dependencies or discover new capabilities.
- Enforce command restrictions in the tool boundary, independently of model instructions and service CLI confirmation flags.
- A media request adds a title to Radarr for movies or Sonarr for TV, enables monitoring, and requests a download search. Report addition, search acceptance, download progress, and availability as distinct outcomes.
- Execute clear single-title additions without an extra confirmation. Ask for clarification when the title is ambiguous and confirmation when multiple titles are requested.
- Support configured quality defaults and explicit requests such as 4K. Resolve explicit requests against service quality profiles; never silently substitute a lower quality. Explain when no suitable profile is configured. A matching profile does not guarantee that a release is available.
- Ask whether an unspecified TV request covers all episodes, selected seasons, or future episodes. Execute explicit season requests without an extra scope question.
- Include title lookup, additions, and library/download status. Report the status of existing titles rather than silently changing them. Require confirmation before changing an existing title's quality profile and searching for an upgrade. Exclude download cancellation and manual release selection.
- After an uncertain mutation result, verify service state before considering a retry. If verification fails, report the outcome as unknown. Report partial success when addition succeeds but download search fails.
- Exclude deletion, server configuration changes, and proactive autonomous work from the first version. Radarr and Sonarr own ongoing monitoring and downloads.
- Keep service credentials server-side and out of model messages.

## Media tool constraints

The worker uses fixed Radarr and Sonarr adapters with typed arguments. They require Python and `requests`, keep credentials in the child environment, and reject arbitrary endpoints, methods, payloads, and command arguments.

- The tools resolve identity before changing media and never silently choose the first result.
- They validate configured folders and quality profiles instead of trusting service ordering.
- Download search is a separate explicit tool operation. An addition alone does not prove a search or download.
- Quality overrides use configured names mapped to validated profile IDs.
- The dashboard image does not contain the worker's media adapters or runtime dependencies.

## Agreed execution and operations

- Run Pi in a separate internal assistant worker, not inside the dashboard process. Keep provider/service credentials, Python dependencies, and writable Pi state in the worker. Do not expose the worker directly to browsers or publish its port.
- The Voidstation Pi runtime is entirely separate from the owner's interactive Pi coding agent on the same server. Install a pinned SDK dependency in the worker image; do not invoke or attach to the host Pi installation, process, or sessions. Host Pi upgrades must not update the worker runtime implicitly.
- Give the worker its own settings, credential store, session storage, and explicit resource loader. Do not mount or discover the owner's Pi configuration, development workspaces, sessions, extensions, or automatically loaded capabilities. Changes to either Pi environment must not alter the other's configuration or history.
- Authenticate the worker separately using its own device-code login and credential volume, without copying the development agent's auth files. Using the same Codex account can still share account-level subscription limits; separate runtimes do not create a separate subscription allowance.
- Package pinned copies of the fixed media adapters and Python dependencies during deployment. Source changes do not change a running deployment until explicitly updated.
- Disable general-purpose built-in coding tools. The four media tools construct validated command arguments and reject generic API escape hatches, arbitrary argument tails, and endpoint changes. Confirmed quality upgrades need a dedicated restricted path, not unrestricted update access.
- Keep application code and media adapters read-only. Retain container hardening, with narrowly scoped writable agent state and temporary storage. No Docker socket or broad host mounts.
- Use deployment configuration for service connections, root folders, default profiles, and explicit quality mappings. Validate these against each service. No settings screens initially, and the assistant cannot change defaults.
- Continue active turns on the worker after browser disconnects. Reconnecting devices recover saved history and attach to live state where available. Allow one active turn per conversation.
- Persist action and confirmation state separately from Pi transcripts. Pi's live event stream is not durable, and a crashed turn cannot simply resume. Mark interrupted turns and verify uncertain mutations before further work; never blindly replay them.
- Present explicit confirmation cards identifying titles, seasons, and quality changes. Store pending actions server-side so approval works across devices. An approval authorizes only the displayed action and parameters; changed parameters require fresh approval.
- Stop new model work when subscription access expires or limits are reached, with an explanation. Never fall back automatically to API billing. Preserve access to saved conversations and action results.
- Provision Codex OAuth through Pi's headless device-code flow from an owner-controlled terminal. Complete the displayed login in the browser. Keep writable, private credential storage for refresh tokens, separate from conversation storage. Never expose provider tokens to the application browser or copy them into model context.

- Require Tailscale on every client, including at home, and use a Tailscale HTTPS hostname while retaining Voidstation's owner login. Remove direct LAN HTTP application access. Do not enable public exposure.
- Expire action approvals after ten minutes. Recheck relevant service state before executing an approved action; request fresh approval if the proposed change no longer matches. Serialize media mutations across conversations.
- Block conversation deletion during active work. Deleting an idle conversation cancels its pending approvals.
- Persist state across container restarts. Document a consistent encrypted backup and restore procedure, treating credentials as secrets. Defer automated backup scheduling. Restoring old state must not replay actions; restored unfinished work requires reconciliation.

## Published specification and testing

The owner confirmed the testing approach before publication. [GitHub issue #6](https://github.com/lbise/voidstation-app/issues/6) contains the complete user stories, implementation decisions, testing decisions, and exclusions.

Use Voidstation's HTTP interface as the primary behavioral test seam, running the real application and worker with deterministic model responses and fake Radarr/Sonarr HTTP services. Assert observable results and service requests, not model wording or private function calls. Supplement this with deployment/isolation checks and desktop/mobile agent-browser checks. Automated tests must not use live Codex credentials or real media services.

Isolation checks must prove that the worker uses independent settings, credentials, sessions, and approved resource discovery; cannot access host Pi state or development workspaces; and does not depend on the host Pi executable. Test isolation without reading or exposing the owner's actual credentials or private sessions.

## Release boundary

`docs/plans/first-release.md` describes the original read-only dashboard and deliberately deferred authentication and controls. This is a subsequent release; it does not change that historical specification. Preserve the existing deployment restrictions unless a specific change is agreed.
