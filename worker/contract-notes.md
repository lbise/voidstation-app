# Worker contract notes

Start the worker after installing its own exact lockfile:

```sh
cd worker
npm ci
VOIDSTATION_WORKER_TOKEN_FILE=/run/secrets/worker-token \
VOIDSTATION_CONVERSATION_DIR=/var/lib/voidstation/conversations \
VOIDSTATION_CREDENTIAL_DIR=/var/lib/voidstation/credentials \
npm start
```

The token file must contain at least 32 characters. The worker listens on `0.0.0.0:3001` unless `VOIDSTATION_WORKER_HOST` or `VOIDSTATION_WORKER_PORT` changes it. Send the token in `Authorization: Bearer <token>` to every endpoint, including `/health`.

For deterministic HTTP tests only, set `NODE_ENV=test` and point `VOIDSTATION_TEST_MODEL_FILE` at an absolute JSON fixture:

```json
{"steps":[{"text":"first reply","delayMs":20},{"error":"limits"}]}
```

The worker rereads this file for each submitted turn. It selects a step by submitted-turn order, wrapping after the last step. `text` completes a real Pi session with a fixture-backed model. `chunks` accepts `[{"text":"part","delayMs":20}]` and emits each text delta separately, so SSE snapshots show an ephemeral assistant message while the turn is running. `delayMs` delays the first chunk. `authentication`, `limits`, and `unavailable` produce sanitized failed turns. `rawError` adds a synthetic error suffix for transcript-redaction tests. `fault:"construct"` throws while the provider creates a stream; `fault:"iterator"` rejects its iterator. Both must become safe failed turns. `error:"hang", "ignoreAbort":true` simulates a noncooperative stream: the turn becomes a visible timeout failure, but the conversation remains locked until the worker force-exits after `VOIDSTATION_SHUTDOWN_TIMEOUT_MS`. The fixture setting is rejected unless `NODE_ENV=test`; the production image does not include fixture files.

After a provider authentication failure, new turns return `503 {"error":"Provider authentication is unavailable. Run worker login."}` until the operator logs in and restarts the worker. Limits and provider-unavailable failures return their sanitized `503` error and block new work for `VOIDSTATION_PROVIDER_COOLDOWN_MS`, which defaults to 60 seconds.

The first startup marks durable `running` turns as `interrupted`. It never resumes them automatically.
