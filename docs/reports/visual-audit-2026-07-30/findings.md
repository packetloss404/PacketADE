# PacketADE Visual Layout Audit — 2026-07-30

**Method.** Rendered-pixel review, not code reading. Screenshots were captured with
`e2e/visual-audit.spec.ts` (Playwright web mode: Vite dev server + mocked Tauri IPC from
`e2e/setup/mock-tauri.ts`) at 1920x1080 and 1280x720, then reviewed screenshot by
screenshot. The full raw set (both viewports, 21 captures each) lives in the gitignored
`e2e/visual-audit-output/`; this folder holds the curated subset (scaled to max 1400px wide).

**Severity legend:** `high` = looks broken / actively hurts comprehension · `medium` =
clearly sub-par layout or affordance · `low` = noticeable but minor · `polish` = nitpick.

---

## Coverage and web-mode caveats

Captured and meaningfully auditable: Welcome, Workspace (onboarding/empty), Agents
(onboarding modal + empty conversation surface), Flight Deck (empty state), Issues board,
Memory, History, Dictation (partially), Command Palette, all six Settings groups plus the
CLI Clients sub-tab, Cost Dashboard, New Flight (Launch parallel agents) modal, New Issue
modal.

**Not meaningfully auditable in web mode — no conclusions drawn:**

- **GitHub view** — renders a permanent centered "Loading..." because the GitHub IPC is not
  mocked. Nothing about its real layout can be judged.
- **Workspace with live sessions** — PTY/xterm panes never mount in web mode; only the
  no-session onboarding state was audited. Tile layout, tab bar under load, status bars:
  unknown here.
- **Agents with real conversations** — chat stream, tool cards, diff/review UI all need a
  live provider; only the empty composer state was audited.
- **History, Dictation model list, Memory data states, Cost Dashboard with data** — all
  render empty or show mock-invoke errors; empty-state quality was audited, data-dense
  layout was not.
- All screenshots show the state after `localStorage.clear()` — i.e., true first-run.

---

## Per-screenshot findings

### 01-welcome-1920.png — Welcome view
- `low` — The view is a single small centered cluster in a ~1880px-wide void. At 1920x1080
  well over 90% of the canvas is empty. An empty state can be calm, but this one offers only
  one action (New Workspace); recent projects/workspaces or a hint of the app's surfaces
  would earn the space.
- `medium` — Left-rail icons are extremely low contrast against `bg-secondary` (visible only
  on close inspection). First-run users get no hint that the rail is the primary nav — the
  icons read as decoration. No labels, no active highlight on this view (Welcome has no rail
  item), and tooltips are the only discovery path.
- `polish` — Keyboard-hint chips ("Ctrl+K Command palette · Ctrl+Shift+W Workspaces") are a
  nice touch and well-rendered.

### 02-workspace-onboarding-1920.png — Workspace, no sessions
- `medium` — The onboarding column ("Welcome to PacketADE / 1. Open a project folder / 2.
  Pick at least one agent") is vertically pushed down: the logo block starts at ~55% of the
  viewport height, so step 2 and the CLI list run toward the fold while the top half of the
  canvas is empty. The whole column should be centered as a unit or top-anchored.
- `low` — The left "Fleet" sidebar duplicates the guidance ("No sessions yet / Start one
  with New session") while the main canvas says the same thing in more words. Two competing
  empty states on one screen.
- `low` — The red-tinted "No CLIs detected…" strip at the bottom of the checklist reads as
  an error although it is a normal first-run state; amber/informational tone would fit
  better. (In web mode all CLIs report "Not found" by mock, but the styling observation
  stands.)

### 03-agents-onboarding-modal-1920.png — Agents first-visit modal
- `medium` — The "Welcome to Agents" modal auto-opens the first time the view mounts and its
  backdrop swallows every click, including left-rail navigation. During the audit run, rail
  clicks silently did nothing until the modal was dismissed — a real user who clicks away to
  another view gets no response and no visual explanation (the backdrop dim is subtle at
  this size). Consider dismissing on outside-click, or not gating the whole app shell.
- `polish` — The 2x2 feature cards are clean and well-balanced; "Got it" placement is fine.

### 04-agents-empty-1920.png — Agents view, modal dismissed
- `medium` — Ownership of the canvas is ambiguous. Top-left shows a full-width header band
  ("New agent — Choose a project, provider, model, and execution posture"), then ~350px of
  dead space, then the composer floating mid-canvas. The header describes the composer but
  is visually detached from it; the eye has to bridge the gap.
- `low` — Three "new agent" affordances are visible at once: the sidebar `+`, the sidebar
  bottom "+ New agent" button, and the composer itself. Redundancy is defensible but the
  hierarchy between them is not signalled.
- `low` — Filter row "All (0) · Active (0) · Done (0) · Archive (0)" plus a search box for
  zero conversations is noise in the empty state; consider hiding filters until there is
  something to filter.
- Note: provider chip shows "MiniMax (Token Plan) · E2E auth mock" — mock data, ignore the
  content, but chip/segment layout in the composer footer looks tidy.

### 05-issues-board-1920.png — Issues kanban
- `high` — Column layout breaks the board metaphor: five columns (Backlog, Up Next, In
  Progress, Needs Attention, In Review) fill row one, and **Done wraps alone onto a second
  row** with a huge dead area to its right. This happens at 1920 *and* 1280, so it is
  structural (fixed column min-width + wrap), not a narrow-screen artifact. Six columns
  should fit at 1920, or the board should scroll horizontally — an orphaned wrapped column
  looks broken.
- `low` — Row-one columns and the wrapped Done column have different heights, adding to the
  broken impression.
- `polish` — Header row (title chip "Backlog · packetade", filter input, label/flight
  dropdowns, Import spec, New issue) is dense but well-aligned; the dashed "+ Add" targets
  are clear.

### 06-memory-1920.png — Memory view
- `medium` — The right panel ("LAST 30 DAYS", "MEMORY BRIEF") fills content only in its top
  ~35%; below is a hard-edged full-height column of empty dark space. At 1920 the panel
  boundary line runs the whole viewport for no content. Collapse the panel to its content,
  or give it a footer summary.
- `low` — Top strip has two stacked meta rows ("0 patterns · 0 events · 0 tok brief ·
  Refresh · Import" and "Never refreshed · 0 summarized sessions") in 10–11px muted type,
  right-aligned to the far corner — the second row nearly touches the window edge and reads
  as clutter.
- `polish` — The centered "No patterns yet" empty state with guidance copy is good; the
  memory-brief code preview block is a nice concrete touch.

### 07-history-1920.png — Session History
- `high` (as rendered) — A raw internal error string is rendered inline in the content area:
  `[mock-tauri] unhandled invoke: read_prompt_history`. The trigger is the E2E mock, but the
  UI evidently prints backend error strings verbatim into the page body. Real-world backend
  failures would surface the same way. Error states deserve a styled empty-state/error card,
  not raw text at the top-left of an otherwise blank page.
- `medium` — "Prompt History / Active Sessions" tabs are plain text links with no
  underline/container; the active tab is purple text only. Compared to the pill tabs used in
  Settings and Dictation, this is a third tab idiom in the same app (see also Memory's
  pill-with-badge tabs). Pick one.
- `low` — At 1920x1080 the view is ~95% empty below a full-width search box. Web-mode data
  emptiness is expected, but there is no designed empty state at all here ("0 prompts" in
  tiny muted text is not one).

### 08-dictation-1920.png — Dictation view
- `high` (as rendered) — Same raw-error pattern: a red-bordered box in the left panel prints
  `Error: [mock-tauri] unhandled invoke: list_whisper_models` verbatim. Unrepresentative of
  a healthy install, but again shows raw invoke errors are piped straight into UI chrome.
- `medium` — The left panel is a narrow fixed column with a mic circle and one caption in
  its top fifth; the remaining ~80% is empty. Meanwhile the right Analytics pane is also an
  empty state. Two mostly-empty panes side by side.
- `polish` — Mic button with "Click or Ctrl+Shift+V" caption is a clear primary action.
  Analytics/History pill tabs at the top-left of the right pane are consistent with the
  Settings idiom.

### 09-settings-general-1280.png — Settings > General (1280x720)
- `high` — In the Notifications card, the four EVENTS rows (Approval needed, Session
  complete, Session error, Cost threshold alerts) are ~16px tall but their toggle switches
  are taller; the four toggles overlap each other into a fused vertical strip that no longer
  aligns with its rows. Visible at both viewports. Reads as broken; the toggle for "Session
  complete" is not visually attributable to its label.
- `medium` — Card grid balance: Theme card is mostly empty below its two buttons, and the
  right column ends after Notifications while Keyboard Shortcuts sits alone in the left
  column — a masonry hole at the bottom right.
- `polish` — The scope badge ("App") floating at the far right of the Preferences heading is
  easy to miss; its meaning is only clear once you have seen the multi-badge case.

### 10-settings-automation-1920.png — Settings > Automation
- `medium` — Mixed control languages in one card: the YOLO section uses square checkboxes
  ("Auto-recover failed attempts", …) while everything above uses toggle switches. Same
  page, two idioms for boolean settings.
- `low` — The five numeric caps (COST $ / MINUTES / RETRIES / REVIEWS / AGENTS) are packed
  into one row of small inputs with 9px uppercase labels; at this density the group reads as
  a table without gridlines. Slightly more spacing or a bordered group would help.
- `polish` — Trailer format + live PREVIEW block is genuinely good — concrete, monospace,
  self-explanatory.
- `polish` — The "Save autonomy default" button is bottom-left inside the bordered YOLO
  sub-card; every other card on this screen saves implicitly. Explicit-save vs auto-save
  is not signalled anywhere.

### 11-settings-cli-clients-1920.png — Settings > Workspaces & Terminal > CLI Clients
- `medium` — Visual noise from repetition: ten near-identical rows each restate
  "not installed", an Install button, a "Browse…" link, and a tiny status dot at the top
  right corner of the card. The dots are nearly invisible and their meaning (installed
  state?) is unclear next to an explicit "not installed" caption — one of the two encodings
  is redundant.
- `low` — "COMING SOON" rows (Devin, Kimi, Cursor Agent, Mistral Vibe, DeepSeek) are
  interleaved with installable rows in the grid. Grouping available vs coming-soon would
  shorten the scan.
- `polish` — Header strip ("Local CLI · 0 installed · Test · Rescan") is informative and the
  two-column card grid is tidy.

### 12-cost-dashboard-1920.png — Cost Dashboard
- `medium` — Control inconsistency in the header of Guardrail Settings: "On" is a bare
  native checkbox while the rest of the app uses styled toggle switches (see Settings).
  Native checkbox + custom dark theme = visually foreign element.
- `low` — Daily Guardrail card: three short lines in a large bordered box; the bottom half
  of the card is empty. The paired Guardrail Settings card is more densely packed, so the
  row looks lopsided.
- `low` — Stat tiles ("Total Cost / Total Sessions / Input Tokens / Output Tokens") are
  clean, but "$0.00" in accent green implies "good" rather than "no data"; with mocked-empty
  analytics the whole dashboard is empty states, so data-density judgments are out of scope
  here.
- `polish` — The dismissible OpenCode notice banner at the top is well-formed (icon + copy +
  close), a good pattern the raw-error surfaces above should copy.

### 13-modal-new-flight-1280.png — Launch parallel agents modal (1280x720)
- `medium` — At 720px height the modal nearly fills the viewport and its body scrolls; the
  "Require an independent Reviewer Gate" row is clipped mid-checkbox behind the sticky
  footer with no scroll affordance (no shadow/fade), so it looks accidentally cut off
  rather than scrollable.
- `low` — Naming mismatch: the toolbar menu item is "New Flight", the modal is titled
  "Launch parallel agents", and the footer buttons say "Plan first / Launch agents". Flight
  terminology (per project conventions) appears nowhere in the modal title.
- `low` — The modal does not close on Escape (the shared Modal defaults `closeOnEscape` to
  false and this modal doesn't opt in) — for a large form modal, Escape-to-dismiss (with
  dirty-state guard) is the expected affordance. (Found because the audit script's Escape
  press was ignored.)
- `polish` — The three-way "Assisted / Settings default / YOLO" segmented control with a
  one-line explanation underneath is clear and well-weighted; the empty-targets guidance
  ("No workspaces or SSH servers — open a folder or add a server first.") is honest.

### 14-modal-new-issue-1920.png — New Issue modal
- `low` — Header style differs from the Launch modal: no icon, plain-text title, lighter
  visual weight. Two adjacent "create" modals, two header treatments.
- `low` — The label chips ("bug", "feature", …, "working", "devops") wrap into a ragged
  two-line cloud with mixed accent colors; unselected-vs-selected state is not obvious at a
  glance in this render.
- `polish` — TITLE/DESCRIPTION/PRIORITY/STATUS micro-caps labels are consistent inside this
  modal and field alignment is good; the green-focused Title input is a clear entry point.

---

## Summary

### Top visual issues (ranked)

1. **Issues board wraps its sixth column** ("Done") onto a lonely second row with a dead
   right half — at *both* viewports. The single most broken-looking screen in the app.
   (05-issues-board-1920.png)
2. **Raw backend/invoke error strings are rendered verbatim in-page** (History body text,
   Dictation red box). Every error surface should go through a styled error/empty-state
   component like the Cost Dashboard's banner. (07-history, 08-dictation)
3. **Settings > General notification EVENTS toggles overlap/misalign** with their rows —
   fused toggle strip, ambiguous label-to-control mapping. (09-settings-general-1280.png)
4. **Left-rail discoverability**: icon-only, very low contrast, no labels, invisible on
   first run; and the Agents onboarding modal's backdrop silently blocks rail navigation
   when it auto-opens. (01-welcome, 03-agents-onboarding-modal)
5. **Inconsistent boolean controls**: styled toggles vs native checkboxes vs square custom
   checkboxes across Settings, Cost Dashboard, and modals. (09, 10, 12)
6. **Three different tab idioms**: pill tabs (Settings/Dictation), badge-pill tabs (Memory),
   bare text links (History). (06, 07, 08)
7. **Empty-state quality is uneven**: Flight Deck and Memory have designed empty states with
   guidance and CTA; History has none; Workspace has two competing ones; Agents pairs a
   detached header with a floating composer. (02, 04, 07)
8. **Vertical centering/dead space**: Workspace onboarding column pushed toward the fold;
   Welcome and Agents leave >80% of a 1920 canvas empty with no secondary content. (01, 02,
   04)
9. **Modal keyboard/scroll affordances**: New Flight modal ignores Escape and clips its last
   row behind the footer at 720px with no scroll cue; modal header styling differs between
   New Flight and New Issue. (13, 14)
10. **Flight naming drift in the launch flow**: "New Flight" → "Launch parallel agents" →
    "Launch agents"; the word Flight disappears exactly where a Flight is created. (13)

### What genuinely looks good

- **Dark theme discipline** — the token palette holds up everywhere; no clashing raw colors,
  accent green/amber/purple used consistently for semantics; text contrast in content areas
  is generally comfortable at 12/11/10px, reading crisp rather than cramped (the cramped
  exceptions are noted above).
- **Settings information architecture** — six groups, pill sub-tabs, per-section scope
  badges, and a working search; the group header + description + section nav pattern is
  coherent across all six groups.
- **Concrete previews** — commit-trailer live preview (Automation), memory-brief code block
  (Memory), keyboard shortcut chips (General, Welcome) all show-not-tell.
- **The command palette** — clean centered surface, icon + title + description rows, ESC
  chip; consistent with the toolbar's Ctrl+K chip.
- **Empty states where they exist** — Flight Deck's "No flights yet" (icon, explanation,
  single CTA) is the model the weaker views should copy.
- **Toolbar economy** — Search / + New on the left, status chips + Tools/VT/folder on the
  right; small, aligned, unambiguous.

### Reproduction

```
pnpm exec playwright test e2e/visual-audit.spec.ts --project=chromium
```

Output lands in `e2e/visual-audit-output/{1920x1080,1280x720}/` (gitignored). The spec is
tolerant (skip-and-log per view) so it will not fail `pnpm e2e` when a surface breaks; a
broken surface simply produces a screenshot of whatever rendered.
