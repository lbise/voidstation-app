# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
A single owner (Leo) who runs an Ubuntu home Server and uses Voidstation to monitor and control it. There is one owner account. There is no registration and no multi-user management. The owner uses both a phone and a desktop or laptop, so the phone is a primary device and not a fallback. The Assistant gets more use than the Dashboard.

## Product Purpose
Voidstation is a personal hub for monitoring and controlling the home Server. Today it offers:

- **Dashboard:** the Server's CPU (with history), RAM, Disk space and Uptime, with honest handling of unavailable and stale readings.
- **Assistant:** a saved-chat conversational interface backed by an isolated Pi worker. It performs read-only Radarr and Sonarr lookups and status checks.

Success means the owner can check the Server's state or get something done through the Assistant quickly, from any device, and trust what the interface says.

## Positioning
Voidstation is a private tool built for one machine and one person. It isn't a generic homelab dashboard or a hosted chat app. It combines the Server's own measurements with an Assistant that operates only through explicitly enabled, inspectable capabilities.

## Operating Context
- Reached over the LAN (private-CA certificate) and remotely through Tailscale. HTTPS only.
- Used in short check-ins on the phone and in longer sessions on desktop or laptop.
- Assistant conversations are saved and can be resumed across devices and sessions.
- Media work runs through Radarr (movies) and Sonarr (TV series) in the managed library.

## Capabilities and Constraints
- Domain terms are defined in `CONTEXT.md`: Server, Dashboard, Disk space, Uptime, Stale reading, Assistant, Assistant skill, Action approval, Media request, Managed library, Monitoring, Download search. Use them consistently.
- Planned: **Server controls** (e.g. services, containers, restarts) and **richer metrics**. The information architecture must make room for both.
- Action approval is the domain model for mutations: the owner approves a specific proposed action with its exact parameters. The approval UI is not built yet.
- The Assistant exposes its tool activity and model attribution for transparency. Keep that transparency.
- The Assistant has provider and model settings. The Dashboard must work without a model provider.
- Stack: Next.js 16, React 19, Tailwind 4, shadcn with Base UI, lucide icons, hand-authored CSS in `src/app/globals.css` plus `tokens.css`.
- A stale reading is historical and must not be shown as the current state.

## Brand Commitments
- Name: **Voidstation**.
- **Logo is kept:** the `V/` mark and the lowercase `voidstation.` wordmark, with the slash and trailing dot in the accent color.
- **Accent color is kept:** emerald `oklch(73% 0.16 160)`.
- **Dark theme only.** The owner prefers dark interfaces. No light theme is planned.
- **Dark theme:** the owner prefers dark. The interface is dark-first. A light theme is not required.
- Use Geist for UI and Geist Mono for code and instrument figures. Keep Sora for the existing logo only.
- Approved direction: prototype E, archived at `prototype/voidstation-redesign:prototypes/redesign-worlds/hybrid.html`. A refined dark app with system stats and workspace navigation in a global header, conversation-only sidebar, centered Assistant, floating composer, and mobile bottom navigation.
- Craft references confirmed by the owner: Linear, Vercel's dashboard, and ChatGPT/Claude. Keep their readable, familiar controls; no cinema or catalog motifs.
- The owner finds the current UI generic and blocky, and the Assistant layout in particular needs rethinking.

## Evidence on Hand
- Prior critique: `.impeccable/critique/2026-09-23T09-21-09Z__src-app-page-tsx.md` (23/40). Its main points: mobile stacks the interface before the task, drafts are lost when switching conversations, unavailable readings dominate the Dashboard, Assistant evidence reads like implementation details, and mobile hit targets are small.
- Verification screenshots: `docs/verification/`.
- There are no testimonials, users, or metrics beyond the owner. Don't invent any.

## Product Principles
1. **Task before chrome.** The reading, the answer, or the control the owner came for comes first, especially on the phone.
2. **Honest state.** Always distinguish live, stale, unavailable and pending. Never imply a download started or an action happened without evidence.
3. **Explicit power.** Every capability that changes the Server needs a clear, specific owner approval, and the interface shows what was actually done.
4. **Phone and desk are equals.** Every flow works fully on both, not as a squeezed copy of the desktop.
5. **Room to grow.** Structure navigation and layout so Server controls and new metrics fit in without a redesign.

## Accessibility & Inclusion
Target WCAG 2.2 AA. Hit areas on touch devices must be comfortable (44×44 px minimum). Respect reduced-motion preferences.
