# defE2End — Stage 1 design brief

defE2End is an open-source, self-hosted E2E regression testing platform for web apps. Teams write no-code test scenarios (steps like navigate, click, fill, assert), run them on a server worker or on their own PC through a desktop app, schedule them, and compare two environments (e.g. production vs staging). Tagline: "Self-hosted E2E regression testing for your web flows". The name is a pun: defend + E2E. Always write the wordmark as **defE2End** with "E2E" visually emphasized (weight or accent color) — text only, never draw a logo.

## Audience and taste (hard constraints)

- QA engineers and developers who live in this tool all day. It must feel like a familiar, well-made admin tool: **left sidebar + main content**, standard tables, standard forms. No experimental layouts (no top-nav-only, no giant typography boards, no tile maps, no icon-only rails).
- **Light theme only.**
- Differentiate with finish: color, typography, spacing rhythm, subtle depth, small details. Not with layout tricks.
- Avoid: rows of gradient stat cards; bootstrap-like gray + white boxes; failure shown as solid red filled areas (use tinted washes, red text/icons, a thin accent edge instead); uniformly low-contrast hairline-only layouts where nothing stands out; wrapping every element in its own card.
- Must NOT resemble another product we know: avoid indigo/violet as the main accent, avoid Pretendard and JetBrains Mono.
- UI language is English. Use fictional data only: sites like `shop.example.com`, `staging.shop.example.com`, workspace "Acme Web", people "Mina Park", "Leo Kim", "Sara Lee". No real company names.

## Screens (each one desktop frame 1440 × 960, `clip: true`)

Shared shell: left sidebar (wordmark, workspace switcher "Acme Web", nav: Dashboard, Scenarios, Runs, Comparisons, Schedules, Settings; user at bottom) + top bar of the main area (page title, breadcrumbs or search, primary action).

1. **Scenarios** — list + editor in one screen. Left part: searchable/filterable list of scenarios (name, tags like `checkout` `smoke`, last result pass/fail, last run time, schedule icon). One scenario selected ("Checkout with saved card"). Right part: its step editor — ordered steps with action type (Navigate, Click, Fill, Select, Wait, Assert text, Screenshot), target selector in mono, value, per-step options hint; buttons "Test run" and "Save". Environment selector (Production / Staging).
2. **Run result** — a failed run of "Checkout with saved card" on Staging. Header: status Failed, scenario, environment, started by Leo Kim (or "Schedule: nightly"), duration 48s, runner on "Server worker" vs "Mina's MacBook", app/runner versions small. Body: step timeline (passed steps compact, failed step 7 "Assert text — Order complete" expanded with expected vs actual, error message in mono, screenshot thumbnail, retry count). Side or below: video player placeholder, screenshot strip. Actions: "Re-run", "Re-run failed only", "Diagnose with AI" (desktop app feature).
3. **Environment comparison** — "Production vs Staging" for scenario "Product detail page". Verdict summary: Different. Visual: two screenshots side by side + diff overlay toggle, visual tolerance "5%" shown and editable, diff 12.4%. Structure diff summary chips: Moved 2 · Only in Production 1 · Only in Staging 3 · Changed 4; a list of grouped element differences, with a long section collapsed ("Show 18 more lines"). Option toggle "Treat links to either domain as same". Per-step selector on the left (step 1..6 with result dots).

Use realistic density. Status colors (pass/fail/running/skipped) must be distinguishable without relying on color alone (icon + label).

## Deliverables per direction

- Define design tokens with `SetVariables(..., true)` first (colors, radii, spacing, font families) — replace the file's existing variables.
- Build reusable components where repetition exists (sidebar, status badge, step row) and reuse them across the three screens.
- Place the three screens left to right on the canvas with 120px gaps, named `A1 Scenarios`, `A2 Run result`, `A3 Comparison` (use your direction letter).
- Also add a small frame `X0 Tokens` above the screens showing the palette swatches, type scale and the wordmark.
- Export each screen and the token frame as PNG to `design/export/` (absolute path on your machine) (`Export([...], "png", path)`).
