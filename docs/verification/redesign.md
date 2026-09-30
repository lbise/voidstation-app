# Voidstation redesign verification

The owner approved prototype E: D's neutral dark styling with B's system-stats header and workspace selector. The logo and emerald accent stay. Geist replaces the UI fonts; Sora remains only in the logo. The design contract is `.impeccable/surfaces/src-app-assistant-page-tsx.md`.

## Prototype source

The five clickable variants are archived outside main on branch `prototype/voidstation-redesign`, commit `43f2758df18b432c9fe8fc31c3e48d5d0f31f4f8`. Open `prototypes/redesign-worlds/index.html` from that branch to compare them. Variant E is the approved choice. They contain synthetic data and a preview of future controls, not production behavior.

## Checks

- `npm run typecheck`: passed.
- Worker and application production builds: passed.
- `npx vitest run`: 223 tests in 23 files passed.
- After the review fixes, all 61 Assistant, thread, shell, metrics-provider, Dashboard and CPU-history tests passed again.
- `node tests/assistant-scroll.browser.ts`: production instant and streamed replies followed to the end at 1280×577, 1280×720 and 390×844, live and after reload. Phone checks at 390px and 320px passed for drawer geometry, Escape focus restoration, compact composer, non-overlapping tabs, 44px stats target and no horizontal overflow.
- Source design detector: no findings across `src/app`, `src/components` and `tokens.css`.
- Browser captures: Assistant, Dashboard and Login at 1440×900 and 390×844. Assistant also checked at 1280×800 and 320×700. Tool disclosure, mobile history and settings, and retained disk readings captured separately.
- No browser console errors observed in the fixture.

## Fixture and capture limits

Browser inspection used the production build with temporary owner credentials, isolated Pi worker state, deterministic media replies, and mocked metrics responses. No production sessions, chats, provider credentials or Server controls were used. The metrics mock supplied successive real-format observations; stale screenshots followed a successful reading with a failed `/data` reading. No synthetic values or approval previews appear in the shipping app.

Screenshots live in the gitignored `.impeccable/review/` directory. Dashboard top and scrolled-bottom captures are separate because the page scrolls inside the workspace. Mobile virtual-keyboard handling uses `visualViewport` and `interactive-widget=resizes-content`; physical phone keyboards and OS-specific safe-area behavior still need device testing.

## Independent review

Fresh general agents performed the finish review and documentation because the packaged Impeccable roles were not registered in this harness. The review returned `fix` with four findings:

1. The production CSS minifier discarded `translate: 0`, leaving the history drawer shifted by half its width and height. A variable-backed two-axis translation now survives minification.
2. The Controls label and Soon badge overlapped at 320px. They now share inline layout.
3. The composer retained the height of the initial disabled placeholder. It now resizes when conversation data arrives and on viewport resize.
4. The mobile stats link had a 36px hit area. It is now 44px.

The reviewer scored all four fixes resolved and returned `ship` for that fix list after checking recaptured evidence. No fix-batch regressions were observed. `DESIGN.md` and `.impeccable/design.json` record the resulting system.

## Production boundaries

Authentication, metrics collection and Assistant APIs are unchanged. Header and Dashboard share one client poller and CPU history. Tool summaries keep every technical record and preserve message ordering. Drafts survive conversation switches in the current mounted Assistant session; they are not persisted across navigation or reload. Controls is a disabled Soon item. The new UI does not add server actions, media mutations or Temperature measurements.
