---
name: Voidstation
description: Dark Server readings and a centered Assistant workspace.
colors:
  primary: "oklch(73% 0.16 160)"
  primary-ink: "#03150d"
  paper: "#0a0a0a"
  surface: "#111111"
  surface-raised: "#1b1b1b"
  rule: "#262626"
  rule-soft: "#1c1c1c"
  rule-strong: "#444444"
  ink: "#fafafa"
  ink-muted: "#a1a1a1"
  selected: "#202020"
  scrollbar: "#333333"
  warning: "#fbc56a"
  destructive: "#f87171"
typography:
  logo-word:
    fontFamily: '"Sora Variable", sans-serif'
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.05em"
  logo-mark:
    fontFamily: '"Sora Variable", sans-serif'
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.15em"
  title:
    fontFamily: '"Geist Variable", ui-sans-serif, system-ui, sans-serif'
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  conversation-title:
    fontFamily: '"Geist Variable", ui-sans-serif, system-ui, sans-serif'
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.5
  body:
    fontFamily: '"Geist Variable", ui-sans-serif, system-ui, sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  reading:
    fontFamily: '"Geist Variable", ui-sans-serif, system-ui, sans-serif'
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.7
  mobile-input:
    fontFamily: '"Geist Variable", ui-sans-serif, system-ui, sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  button:
    fontFamily: '"Geist Variable", ui-sans-serif, system-ui, sans-serif'
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.5
  navigation:
    fontFamily: '"Geist Variable", ui-sans-serif, system-ui, sans-serif'
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.5
  label:
    fontFamily: '"Geist Variable", ui-sans-serif, system-ui, sans-serif'
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  caption:
    fontFamily: '"Geist Variable", ui-sans-serif, system-ui, sans-serif'
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.6
  instrument:
    fontFamily: '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
    fontSize: "22px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "-0.025em"
  capacity:
    fontFamily: '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
    fontSize: "24px"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  cpu-current:
    fontFamily: '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
    fontSize: "32px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.025em"
  code:
    fontFamily: '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.65
rounded:
  sm: "6px"
  md: "10px"
  lg: "12px"
  control: "8px"
  navigation: "7px"
  composer: "16px"
  composer-mobile: "18px"
  bubble-tail: "4px"
  full: "999px"
spacing:
  3xs: "0.125rem"
  2xs: "0.25rem"
  xs: "0.5rem"
  sm: "0.75rem"
  md: "1rem"
  lg: "1.5rem"
  control-inline: "10px"
  reading-inset: "14px"
  panel: "20px"
  canvas: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-ink}"
    typography: "{typography.button}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "4px 10px"
    height: "32px"
    width: "100%"
  navigation:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.navigation}"
    rounded: "{rounded.md}"
    padding: "3px"
  badge-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
    height: "20px"
  metric-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "20px 0"
  tool-disclosure:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.composer}"
    padding: "7px 10px"
  composer:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.composer}"
    padding: "12px 12px 10px 16px"
    width: "720px"
---

# Design System: Voidstation

## Overview

Voidstation uses a near-black app shell, compact Server readouts, and familiar workspace controls. The confirmed direction is archived at `prototype/voidstation-redesign:prototypes/redesign-worlds/hybrid.html`, with Linear and Vercel dashboard craft and ChatGPT/Claude conversation conventions. Keep the reading area quieter than the header and controls. No cinematic treatment or catalog motif.

The Assistant puts saved conversations in a sidebar and answers in a centered column. The Dashboard uses the same shell without the sidebar. On phones, history becomes a modal drawer and workspace navigation moves below the composer. These are implemented layouts, not a new brand metaphor.

**Key Characteristics:**
- Dark only, with charcoal panels and thin rules.
- Existing emerald for actions, live readings, links, and focus.
- Original Sora logo; Geist reading text and Geist Mono measurements.
- Grouped tool evidence, soft corners, and limited offset shadows.

## Colors

The palette is neutral near-black with one emerald accent. The frontmatter owns exact values; `tokens.css` and `src/app/globals.css` are the implementation sources.

### Primary

`primary` is the preserved emerald. Use it for the send action, active mobile tab, current chart data, caret, focus, and the logo's slash and dot. `primary-ink` is the dark text/icon color on emerald fills. The shadcn `--primary` alias is emerald; its `--accent` alias is the raised neutral, not a second brand accent.

### Neutral

`paper` is the app ground. `surface` separates history and metric cards; `surface-raised` lifts the composer, hover states, and popovers. `selected` marks the active desktop tab. `ink` carries reading text; `ink-muted` carries attribution and supporting labels. `rule-soft` divides shell chrome, `rule` bounds panels, and `rule-strong` supports fields and focused composer borders. `scrollbar` is the global thumb; Assistant scroll regions use `rule-strong`.

Warning marks stale or partial readings; destructive marks failures and destructive actions. Neither is a workspace accent. Keep text or icons with state color. Stale values lose current-reading emphasis, and stale capacity bars use stripes.

Selection uses translucent emerald, 30% globally and 32% in the Assistant. Inputs have emerald carets. Global keyboard focus is a 2px emerald outline offset by 3px; Assistant and reading-info controls use a 2px offset. Keep component focus rings where provided. Scrollbars are thin with transparent tracks; the WebKit global thumb has a rounded silhouette and transparent inset border.

## Typography

Fontsource self-hosts Geist Variable, Geist Mono Variable, and Sora Variable. Do not add remote font requests.

The header logo uses `logo-word` and `logo-mark`. Its historical tight spacing is pinned to this identity, not a general heading treatment. Keep the lowercase `voidstation.` wordmark and `V/` mark; the login wordmark enlarges to 22px. Sora also draws the small Assistant `V/` avatar. It is not a heading font.

`body` is the 14px UI baseline. `title` is the 22px Dashboard heading; `conversation-title` keeps the desktop conversation heading small. `reading` is Assistant prose at 15px with 1.7 line height and a 72ch limit. User bubbles use 15px with 1.55 line height. Markdown headings step through 22, 19, 17, and 15px, with 600 weight.

`navigation`, `label`, and `caption` keep chrome compact. Use sentence case for labels and headings; do not add uppercase eyebrows. Geist Mono belongs to code, chart axes, capacity totals, and scalar figures, with tabular numerals. `cpu-current` is the largest figure; `capacity` and `instrument` support storage and secondary readings. Header readouts use compact Geist with tabular numerals. The Dashboard Uptime figure uses 32px semibold Geist (28px on phones) with muted 16px unit words. Do not force every number into Mono.

Desktop composer text is 15px with 1.55 line height. `mobile-input` makes it 16px on phones; settings fields also become 16px. These local roles take precedence over the unused larger display steps in `tokens.css`.

## Layout

The shell occupies the viewport with a 56px header and independent content scrolling. It does not scroll the header or composer away. Desktop header navigation is segmented, followed by compact CPU, RAM, Disk, and Uptime readings and the account control.

Assistant desktop layout uses a 264px history column, a 52px conversation/model row, and a centered 720px usable reading/composer width. The message wrapper caps at 768px including 24px side padding. Messages have 28px separation. The single-line composer is about 93px tall on desktop and 103px on mobile, excluding its outer dock padding. The textarea starts at a 32px minimum and grows to 180px, then scrolls. Treat these as baselines, not fixed composer heights.

At 859px and below, hide the sidebar and conversation heading. Show CPU/RAM in the header, the history trigger, and three bottom workspace tabs with 56px minimum height plus the bottom safe area. Message side padding becomes 16px and separation becomes 24px. The composer dock uses 10px side insets and 8px vertical padding. A software keyboard resize adjusts shell height to the visual viewport and hides bottom tabs while typing. The history drawer is `min(304px, 86vw)` wide and fills `100dvh`, with safe-area padding.

Header readouts reduce before the phone layout: hide Uptime at 1240px, Disk at 1080px, and the wordmark text/OS label at 980px. At 360px and below, hide the extra trailing mobile action. Keep the account control.

Dashboard content caps at 1280px including its padding. Desktop insets are 32px with 48px below. The page heading carries the title, Live state and the single "Updated" time with its reading-info control; Uptime sits opposite it as the page's headline figure, not in a card. Under the Uptime figure, a compact host-status line carries the Reboot required badge, pending updates, and that check's own time. The CPU card spans the width, with Min/Average/Peak and Load against cores in its footer. Next come three equal capacity cards: RAM (with Swap), Disk space on /, and Disk space on /data. Then Downloads (two thirds) beside Pressure (one third), then Drive health across the full width, with drives in an auto-filling grid of 240px minimum. All rows are separated by 16px. At 960px, use 24px insets. At 760px, the Uptime figure and host-status line drop below the title in their own bordered panel, cards stack, and the page uses 16px side insets, 12px gaps, and 16px card interiors. The CPU chart changes from 260px to 220px tall.

Use the frontmatter spacing steps for shared rhythm, plus the documented 10/14/20/32px local insets. Login centers a panel capped at 360px with 24px page padding. Settings cap at 560px, leave 16px viewport margins, and scroll their body rather than the dialog header/footer.

## Elevation & Depth

Most separation comes from neutral layers and low-contrast 1px rules. Offset black shadows lift metric cards, the composer, settings, and popovers. No colored glow or decorative background blur. The sidecar names the exact observed shadows; `--shadow-panel` supplies the shared panel treatment.

Modal backdrops are black with no blur, 60% for dialogs and 55% for history. Motion is short and ease-out: shared state changes use 120ms, with local disclosure, composer, popover, and drawer timings. Respect reduced motion by stopping Assistant animations and transitions and removing smooth scrolling.

## Shapes

Controls and containers have soft corners, not a uniform radius. The shared scale is 6/10/12px. History rows use 8px, desktop tab interiors 7px, and the composer 16px or 18px on phones. Model chips, status badges, and send buttons are pills or circles. User bubbles have a 16px silhouette with a 4px lower trailing corner. The full-height history drawer has square outer edges.

## Components

### Buttons and fields

Reuse `src/components/ui` components and their `data-slot` hooks. Default buttons are emerald, 32px tall, 14px medium text, with 10px horizontal padding and 12px corners. Outline buttons use a thin rule on the dark ground; ghost buttons have no resting fill. Hover raises the neutral fill or reduces the primary fill to 80%. Disabled buttons lose opacity and pointer interaction; invalid fields use destructive borders/rings. Active non-popup buttons move down 1px.

The input slot defaults to a 32px transparent field with a rule border, 12px corners, and 4px by 10px padding. Its text is 16px below the library's 768px breakpoint and 14px above it. Login/settings override its background to the dark ground and strengthen the border. Mobile settings fields and relevant Assistant actions are at least 44px tall. Keep at least 44px by 44px touch targets; do not mistake a compact desktop slot default for a phone size.

### Navigation and badges

Desktop tabs use muted labels and a raised, bordered current tab. Phone tabs use icons and an emerald current label. Controls remains a disabled button with an outline Soon badge, not a link or working action. History rows use a raised active/hover fill; delete becomes visible on keyboard focus and remains visible on touch devices.

The badge slot defaults to a 20px pill with 12px medium text. Metric badges use 11px text and a 22px minimum; the Soon badge shrinks within navigation. State badges are labels, not 44px buttons.

### Cards and overlays

The card slot defaults to a 16px spacing variable, 12px corners, and a light outline ring. Metric cards override it with a thin border, the metric shadow, and 20px interior spacing; phone interiors become 16px. Current readings share the heading's update time, so cards carry no per-reading time or "current reading" line. A footer appears only for the CPU min/average/peak summary or a stale reading's retained time. Keep unavailable states compact and muted rather than making them oversized empty panels. Reading-info popovers use the raised neutral, a stronger rule, and a 320px maximum with 16px viewport clearance.

Use the Base UI dialog/popover components for focus protection, dismissal, and focus return. History is a left-edge override of the centered dialog slot. Preserve the drawer's custom-variable, two-axis translation override; it survived production minification in the prior checks. Do not replace it with a shorthand that restores the centered dialog translation.

### Assistant reading and grouped tool disclosure

Assistant answers have no enclosing card. Keep the small `V/` avatar, role label, and provider/model attribution above the text. User messages align right in raised neutral bubbles. Long code and tables scroll horizontally inside the reading column.

One expandable summary groups consecutive tool calls and their results in timeline order. It has an emerald wrench, muted sentence-case summary, desktop record count, and failure badges when needed. Expansion reveals divided records, parameters, and results in Mono. The 36px desktop summary becomes at least 44px on phones; the count hides there without hiding evidence. A disclosure reports read-only activity, not action approval or successful mutation.

### Composer

Use a raised neutral rounded box with the composer shadow. Its stronger border on focus replaces the textarea's own outline; preserve emerald caret and clearly focused action controls. Keep model settings at left and the circular send action at right. Disable send for an empty or unavailable composer. Conversation switches preserve drafts.

Desktop Enter sends and Shift+Enter inserts a newline. At 859px and below with a coarse pointer, Enter inserts a newline and the send button submits. Preserve IME composition, the key-code 229 guard, and repeat protection. The desktop keyboard hint hides on phones. Empty-state prompts describe read-only lookups; do not imply download initiation, Server controls, or an approval workflow exists.

Sidecar snippets are self-contained visual examples with literal CSS, inherited token variables plus dark fallbacks, inline SVG, and native controls. They require no Tailwind or React runtime. Their native disclosure previews the appearance only; use the existing app components for production behavior.

## Do's and Don'ts

### Do:
- Do retain the exact emerald, original logo, self-hosted fonts, and dark-only palette.
- Do keep Assistant reading at 15px/1.7, bounded by 72ch, with evidence available on demand.
- Do use the existing slot components, protected overlay focus, 44px touch targets, and reduced-motion rules.
- Do pair reading-state colors with words or icons, and show a reading's own observation time when it is stale.

### Don't:
- Don't add Sora headings, uppercase eyebrows, decorative imagery, or colored glow.
- Don't restore the three-column boxed Assistant workbench or add a sidebar to the Dashboard.
- Don't style Controls/Soon as available or describe read-only tool activity as a mutation or approval.
- Don't remove focus, selection, caret, scrollbar, IME, or keyboard-resize behavior when reusing the layouts.
