# Voidstation assistant worker

This is the private Pi worker for Voidstation conversations. It owns the Pi JSONL transcripts and its SQLite application records. It exposes no browser-facing authentication or provider credentials.

## Build and run

```sh
cd worker
npm ci
npm run build
```

Create a worker-only token file with at least 32 characters and restrict it to the worker account. Keep conversation storage, credential storage, and the media configuration on separate durable volumes.

```sh
install -d -m 700 /srv/voidstation/conversations /srv/voidstation/credentials
VOIDSTATION_WORKER_TOKEN_FILE=/run/secrets/voidstation-worker-token \
VOIDSTATION_CONVERSATION_DIR=/srv/voidstation/conversations \
VOIDSTATION_CREDENTIAL_DIR=/srv/voidstation/credentials \
VOIDSTATION_MEDIA_CONFIG_FILE=/run/voidstation-media/config.json \
npm start
```

`VOIDSTATION_WORKER_HOST` defaults to `0.0.0.0`. `VOIDSTATION_WORKER_PORT` defaults to `3001`. `VOIDSTATION_TURN_TIMEOUT_MS` defaults to ten minutes. `VOIDSTATION_PROVIDER_COOLDOWN_MS` defaults to 60 seconds. `VOIDSTATION_SHUTDOWN_TIMEOUT_MS` defaults to four seconds. The caller sends the token as `Authorization: Bearer <token>` for every route, including `/health`.

All four path settings must be absolute. Conversation and credential directories must be disjoint. The token may end with a newline in its file, but its value must contain no whitespace. The worker rejects browser provenance headers, including `Origin`, `Sec-Fetch-Site`, and `Sec-Fetch-Dest`, even if a caller knows its token.

Run one worker for a conversation directory. A kernel-held SQLite exclusive lock prevents a second process from using the state and releases automatically when a container exits, including a fresh PID 1 restart. The worker marks running turns interrupted after a restart and never resumes or replays them.

Use a private container network. Do not publish port 3001. Run the image with a read-only root filesystem, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, writable mounts only for the two state directories and `/tmp`, and no Docker socket or host-development mounts. Mount `/run/voidstation-media` read-only.

## Codex login

The pinned Pi SDK is `0.85.1`. Its installed `openai-codex` OAuth implementation offers `device_code` login and reports a verification URL and user code through the SDK. The login command selects that headless flow directly.

```sh
cd worker
npm ci
npm run build
VOIDSTATION_CREDENTIAL_DIR=/srv/voidstation/credentials npm run login
```

For the deployed image, run this from the repository root on the Server:

```sh
docker compose run --rm --no-deps assistant-worker node dist/login.js
docker compose restart assistant-worker
```

Use the same procedure to renew an expired login. The restart clears the authentication failure gate without restarting the Dashboard. Do not supply an API key.

Open the printed URL in a browser, enter the printed code, and leave the terminal open until it finishes. The command does not print a bearer token. Pi writes refreshable OAuth state to `auth.json` in `VOIDSTATION_CREDENTIAL_DIR`; never copy a development Pi auth store into this directory.

The worker supports the `openai-codex` provider with the pinned `gpt-5.5` model and OpenRouter with the models included in the pinned Pi catalog. To use OpenRouter, write its API key to `openrouter-api-key` in the worker credential directory with mode `0600`, then restart the worker. The worker imports that key into its private Pi credential store. OpenRouter offers both free and paid models, but free models can still have rate limits. OpenRouter usage may incur separate API billing. The worker rejects an OpenAI API-key environment fallback and non-OAuth Codex credentials. Provider credentials stay in the worker and never reach the Dashboard. Authentication failure blocks new turns for the selected provider until its credentials are configured. Limits and provider outages block that provider for the configured cooldown. Both cases return a sanitized `503` error while saved history remains readable. A separate login store can still consume the same account-level subscription limits as development Pi. Recheck provider compatibility when upgrading Pi.

## HTTP contract

All routes require worker-token authentication.

- `GET /health`
- `GET /settings` returns the selected provider/model, connection status, and the supported model catalog
- `PUT /settings` with `{ "provider": "openrouter", "model": "provider/model-id" }` changes the selection for new turns
- `GET /conversations` returns `{ "conversations": Conversation[] }`
- `POST /conversations` with `{}` returns `201 Conversation`
- `GET /conversations/:id` returns `ConversationDetail`
- `DELETE /conversations/:id` returns `204`, or `409` during a running turn
- `POST /conversations/:id/turns` with `{ "text": string }` returns `202 Turn`, or `409` for a competing turn
- `GET /conversations/:id/events` is an SSE stream of `snapshot` events containing `ConversationDetail`

`ConversationDetail.timeline` is an ordered list of `{ type: "message" | "toolCall" | "mediaResult", id }` references into the existing arrays. It is present for saved history and SSE snapshots; old records are backfilled with a turn's tool evidence before its reply. `ConversationDetail.mediaResults` contains structured, sanitized evidence from `media_find`, `media_details`, `media_configure`, and `media_search`. They use Radarr for movies and Sonarr for series. To add a new series, the Sonarr section of the media configuration must include a positive `languageProfileId`. The worker validates configured folders and quality profiles, never picks an ambiguous title, and never exposes arbitrary service API requests. Configuration changes and searches return structured results, but do not claim that a download started or media became available.

The worker persists each completed assistant text segment and tool result as it occurs. While a text segment streams, SSE snapshots include it ephemerally and retain its ID when it becomes saved; a completed tool call appears as soon as Pi reports its result. SSE sends current state at connection, after changes, and periodically. It does not promise token replay.

## Deterministic test model

The deterministic model is available only when `NODE_ENV=test`. Set `VOIDSTATION_TEST_MODEL_FILE` to an absolute fixture path. The worker rejects the setting in every other environment.

```json
{
  "steps": [
    { "chunks": [{ "text": "Saved", "delayMs": 20 }, { "text": " response", "delayMs": 20 }] },
    { "error": "limits", "rawError": "synthetic-provider-canary" }
  ]
}
```

The fixture file is reread for each submitted turn and steps are selected sequentially, wrapping at the end. `chunks` emits incremental text deltas. `parts` can interleave `{ "type": "text", "text": "..." }` and `{ "type": "toolCall", "name": "media_find", "arguments": {} }` within one assistant response. `error` accepts `authentication`, `limits`, `unavailable`, and `hang`; `rawError` supplies a synthetic suffix to verify transcript redaction. `fault: "construct"` and `fault: "iterator"` test synchronous stream construction and asynchronous iterator failures. `ignoreAbort: true` with `error: "hang"` simulates a noncooperative provider: the visible timeout failure does not unlock the conversation, and the process exits at the shutdown deadline rather than risking later transcript writes. Tests still create real Pi sessions, transcript files, and agent sessions. Set optional absolute `VOIDSTATION_TEST_ASSERTIONS_FILE` to append redacted model messages, system prompt, and tool names. The production Docker image removes this adapter.

Pi resource loading is explicit. The worker does not discover host resources. The worker uses in-memory settings, no context files, no extensions, no packages, no prompts, and only the four media tools. It never discovers a host Pi installation, settings, credentials, sessions, workspace, extensions, or skills.
