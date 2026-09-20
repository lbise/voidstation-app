# Assistant listing and layout fixes

## Series listing

The deployed adapter failed on a healthy Sonarr response: HTTP 200, 209,757 decoded bytes. Its 128 KiB body limit rejected the response after gzip decoding. The worker reported that rejection as `service_unavailable`.

`tests/media-http.test.ts` reproduces this with a compressed 40-series response larger than 200 KB. With the old limit, the test returned `service_unavailable`. With the fix, it returns the existing bounded 20-entry tool result.

The adapters now share a 16 MiB decoded-response limit, separate from the small tool-output limit. They close response streams on success and failure. `tests/media-response.test.ts` covers plain and compressed responses below, at, and above that limit.

Read-only verification used the current adapter sources mounted into a disposable worker-image container, with the deployed network and media configuration. Both Sonarr and Radarr `restricted find` calls exited successfully and returned 20 entries, with outputs under 2.5 KB. No library changes or download searches were performed. The production containers were not replaced.

## Browser checks

Used agent-browser against `npm run assistant:browser-fixture`, which runs the real Dashboard and worker with temporary authentication, deterministic model replies, and fake media services. This checks UI behavior without live model costs or media mutations.

- Reproduced settings being covered by the conversation pane at 1440 × 900.
- Reproduced Enter inserting a newline instead of submitting.
- Reproduced tool evidence taking the conversation's available height and hiding messages.
- Verified the settings dialog at desktop, 390 × 844 mobile, and 667 × 375 short viewport sizes. Its body scrolls while Save remains reachable.
- Changed and saved a Codex model. The dialog closed and the next reply showed the selected model.
- Checked OpenRouter filtering, empty search results, and resetting filters when switching providers.
- Verified Shift+Enter preserves a newline and Enter submits a message through the worker.
- Expanded evidence and opened full tool details.
- Checked browser errors; none reported.

Screenshots are local artifacts under `artifacts/assistant/`, including `settings-before.png`, `settings-mobile-final.png`, `chat-mobile-final.png`, and `chat-desktop-final.png`.

## Automated checks

`npm test` passes: 176 tests across 18 files, including Dashboard and worker production builds. The new UI tests cover submission guards, IME input, settings save, and evidence placement.
