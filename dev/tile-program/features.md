# Tile Program — Feature Behavior Specs

Source of truth for **how the conversation-as-tile program should feel and behave**, written for reviewers.
Derived 1:1 from the ruled design spec (`dev/archive/conversation-tile-design.md`, 2026-07-08 consensus) and the
consolidation program's protected keep list (`dev/archive/consensus-ux-consolidation-plan.md`). Every ruling in the
design spec is settled; this document translates rulings into observable behavior, edge cases, empty/error
states, and acceptance checks a reviewer can execute by hand or by running the named gates. Nothing here
re-decides anything. Where a behavior lands in a specific phase, the phase is noted so reviewers judge the
right build against the right checklist.

**Judging rules that apply to every feature below:**

- The `api-agent:*` conversation-engine contract is frozen. No feature may require an event rename, a new
  `start_api_agent_session` parameter, or a change to `createApiConversation` options. `sessionContract.test.ts`
  (Phase 1) is the standing gate.
- The protected keep-list behaviors — fork-and-resend, queued-send-while-streaming, Y/N approvals,
  ReviewSurface/editBaselineStore/reviewStore, PTY persistence, DiffRows/hunkDiff, the notification layer,
  the unified Composer — must pass their existing suites **unmodified** at every phase.
- Reference direction is pane → conversationId only. A conversation never learns where (or whether) it is
  placed. Closing UI never destroys conversation data.

## Shared status vocabulary (used by features 1, 2, and 4)

One five-word attention vocabulary, computed by the read-only projection (`src/lib/sessionIndex.ts`) and the
rollup selector (`src/lib/sessionStatus.ts`). It is the **single truth** for sidebar rows, the tile status
pill, the tab-strip dot, and RunningAgentsChip — no surface computes its own status.

| Status | Meaning (user-facing) | Sources |
|---|---|---|
| `needs_you` | The agent is blocked on you: a pending approval, edit prompt, or plan question. | Conversation: agentApprovalStore + agentPlanStore. PTY: adapter pattern-parser `approval_needed` only. |
| `working` | The agent is actively streaming or executing. | Conversation streaming state; PTY activity (with ~750 ms debounce so it doesn't flicker). |
| `idle` | Alive, waiting for input, nothing pending. | Both kinds. |
| `done` | The conversation's task finished. | **Conversations only.** |
| `failed` | The last turn errored. | **Conversations only.** |

Hard rule: **PTY tiles only ever contribute `working` or `idle`** — a terminal never shows a fake
`done`/`failed`. A workspace row's rollup is the max severity across its member tiles
(`needs_you` > `failed` > `working` > `done` > `idle`).

---

## Feature 1 — Fleet sidebar (Phase 4; virtual-row substrate lands Phase 1)

### What it is

FleetSidebar replaces WorkspaceSidebar as the left sidebar of the Workspaces surface. It is built from
AgentSidebar's strictly-richer machinery and shows **one list with one row unit: the workspace** — every
session you're running (API conversation or CLI terminal, placed in a workspace or not) is reachable from
this one list. AgentSidebar itself dies with AgentsView at retirement (Phase 5).

### Behavior spec

**Row anatomy.** Two lines:

- Line 1: rollup status icon · workspace name · relative time.
- Line 2: member-tile chips in agent colors, e.g. `Claude · Codex ×2 · Terminal`.
- **Single-tile rows omit line 2** and render like today's conversation rows in the Agents sidebar — this
  is deliberate: post-cutover, a user whose sessions are all single conversations sees what looks like
  their old Agents list reorganized under project groups, not a new UI.
- Multi-tile rows whose members individually need attention carry **per-chip amber dots** so you can see
  *which* tile inside the workspace is blocked.

**Needs-you pinned group.** Sessions with rollup `needs_you` are pulled out of their project groups into a
pseudo-group pinned at the top of the list, with an **amber count badge**. Clicking a needs-you row:

1. Activates the workspace (`setActiveWorkspace`).
2. Focuses **and flashes** the offending pane via the workspaceStore focus-pane request mechanism.
3. **Never auto-zooms and never rearranges the layout** — both teams agreed; focus+flash only.

**Filters and search.** Carried over from AgentSidebar: filter chips **All / Active / Done / Archived**;
`/`-triggered search that scans titles and message content; pin; relative time; project grouping with
project-label rename (projectLabels moves to the shared sidebar-prefs store so both surfaces agree during
dual-run). "Active" means rollup `needs_you`/`working`/`idle`; "Done" means `done`/`failed`.

**Virtual rows (unplaced conversations).** Every conversation that is not placed in any workspace, not
archived, and not a Flight Deck attempt appears as a **virtual row** synthesized by sessionIndex. There is
no workspace record behind it — it is a pure projection. Visually it is a single-tile row (agent-label
style). **Clicking it is a materializing mutation**: `sessionGlue.openSession(ref)` idempotently creates a
real workspace (deterministic id `ws-wrap-<convId>`, `origin:"conversation"`, title live-follows the
conversation's auto-title until the first manual rename, then freezes) with a single conversation pane, then
activates it. Clicking the same row twice — or racing a sidebar click against a needs-you click or a deep
link — produces exactly one workspace, ever.

**Archived conversations.** Archived unplaced conversations appear as first-class rows **under the Archived
filter** (this closes the archived-stranding hole: when AgentsView is deleted, nobody's archived history
becomes unreachable). Unarchiving one materializes a fresh wrapper workspace.

**Archive lifecycle (workspace rows).** Archiving a workspace:

- Kills member PTYs **on archive — never on workspace switch** (the P0-2 lesson is a named gate).
- Archives member conversations; **transcripts are always kept**.
- Applies the worktree cleanup policy (see Feature 4).
- Deleting a workspace **detaches** its conversations (they revert to virtual rows / archived rows);
  it never destroys transcripts.

**Status truth.** The sidebar row status, the tab-strip dot, and RunningAgentsChip all read
`sessionStatus.ts`. If they ever disagree, that is a bug by definition.

### Edge cases

- **Flight Deck attempts never appear.** Attempt conversations are excluded via a read-layer lookup set of
  flight attempt sessionIds. Starting a flight with N attempts adds zero sidebar rows.
- **200+ legacy conversations**: all render as virtual rows with stable identity across restarts; the
  reconciliation-scale gate asserts zero conversation-file mutation. Sidebar list rendering must use
  per-slice subscriptions — a streaming frame in one conversation must not re-render the full list.
- **Rename freeze**: a workspace whose title was manually renamed stops live-following the conversation's
  auto-title permanently, even if the conversation later re-titles itself.
- **A workspace whose conversation pane was stripped by an old binary** (downgrade round-trip) shows the
  conversation again as an unplaced virtual row after the startup reconciliation sweep — no user action.
- **Auto-archive** (hourly sweep) archives rows the same way explicit archive does, except it can never
  prompt or toast, and its worktree policy is always Keep (Feature 4).
- Needs-you click when the offending pane is inside a zoomed sibling: focus+flash still applies; zoom state
  is not changed by the click.

### Empty / error states

- **Empty fleet** (no workspaces, no conversations): the workspace zero-state hosts AgentsOnboarding
  (re-homed in Phase 5) and the inline AddAgentPicker (Feature 3) — first-agent and Nth-agent are one flow.
- **Search with no hits**: standard empty search state; filter chips remain operable.
- **Conversation file missing/corrupt** behind a virtual row: the row renders from the index (title may fall
  back to id); opening it materializes the workspace whose tile then shows the missing-conversation fallback
  (Feature 2). No crash, no silent row disappearance.

### Acceptance checks

1. Create one workspace with a Claude conversation tile + two Codex tiles + a terminal. Sidebar row shows
   line 2 `Claude · Codex ×2 · Terminal`; a workspace with only one conversation shows no chips line.
2. Trigger a pending approval in one tile of a multi-tile workspace: row moves to the pinned needs-you group,
   amber count increments, the specific member chip carries an amber dot. Click the row: workspace activates,
   the offending pane flashes and has focus, layout and zoom unchanged.
3. Leave a terminal tile idle overnight: its row never shows `done` or `failed`.
4. With 20 legacy unplaced conversations: all appear as virtual rows; restart the app twice — row order and
   identity stable; `ls`/hash the conversation files before and after — byte-identical (zero mutation).
5. Click a virtual row twice fast, then deep-link to the same conversation: exactly one workspace exists,
   id `ws-wrap-<convId>` (openSession idempotence gate).
6. Rename a materialized workspace, then let the conversation auto-title: sidebar title stays the manual name.
7. Archive filter: archive an unplaced conversation (in the Agents tab pre-Phase-5, or via row action after);
   it appears under Archived; unarchive → a fresh wrapper workspace materializes.
8. Archive a workspace with a live PTY: PTY process dies. Switch away from a workspace with a live PTY:
   process survives (verify with `ps` before/after both actions).
9. Start a flight: sidebar row count does not change.
10. Dual-run gate (Phase 4): AgentSidebar and FleetSidebar mounted on the same store state report identical
    needs-you counts; parity checklist (search, pins, archive filter, needs-you counts, project rename)
    signed off before the "Sessions have moved" banner appears on the old tab.

---

## Feature 2 — Conversation tile (Phase 3)

### What it is

An agent conversation becomes a tile placeable next to terminal tiles in the workspace mosaic.
`ConversationTile.tsx` (~140 LOC) wraps the **unforked** AgentChatPane, which gains exactly two additive
props — `frame: "standalone" | "tile"` and `keyboardScopeActive` — with defaults preserving today's
standalone behavior byte-for-byte. The tile's face **is** the chat: same transcript, approvals, ReviewBar,
review surface, and composer, mounted unmodified.

### Behavior spec

**Chrome.** In `frame="tile"`, AgentChatPane's existing 33 px header doubles as tile chrome:

- Drag grip (MosaicWindowContext.connectDragSource), agent color dot, title, status pill (from the shared
  vocabulary), zoom button; double-click on the header zooms.
- Always-visible narrow set — exactly three cheap chips: **AgentModeChip** (safety posture),
  **Changes diffstat chip** (the review entry point), and the **amber approval badge**.
- Heavy controls (ModelSelector, ContextUsageRing, HeaderActions, SSH indicator) live in the overflow menu
  and **mount lazily** only when the menu opens or the tile is zoomed — never mounted at rest in a narrow tile.
- Interim visual-parity requirement (until the post-retirement PaneHeaderShell refactor): grip, color dot,
  title, status pill, and zoom sit in the **same positions** as terminal tile headers, so the two tile kinds
  read as one header grammar even though the code is not yet shared.
- Visual collapse at narrow widths is raw CSS `@container` only — no ResizeObserver, no width JS.

**Close semantics.** The header **X removes the pane only.** The conversation survives, untouched, and
reappears in the fleet sidebar as an unplaced virtual row. **Archive is a separate, explicit overflow-menu
action.** Closing a tile is a layout operation, never a lifecycle operation. (One-directional GC: deleting a
conversation prunes its panes; removing a pane never touches the conversation.)

**Zoom.** Zoom is the existing CSS-maximize (`setZoomedPane` → `data-pane-zoomed` styling): siblings become
`visibility:hidden`, **nothing remounts** — PTY scrollback and all React state in sibling tiles survive.
This is law (the P0-2 duplicate-spawn lesson); zero new zoom machinery is added.

- Opening the full ReviewSurface **auto-zooms** the tile first — ReviewSurface never renders at raw tile
  width (blind-accept hazard, rejected by both teams).
- `autoZoomedBy` bookkeeping: closing the review un-zooms **only if the review caused the zoom**; if the user
  zoomed manually first, closing review leaves the tile zoomed.

**Keyboard scope (Y/N approvals) — the phase's first commit, hard-blocking the rest.** ReviewBar's
document-level Y/N keydown gains only an **arming condition**:

- No pane context (standalone AgentsView): armed exactly as today — behavior byte-identical.
- Pane context: armed **iff** `layoutStore.activePaneId` matches this tile. The tile sets activePaneId on
  pointer-down, same as TerminalPane. Two tiles with pending edits: one Y keypress applies to the focused
  tile only.

**Escape layering** is condition-based, strictly ordered: open comment composer closes first → then
ReviewSurface → and the mosaic zoom-exit **no-ops while `reviewStore.open`**. Review-close and zoom-exit can
never double-fire from one keypress.

**Composer.** The unified Composer pins at the tile bottom, wiring unchanged. Drafts are per-conversation
(agentDraftStore), so N tiles have independent drafts and queued-send queues with zero new code.
Stop/Send never hides at any tile width (only the mic folds). The approval/diff-comment/ReviewBar stacking
order above the composer is preserved pixel-for-pixel in tile frame.

**First-run draft tile.** Picking a chat agent (Feature 3) inserts a draft tile: sparkle avatar,
"Describe the task to start", and composer **footer chips for model / safety mode / worktree**. After the
first send, the chips fold into the header (mode chip). No pre-creation modal exists anywhere.

**Ordering invariant.** The conversation is created in agentTaskStore **before** the pane is inserted —
there is never a half-born tile pointing at a nonexistent conversation.

**Streaming.** All tiles render live by default (watch-many is the product posture). Perf gate: 4 concurrent
streams in a 2×2 mosaic hold p95 frame < 16 ms on reference hardware. On breach, the named fallback engages:
non-focused streaming tiles coalesce to 4 Hz batched flushes via the injectable ScheduleFrame scheduler
(focused tile stays per-frame), and the gate re-runs. Non-streaming tiles must not re-render on another
tile's flush (profiler assertion). `aria-live` announcements come from the focused tile only.

### Edge cases

- **Two tiles, one keypress**: only the focused tile's pending edit is applied/rejected; the other tile's
  queue is untouched.
- **Zoomed tile + review open + Escape**: closes review (or its comment composer first); the tile stays
  zoomed until a second Escape, and only un-zooms on review-close if `autoZoomedBy` says review zoomed it.
- **Dragging** a conversation tile by its grip rearranges the mosaic exactly like a terminal tile.
- **Fork-and-resend / queued-send inside a tile**: identical behavior to standalone; suites run with two
  tiles mounted (Phase 3 gate).
- **Draft tile abandoned** (workspace closed before first send): no conversation turn was started; the draft
  conversation record follows existing draft semantics — no orphaned "working" row may appear in the sidebar.
- A conversation tile in an SSH workspace shows the SSH indicator in overflow; composer and approvals work
  identically (execution context came from `conversation.sshTarget`, Feature 3).

### Empty / error states

- **Loading**: header renders immediately from the session record (title/color/status); the transcript area
  may fill in after hydration. No blank-header flash.
- **Missing conversation** (file deleted, id dangling): tile face shows a fallback message with a
  **Remove tile** action. Removing it deletes the pane only.
- **Failed turn**: status pill goes red (`failed`); the tile face offers `retryLastTurn`. No toast storm —
  the notification layer already covers session errors.
- **Empty conversation** (created, nothing sent): the first-run draft-tile face with footer chips.

### Acceptance checks

1. Place a conversation tile beside a terminal with scrollback. Zoom the conversation tile, open ReviewSurface,
   close it, un-zoom: terminal scrollback intact, no PTY reconnect in logs, React DevTools shows zero
   remounts of the sibling (existing `data-pane-zoomed` CSS path only).
2. Two conversation tiles with pending edits. Click tile A, press Y: only A's edit applies. Press Y again:
   nothing happens in B until B is clicked. In standalone AgentsView the same flow is byte-identical to
   pre-program behavior (dual-mode tests green).
3. Open review from the Changes chip in an unzoomed tile: tile auto-zooms first; close review: tile un-zooms.
   Zoom manually, open review, close review: tile **stays** zoomed.
4. Press X on a conversation tile: pane disappears, sidebar immediately shows the conversation as an unplaced
   row; reopening from the sidebar restores the full transcript. Archive (overflow) instead: conversation
   moves under the Archived filter.
5. Type half a message in tile A, switch to tile B and type: switch back — both drafts intact and independent;
   queued-send while A streams still delivers in order (suites unmodified, two-tile variant green).
6. Narrow a tile below chip width: header collapses via CSS; ModelSelector/ContextUsageRing are **not
   mounted** (React DevTools) until the overflow menu opens or the tile zooms; Stop/Send visible at every width.
7. Add a chat agent: draft tile appears with model/mode/worktree footer chips; send the first message; chips
   fold into the header. No modal appeared at any point.
8. Run 4 streaming conversations in a 2×2 mosaic on reference hardware: p95 frame < 16 ms; if the fallback is
   engaged, non-focused tiles visibly update ~4×/second while the focused tile stays smooth; a fifth,
   non-streaming tile shows zero re-renders in the profiler during flushes.
9. Protected suites (fork-and-resend, queued-send, Y/N, ReviewSurface applyPipeline, streamCoalescer ordering)
   pass with **zero modifications** to their files.

---

## Feature 3 — Add-agent picker (Phase 3)

### What it is

One entry point for adding any agent to a workspace: `AddAgentPicker`, a single searchable popover (reusing
the Dropdown-searchable machinery ProviderPicker uses). It replaces the flat inline dropdown in
WorkspaceView's header (same anchor), backs the FleetSidebar's "New session" CTA (with a project picker),
and renders inline, centered, as the workspace zero-state — first agent and Nth agent are one flow.
Explicitly rejected: separate Add-CLI/Add-conversation buttons; any runtime-first wizard.

### Behavior spec

**Two labeled sections, capability language — never transport language:**

1. **"Chat agents"** (first — the new default face): flattened API providers — Claude OAuth, Claude API,
   Codex ChatGPT, OpenAI, OpenRouter, MiniMax, Ollama — each row: color dot · name · default-model subtext ·
   AuthBadge with the inline Log-in affordance lifted from ProviderPicker.
2. **"Terminals"**: the six CLI slots — Claude Code, Codex CLI, Gemini CLI, OpenCode, PacketCode, Terminal —
   each row: agent-color dot · name · installed-gating via the existing `isAgentInstalledForWorkspace` with
   INSTALL_HINTS tooltips; SSH awareness unchanged from today.

The same vendor legitimately appears in both sections; section headers disambiguate search hits — typing
"cla" shows Claude under Chat agents **and** Claude Code under Terminals. One filterable list; search
filters across both sections simultaneously.

The catalog behind the picker is a thin static read-layer registry joining `lib/api-models.ts` and
`src/agents/*` under capability flags (`{face, supportsApprovals, supportsSsh, models[]}`). Neither source
of truth moves.

**Selection semantics:**

- **Terminal row → instant pane.** Today's zero-friction behavior: the pane appears immediately, PTY starts
  per existing rules. No intermediate step.
- **Chat row → draft conversation tile.** The picker answers *who*; the tile answers *how*: model, safety
  mode, and worktree are chips in the first-run composer footer (Feature 2), folding into the header after
  first send. No pre-creation modal.

**Capability-filtered mode pickers.** The safety-mode chip in the draft tile is filtered per runtime.
PermissionMode is exactly `auto | ask_for_risky | allow_all | deny_all` (agent-conversation.ts:50 — there is
no "Manual" mode). For **Codex ChatGPT**, whose exec adapter cannot service any approval round-trip (every
mode maps to sandbox+never; stdin is closed — the `-a on-request` route was tried and reverted in baa8be1):

- Only honorable postures render, **relabeled in sandbox vocabulary: Read-only / Workspace-write / Full
  access** — never approval-implying labels.
- Tooltip: "Codex (exec) can't pause for approvals — the sandbox is the safety boundary."
- The true posture chip shows in the tile header for the life of the session.
- `deriveMode`/`flagsForMode` and the sidecar are untouched — this is a catalog/chip-layer filter
  (`capabilities.supportsApprovals=false` on `api-openai-codex`), shipped in Phase 1 in the existing UI and
  inherited here.

**SSH inheritance.** Adding a chat agent in a remote workspace auto-inherits SSH: `workspace.serverId`
becomes `conversation.sshTarget`. No extra prompt; the SSH indicator appears in the tile's overflow. Adding
a terminal in a remote workspace behaves exactly as today.

**Templates.** Workspace templates stay a creation-time, workspace-scoped concept behind a single
"Workspace templates…" footer row that opens the existing flow. They do not appear as picker sections.

### Edge cases

- **Uninstalled CLI**: row visible but gated, INSTALL_HINTS tooltip explains how to install; not silently
  hidden.
- **Unauthenticated provider**: AuthBadge shows state; inline Log-in runs the existing ProviderPicker flow
  without closing the picker context; after auth the row becomes selectable.
- **Search hit in both sections**: both rows render under their headers; keyboard navigation crosses the
  section boundary in list order.
- **Zero-state variant**: same component rendered inline and centered; selecting behaves identically
  (terminal → first pane; chat → draft tile as the first pane).
- **Sidebar "New session" CTA**: identical picker plus a project picker step (the workspace must know its
  projectPath before a tile can exist).
- **Ollama with no local models**: default-model subtext falls back gracefully (the models list comes from
  the existing one-shot gated fetch — no polling).

### Empty / error states

- **Search no-match**: empty state inside the popover; Escape closes; the anchor button is unchanged.
- **No providers authenticated and no CLIs installed**: both sections render with their gates/badges — the
  picker is the discovery surface, so it never renders blank.
- Provider auth failure: surfaces in the existing login affordance's error slot; picker state is preserved.

### Acceptance checks

1. Open the picker from the workspace header, the sidebar CTA, and the zero state: same component, same two
   sections, Chat agents listed first in all three.
2. Type "cla": exactly two hits under two headers (Claude / Chat agents, Claude Code / Terminals); select
   each — chat yields a draft tile, terminal yields an instant pane.
3. Add a Codex ChatGPT chat agent: the mode chip offers **only** Read-only / Workspace-write / Full access;
   no `auto`/`ask_for_risky`-style approval language anywhere; tooltip present; posture chip visible in the
   header after first send. Snapshot gate: Codex mode UI shows only honorable postures.
4. Add a Claude chat agent: the full PermissionMode set renders (capability-unfiltered runtimes unchanged).
5. In a remote (SSH) workspace, add a chat agent: `conversation.sshTarget` equals the workspace's server;
   no extra prompt appeared.
6. Uninstall (or rename away) a CLI binary: its Terminals row is gated with the install hint; nothing else
   in the picker changes.
7. "Workspace templates…" footer row opens the existing template flow; templates are absent from both
   sections.
8. Verify no second add-agent entry point exists in WorkspaceView's header (the flat dropdown is gone, same
   anchor reused).

---

## Feature 4 — Endings: git panel, worktree lifecycle, pending badge, clickable diffs (Phases 1–2; tile scoping Phase 3+)

### What it is

One ending for both tile kinds: the existing GitDashboard slide-out (props stay bare
`{projectPath, workspaceId?, serverId?}`) becomes **focused-pane-scoped**, gains a
**WorktreeLifecycleBar**, and its file rows become clickable diffs. This closes the worst live bug —
unlandable worktrees (`removeConversationWorktree` verifiably has zero callers today; no local merge exists
in src-tauri). Rejected by both teams: per-tile embedded git panels, a separate commit modal.

### Behavior spec

**Scoping.** When the focused tile is a conversation with a worktree, the panel targets
`worktree.worktreePath` (branch `pkt/<convId>`), with a **header scope switcher** back to the workspace
root. When the focused tile is a terminal (or no conversation worktree exists), it targets the workspace
root as today.

**Reaching it.** A **"Finish → Commit…" CTA** appears on the protected, unmoved ReviewBar when a session
goes `done`/`idle` with reviewed changes. Full loop: stream → ReviewSurface (auto-zoomed) → Finish →
stage/commit → Land → cleanup. During Phase 2 (pre-tile), the WorktreeLifecycleBar is reachable from the
Agents tab through an explicitly disposable ~30-LOC modal host, deleted in Phase 5.

**WorktreeLifecycleBar — four actions:**

1. **Merge back** (default; squash). Net-new Rust command `merge_conversation_branch(projectPath, branch,
   squash=true)`, gated on the existing `git_safety_check` clean-root guard.
   - Dirty root checkout → **refuses** with the existing feedback slot; nothing is touched.
   - Conflict → aborts, surfaces in the existing feedback slot, and leaves **both** the worktree and the
     user's root checkout intact.
   - Success → deletes `pkt/<convId>` with `-D` (squash leaves no ancestry for `-d`), removes the worktree
     dir, flips `worktree.state → landed`.
2. **Create PR.** `publishBranchAsPr`, extracted behavior-preserving from
   `asyncFlightStore.publishAttemptAsDraftPr` into `src/lib/gitPublish.ts` (push → create PR), shared by
   flights and sessions. **Records the PR number** — it feeds the cleanup predicate below.
3. **Discard.** First-ever wiring of `removeConversationWorktree` (tauri.ts:611) plus flag-gated branch
   delete, **behind a confirm**. Discard is the only path allowed to remove a dirty tree, and only after
   the confirm. Every non-Discard removal path dirty-checks first.
4. **Keep for later.** Worktree retained; the session shows a visible **"worktree pending" chip** until the
   worktree is landed or discarded.

**Pending badge.** The "worktree pending" chip is the standing signal for unlanded work: it appears on the
session (tile header / sidebar row surface area) whenever `worktree.state === "active"` with the session
otherwise finished or archived-with-Keep. Its failure mode is visible accumulation — never silent loss.

**Cleanup-on-archive policy** (setting: `never / only-when-safe [default] / always`):

- Safe predicate: worktree clean AND (ancestry-merged OR recorded-PR-reports-merged OR zero commits ahead
  of base). Anything else conservatively **Keeps** with the chip.
- **Auto-archive always Keeps** — the hourly sweep structurally cannot prompt, so it never cleans.
- **Explicit** archive of a workspace with unlanded work raises a **non-blocking notification-layer toast**
  with a "Review worktree" action — no modal, no second codepath.

**Clickable diffs (Phase 1, ships regardless of the program).** GitDashboard file rows become clickable:
row click opens a diff popover/panel reusing the existing DiffRows/hunkDiff components **unmodified** over a
plain git-diff fetch for that file. Works in both mount points (WorkspaceView slide-out, FlightsView). This
kills blind commits.

**Legacy worktrees** (created before `conversation.worktree` existed): path/branch derived at the read layer
from `.pkt-worktrees/<convId>` only — never persisted at hydration. `baseBranch` is unknown, so the
lifecycle bar requires an **explicit base picker** (defaulting to the repo default branch) before Merge
back, and ahead-counts are labeled **approximate**.

**SSH sessions.** Land (Merge back) is disabled with the existing remote-read-only message until remote git
write ships. Create PR/Keep semantics follow the same remote-read-only gating.

### Edge cases

- Merge back with the root checkout dirty: refusal message; retry succeeds after the user commits/stashes.
- Merge conflict mid-squash: worktree intact, root intact, conflict message in the feedback slot — the user
  can resolve in the worktree and retry, or Create PR instead.
- Squash-merged then archived under only-when-safe: the recorded-PR / zero-ahead predicate arms recognize it
  as safe despite no merge ancestry.
- Discard on a dirty worktree: confirm dialog is mandatory; after confirm, dir and (flag-gated) branch are
  removed.
- Keep, then reopen the session weeks later: the chip is still there; the lifecycle bar still offers all
  four actions.
- Scope switcher: with a conversation tile focused, switch to workspace root, commit something there, switch
  back — the panel re-targets the worktree without losing panel state unexpectedly.
- Two conversation tiles with worktrees in one workspace: the panel follows focus; the scope header always
  names its current target.

### Empty / error states

- Focused conversation has no worktree: panel behaves exactly as today (workspace root); no lifecycle bar.
- Worktree dir missing on disk but `state:"active"`: the lifecycle bar surfaces the inconsistency rather
  than acting on a phantom path; Discard (metadata cleanup) remains available.
- PR creation failure (network/auth): surfaced in the existing publish error path; no state flip, worktree
  untouched.
- `merge_conversation_branch` failure of any kind must never leave a half-merged root: abort semantics are
  the gate.

### Acceptance checks

1. Fixture-repo lifecycle vitest (Phase 2 gate): create → commit in worktree → Merge back → assert squash
   commit on base, `pkt/<convId>` deleted via `-D`, dir removed, `state === "landed"`.
2. Dirty the root checkout, click Merge back: refusal, zero changes to root or worktree. Create a conflicting
   edit on base, Merge back: conflict message, both trees intact.
3. Create PR: draft PR exists on the fork/branch; PR number recorded on the session; flight draft-PR publish
   tests pass unchanged post-extraction (flights and sessions share gitPublish).
4. Discard a dirty worktree: confirm required; after confirm dir and branch gone. Verify no non-Discard path
   (archive cleanup, merge failure, anything) ever removes a dirty tree (Phase 2 gate).
5. Keep for later: chip visible on the session; still visible after app restart; clears on later Merge
   back/Discard.
6. Archive tests: unlanded dirty worktree archived under only-when-safe → Kept with chip; clean +
   zero-commits-ahead → cleaned silently; auto-archive with unlanded work → always Kept, no toast; explicit
   archive with unlanded work → non-blocking toast with working "Review worktree" action.
7. Click a modified-file row in GitDashboard (both WorkspaceView and FlightsView mounts): the correct file's
   diff opens, rendered by the existing DiffRows/hunkDiff (no new diff code); DiffRows/hunkDiff suites
   untouched-green.
8. Legacy conversation with a `.pkt-worktrees/<convId>` dir: lifecycle bar demands a base pick before Merge
   back; ahead-count is labeled approximate; nothing was written to the conversation file at hydration.
9. SSH session: Land disabled with the remote-read-only message.
10. ReviewBar CTA: appears only when the session is `done`/`idle` with reviewed changes; ReviewSurface/
    editBaselineStore/reviewStore suites pass with zero modifications (the CTA is additive to ReviewBar only).

---

## Feature 5 — Migration & retirement (Phases 1, 4, 5)

### What it is

Existing conversations are never bulk-migrated; the Agents tab retires only after the fleet sidebar proves
parity, and survives one release as an invisible redirect. Downgrade is safe by construction (inert carrier
+ self-healing reconciliation). The morning-after experience must read as "my Agents list, reorganized under
projects" — never as data loss.

### Behavior spec

**Upgrade morning.** On first launch of the new build:

- **Zero writes occur.** No conversation file is mutated; no workspace records are created. All existing
  conversations simply appear as rows in the fleet sidebar — virtual rows synthesized by the read-only
  projection (placed, unplaced, and archived alike; flight attempts excluded).
- Because single-tile rows render agent-label style (Feature 1), a user with only conversations sees a
  sidebar visually equivalent to the old Agents sidebar, grouped by project, needs-you pinned on top.
- A workspace record is materialized **only when a conversation is opened or touched**, via the single
  shared `sessionGlue.openSession(ref)` — used identically by sidebar clicks, needs-you clicks, and the
  retirement redirect shim. Identity spec: deterministic `ws-wrap-<convId>`, `origin:"conversation"`,
  title live-follows the auto-title until first manual rename, then freezes.
- WorkspaceView never renders synthetic records — there is no dual render path.

**Downgrade safety (the inert-carrier ruling).** Conversation panes persist `agent_id:"terminal"` as a
documented inert carrier; `kind`/`conversation_id` are `#[serde(default)]` optional fields:

- An **old binary** parses the state file fine (the `From<String>` "terminal" arm, never the catch-all),
  renders the conversation pane as a **harmless terminal pane** (benign shell tile — annoying, never
  destructive), and on re-save silently drops `kind`/`conversationId`.
- On return to the **new binary**, the idempotent startup **reconciliation sweep** notices the orphaned
  conversation (non-archived, non-flight, unreferenced) and re-surfaces it as an unplaced virtual row.
  Self-healing; conversation files untouched throughout. There is **no version refusal** anywhere — a
  downgraded binary must never be locked out of the monolithic state file.
- The sweep is reconciliation, not a one-shot migration: re-running it is always a no-op-or-repair, with no
  guard keys.

**Mounted-cost bound (Phase 4 gate).** 20 materialized conversation-only workspaces behind `display:none`
must hold near-zero idle CPU with bounded document-listener count. Named fallback if breached:
mount-on-activation **only** for workspaces containing zero PTY panes — the PTY keep-all-mounted pattern is
never modified.

**Retirement (Phase 5).** Six entry points retarget:

1. LeftRail "Agents" item — removed.
2. `Shift+1` — remapped to the new surface.
3. App.tsx view switch — the `"agents"` CoreView becomes a redirect shim.
4–6. The three deep-link producers (promptStore.ts:105, RunningAgentsChip.tsx:88,
   PinnedApprovalBanner.tsx:71) — re-pointed to `openSession` + focus-pane request, so notification deep
   links land on the correct workspace with the offending tile **focused and flashed**, its pending
   approval visible.

**The one-release redirect.** The `"agents"` CoreView literal survives exactly one release as an invisible
shim: any navigation to it (stale deep link, persisted `activeView='agents'` cold start) resolves
`selectedConversationId` through the same materializing `openSession` path and lands on a **real workspace —
never a blank view**. The release after, the shim and literal are deleted.

**Hoisted survivors** (same phase, so nothing regresses when AgentsView dies): `Ctrl+N` (new session) and
`Ctrl+Shift+V` (transcript view-mode cycler) move to App level; the hourly `sweepAutoArchive` interval moves
from AgentsView's mount effect to an App-shell effect; AgentsOnboarding re-homes to the workspace
empty-fleet state; launch logic already lives in `launchConversation.ts` since Phase 1.

**Deletion gate.** AgentsView, AgentSidebar, the standalone launch-variant composer path, and Phase 2's
disposable modal host are deleted only after: the FleetSidebar parity checklist signs off (search, pins,
archive filter, needs-you counts, project rename) and the dual-run parity gate shows identical needs-you
counts on the same store state. During dual-run, the old tab carries a "Sessions have moved" banner.

### Edge cases

- **Upgrade with 200+ conversations**: sidebar populates from the projection without jank; restart twice —
  stable virtual-row identity, zero conversation-file writes (reconciliation-scale gate).
- **Old-binary re-save round trip** (the Phase 1 gate, not just a parse test): new build creates a
  conversation tile → downgrade → old build re-saves (stripping kind/conversationId) → upgrade → sweep
  re-surfaces the conversation as an unplaced row; the leftover carrier pane is reconciled; conversation
  file byte-identical.
- **Stale notification clicked after retirement**: a pinned-approval deep link from before the cutover still
  lands on the materialized workspace with the tile flashed and the approval visible.
- **Persisted `activeView='agents'` cold start with no `selectedConversationId`**: the shim lands on the
  Workspaces surface (fleet sidebar), never a blank view.
- **Archived conversations at retirement**: reachable under the fleet sidebar's Archived filter (Feature 1);
  nobody is stranded by AgentsView's deletion.
- Flight Deck through it all: attempt conversations never appear, `publishAttemptAsDraftPr` consumers keep
  passing post-extraction, and the frozen `api-agent:*` contract means Flight Deck behavior is bit-identical.

### Empty / error states

- Sweep encounters a corrupt/unreadable conversation file: skip and log; never abort the sweep or mutate the
  file; remaining rows still surface.
- `openSession` on an id whose conversation vanished between index and click: no workspace is materialized
  for a dead ref; the row disappears on next reconciliation rather than producing an empty wrapper.
- Redirect shim with an id that no longer resolves: falls through to the Workspaces surface with the fleet
  sidebar — never blank, never a crash.

### Acceptance checks

1. **Upgrade-morning check**: snapshot conversation-file hashes and the workspaces slice; launch the new
   build; sidebar shows every non-flight conversation as a row; hashes and workspace slice byte-identical
   until the first click.
2. **Materialize-on-open**: click a legacy row; a workspace `ws-wrap-<convId>` with `origin:"conversation"`
   exists; click again / deep-link — still exactly one (idempotence gate).
3. **Downgrade drill** (executable end-to-end): create a conversation tile on the new build; run the old
   build — the pane renders as a plain terminal tile, app fully usable, no crash, no data loss; interact so
   it re-saves; return to the new build — the conversation is back as an unplaced sidebar row; its file
   never changed (old-binary re-save simulation gate).
4. **Redirect release**: with persisted `activeView='agents'` and a `selectedConversationId`, cold-start:
   lands on the materialized workspace, never blank. Click a RunningAgentsChip and a PinnedApprovalBanner
   deep link: each lands focused+flashed with the pending approval visible (end-to-end gate).
5. **Keybinding gate**: after retirement, `Shift+1`, `Ctrl+N`, `Ctrl+Shift+V`, and `/`-search all work in
   their new homes; auto-archive still sweeps hourly (App-level interval test).
6. **grep-clean gate**: zero `setActiveView("agents")` call sites outside the shim; zero imports of
   AgentsView/AgentSidebar/the disposable modal host after deletion.
7. **Mounted-cost gate**: materialize 20 conversation-only workspaces; idle CPU near zero, document listener
   count bounded (Y/N keydown listeners must not scale unbounded with hidden workspaces); if the fallback
   engaged, verify PTY-bearing workspaces are still keep-all-mounted.
8. **Full keep-list smoke in tile context** (Phase 5 exit): fork-and-resend, queued-send, Y/N approvals,
   PTY persistence, DiffRows/hunkDiff, ReviewSurface/editBaselineStore/reviewStore, notification layer,
   unified Composer.

---

## Cross-feature reviewer notes

- **One status truth**: any disagreement between a sidebar row, a tile pill, the tab-strip dot, or
  RunningAgentsChip fails review — all four must read `sessionStatus.ts`/`sessionIndex.ts`.
- **No new endings, no new zoom, no new diff renderer**: GitDashboard is the only git surface,
  `setZoomedPane`/`data-pane-zoomed` the only zoom, DiffRows/hunkDiff the only diff machinery. A PR
  introducing a parallel implementation of any of these contradicts a settled ruling.
- **Naming discipline**: `startApiAgentSession`'s existing `workspace` parameter means local-vs-SSH
  *execution* context (the R0 contract), never UI placement. Reviewers should reject any code or copy that
  conflates it with the workspace-tile concept.
