# Issue #4 browser verification

## Scope and setup

This is a manual agent-browser check of the Dashboard running from `npm run dev -- --port 3104` on `127.0.0.1`. It did not run a production build, add a browser test suite, or change application files.

Chromium was already installed by `npx agent-browser install`. The browser used the named session `voidstation-issue-4-evidence`. This Linux host rejects Chromium's normal sandbox, so the isolated loopback session used `--args '--no-sandbox'`. That is not an application or deployment setting.

`issue-4-controlled-metrics.js` is a browser init script. It intercepts only `/api/metrics` in the test browser and returns contract-valid, dated responses. `window.__issue4SetPhase()` changes the next poll without a navigation. `requestFailure` rejects the request to simulate lost connectivity. The script also records every Dashboard fetch timestamp in `window.__issue4FetchEvents`.

## Results

| Check | Result |
| --- | --- |
| Initial request has not completed | All five cards show `Loading`, skeletons, and `No observation received`. The DOM records `data-state="loading"` for every card. No zero value or timestamp is shown. |
| First response has no RAM measurement | CPU, Uptime, Root filesystem, and Data filesystem are Current. RAM says Unavailable, `The Server did not provide this measurement.`, and `No observation received`. Its `time` element is absent. |
| Whole request failure before RAM succeeds | The request warning is visible. CPU, Uptime, Root filesystem, and Data filesystem retain their first values and timestamps with `Stale reading`. RAM remains unavailable with `The Dashboard could not request this measurement.` and no timestamp. |
| Recovery without reload | The next successful response clears the warning and stale state. RAM becomes Current at `2026-01-02T03:04:10.002Z` with 5.0 GiB used. |
| Partial RAM failure | RAM retains 5.0 GiB and `2026-01-02T03:04:10.002Z` as a Stale reading. CPU, Uptime, Root filesystem, and Data filesystem update to their `03:04:15` timestamps and stay Current. |
| Whole failure after the partial failure | Every successful measurement is stale. RAM still shows its `03:04:10.002Z` timestamp while the other cards retain their `03:04:15` timestamps. The warning is visible. |
| Final recovery without reload | The warning and all stale badges disappear. Each card is Current with its `03:04:20` timestamp. Zero RAM used renders as `0.0 GiB`, not Unavailable. |
| Poll cadence | Apart from the two dev-mode initial effect calls 4 ms apart, the init-script record has 25 consecutive 5,000 ms intervals while the page is visible. |
| Desktop at 1440 x 900 | The grid has two columns. CPU is x=184, width=464.625 and Uptime is x=664.625, width=591.375. Values, timestamps, status badges, and storage bars are readable. |
| Narrow mobile at 320 x 812 | `documentElement.scrollWidth` is 320. Every card is stacked at x=16, width=288. The RAM stale card keeps its badge, progress bar, zero value, and observation time inside that width. The Dashboard has no interactive controls, so there is no touch target to inspect. |
| Accessibility scan | `agent-browser a11y --tags wcag2a,wcag2aa` reported 20 passes, 0 violations, and 0 incomplete checks. |
| Browser errors | None reported by `agent-browser errors`. |

## Evidence

The screenshots and JSON DOM records are checked-in evidence. I inspected each screenshot and used the JSON records for exact dates, positions, dimensions, scroll widths, state attributes, and rendered text.

- [Initial loading, 1440 x 900](../../artifacts/issue-4/01-loading-desktop-1440x900.png). All five cards are Loading. [DOM record](../../artifacts/issue-4/01-loading-dom-record.json).
- [Initial RAM unavailable, 1440 x 900](../../artifacts/issue-4/02-initial-unavailable-desktop-1440x900.png). [DOM record](../../artifacts/issue-4/02-initial-unavailable-dom-record.json).
- [Whole request failure, 1440 x 900](../../artifacts/issue-4/03-whole-request-failure-desktop-1440x900.png). [DOM record](../../artifacts/issue-4/03-whole-request-failure-desktop-1440x900-dom-record.json).
- [Recovery, 1440 x 900](../../artifacts/issue-4/04-recovery-desktop-1440x900.png). [DOM record](../../artifacts/issue-4/04-recovery-desktop-1440x900-dom-record.json).
- [Partial RAM failure, 1440 x 900](../../artifacts/issue-4/05-partial-failure-desktop-1440x900.png). [DOM record](../../artifacts/issue-4/05-partial-failure-desktop-1440x900-dom-record.json).
- [Whole failure after partial failure, 1440 x 900](../../artifacts/issue-4/06-request-failure-after-partial-desktop-1440x900.png). [DOM record](../../artifacts/issue-4/06-request-failure-after-partial-desktop-1440x900-dom-record.json).
- [Final recovery, 1440 x 900](../../artifacts/issue-4/07-final-recovery-desktop-1440x900.png). [DOM record](../../artifacts/issue-4/07-final-recovery-desktop-1440x900-dom-record.json).
- [Current mobile view, 320 x 812](../../artifacts/issue-4/08-mobile-current-top-320x812.png). [DOM record](../../artifacts/issue-4/08-mobile-current-top-320x812-dom-record.json).
- [Stale mobile view, 320 x 812](../../artifacts/issue-4/09-mobile-partial-stale-320x812.png). [DOM record](../../artifacts/issue-4/09-mobile-partial-stale-320x812-dom-record.json).
- [Polling record](../../artifacts/issue-4/polling-record.json) and [axe result](../../artifacts/issue-4/a11y.json).

## Reproduce

Start the dev server in one terminal.

```sh
npm run dev -- --port 3104
```

In another terminal, start an isolated, named agent-browser session. Omit `--args '--no-sandbox'` if Chromium runs with its normal sandbox on the host.

```sh
SESSION="$(npx agent-browser session id --scope worktree --prefix voidstation-issue-4)"
npx agent-browser --session "$SESSION" --pin-tab --args '--no-sandbox' \
  --init-script docs/verification/issue-4-controlled-metrics.js open about:blank
npx agent-browser --session "$SESSION" set viewport 1440 900
npx agent-browser --session "$SESSION" open http://127.0.0.1:3104/
```

The initial `initial` phase returns RAM unavailable. Change phases, wait slightly more than the five-second poll interval, then take a screenshot and DOM record after each step. Do not reload the page.

```sh
npx agent-browser --session "$SESSION" eval 'window.__issue4SetPhase("requestFailure")'
sleep 6
npx agent-browser --session "$SESSION" eval 'window.__issue4SetPhase("recovered")'
sleep 6
npx agent-browser --session "$SESSION" eval 'window.__issue4SetPhase("partial")'
sleep 6
npx agent-browser --session "$SESSION" eval 'window.__issue4SetPhase("requestFailure")'
sleep 6
npx agent-browser --session "$SESSION" eval 'window.__issue4SetPhase("final")'
sleep 6
npx agent-browser --session "$SESSION" set viewport 320 812
npx agent-browser --session "$SESSION" screenshot artifacts/issue-4/mobile.png
npx agent-browser --session "$SESSION" eval 'JSON.stringify({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,cards:[...document.querySelectorAll(".metric-card")].map((card) => ({state:card.dataset.state,time:card.querySelector("time")?.dateTime ?? null,rect:card.getBoundingClientRect().toJSON()})),events:window.__issue4FetchEvents}, null, 2)'
npx agent-browser --session "$SESSION" close
```

To capture the initial loading state, use `issue-4-hold-metrics.js` instead. It holds metrics requests for 15 seconds. Agent-browser waits for a normal navigation, so attach a second named agent-browser session to the first session's CDP URL while the first `open http://127.0.0.1:3104/` command is running, then take the snapshot and screenshot before the hold expires.

## Limitations and follow-up

The responses came from a browser init script, not the live Server collector. This verifies observable Dashboard state changes and layout, not Linux source-file handling or a real network outage. The check used Chromium on one Linux host. It did not cover device suspension, other browser engines, or a production build.

The development-only Next Dev Tools button overlaps the lower-left area of mobile screenshots. It is injected by Next.js development tooling, not Dashboard markup. It does not change the 320 px scroll width or the recorded card geometry, but it prevents this dev-server run from proving that exact patch of pixels unobscured in production.

No Dashboard functional or layout blocker was found. Refresh this evidence if the Dashboard component or its styles change. Changes limited to the parent agent's tests or test dependencies do not require a browser rerun.
