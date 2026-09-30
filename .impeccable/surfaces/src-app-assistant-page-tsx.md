---
version: 1
slug: "src-app-assistant-page-tsx"
primary_target: "src/app/assistant/page.tsx"
related_targets: ["src/app/page.tsx","src/app/login/page.tsx","src/components/assistant.tsx","src/components/metrics-dashboard.tsx"]
---

# Voidstation app redesign

Mode: Operate. Scope: Assistant, global shell, Dashboard, Login. Approved by the owner after reviewing prototype E, `prototypes/redesign-worlds/hybrid.html`. Preserve working authentication, measurements, chat streaming, settings, saved conversations, and technical tool evidence. Do not ship synthetic prototype data or preview controls as working features.

## Direction contract

THESIS: Put the Assistant first in a familiar dark app. Global navigation and quick Server readings belong in the header; conversation history alone belongs in the sidebar. Refuse the old three-column boxed workbench.

OWN-WORLD: Near-black neutral ground, softly raised charcoal panels, white reading text, muted grey labels, and the existing emerald accent. Geist for UI, Geist Mono for code and figures, Sora only for the unchanged logo. Soft radii, thin low-contrast rules, offset blurred shadows.

STORY: The owner checks real Server readings, moves between Dashboard and Assistant, resumes chats, inspects grouped tool activity, and sends a message without losing space to chrome. Controls are marked Soon and unavailable.

FIRST VIEWPORT: A compact 56px global header has logo, segmented workspace links, live CPU/RAM/Disk/Uptime readouts, and account menu. Assistant has a 264px history sidebar, small conversation title/model row, centered 720px reading column, and docked rounded composer. Dashboard has no sidebar. Phone has compact CPU/RAM header, modal history drawer, composer and bottom tabs.

FORM: Category standard, chosen by the owner with Braun's header information and navigation structure. Seed key a6f48bd3. Signature interaction: one expandable summary reveals consecutive tool calls and their results in timeline order; mobile drawer slides open with protected focus. Motion uses fast ease-out; reduced-motion stays static.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
