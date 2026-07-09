# Conversation-as-Tile Program — Sprint Plan

Source of truth: `dev/conversation-tile-design.md` (FINAL ruled spec, 2026-07-08). This document decomposes
its 5 phases into 16 ordered work items, each sized for one strong implementation agent in one sitting,
each leaving the tree green and committable. Nothing here re-decides a ruling; where the code contradicted
a spec detail on contact, it is listed under **Flagged risks** at the bottom, not silently re-decided.

Verification conventions (repo rules): `pnpm tsc`/typecheck + eslint + vitest; **never** run prettier on
`src/`. PTY spawn machinery (vendored portable-pty / `__pty_spawn`) is never touched by any sprint.

Global constraints binding EVERY sprint:

- The `api-agent:*` contract is frozen: zero event renames/additions, `startApiAgentSession` gains no
  parameters, `createApiConversation` options (`explicitId`, `skipBackendStart`) stay byte-identical
  (Flight Deck proof surface: `src/stores/asyncFlightStore.ts` ~465–501).
- NEVER modify: `src/components/agents/review/` internals beyond the explicitly additive changes named
  per-sprint, `src/stores/editBaselineStore.ts`, `src/stores/reviewStore.ts`, the Composer
  (`src/components/agents/composer/Composer.tsx`) wiring, `src/lib/streamCoalescer.ts` semantics, or any
  PTY code path.
- Protected suites must pass **unmodified** every sprint: `agentForkAndResend.test.ts`,
  `agentQueuedSend.test.ts`, `agentWorkspaceDecoupling.test.ts`, `agentApprovalStore.test.ts`,
  `reviewStore.test.ts`, `editBaselineStore.test.ts`, `streamCoalescer.test.ts`, `asyncFlightStore.test.ts`,
  `agentTaskStoreCleanup.test.ts`, plus (once landed in P1-S3) `sessionContract.test.ts`.
- Reference direction is pane→conversationId ONLY; `AgentConversation` never gains a `workspaceId`.
- Do not commit unless the tree is green.

Ordering hard-rules (from the spec): P1 → P2 → P3 → P4 → P5. P3-S1 (keyboardScopeActive) hard-blocks
every later P3 sprint — ConversationTile must not register in `renderTile` before P3-S1's dual-mode tests
are green. P1-S2's reconciliation sweep must exist before P4's FleetSidebar virtual rows.

---

## Phase 1 — Foundations, contract pin, honest fixes (1.75 ew)

### P1-S1 — Pane schema: kind/conversationId in TS + Rust + DTO, inert carrier, normalizePanes

**Goal.** `WorkspacePane` gains the `kind` discriminant and `conversationId` on both sides of the
serde/DTO boundary, with the downgrade-safe inert carrier, so a conversation pane round-trips
save/load and an old binary degrades to a harmless terminal pane.

**Files.**
- `src/types/workspace.ts` (line 3, `interface WorkspacePane`): add `kind?: "terminal" | "conversation"`
  and `conversationId?: string`. Absent kind ⇒ terminal. Invariant: `conversationId` set iff
  `kind === "conversation"`.
- `src-tauri/src/core/workspace.rs`: `#[serde(default)] pub kind: Option<String>` and
  `#[serde(default)] pub conversation_id: Option<String>` on `WorkspacePane` (follow the existing
  `task_id`/`flight_id` precedent at ~lines 20–22).
- `src-tauri/src/api/mod.rs`: add `Conversation` variant to `WorkspaceAgentSlotDto`; add
  `conversation_id`/`kind` to the pane DTO; regenerate ts-rs bindings. The `From<String>` mapping at
  ~735–741 (`_ => Self::Terminal`) must never see "conversation" as an agent_id.
- `src/lib/tauri.ts` `toDtoWorkspace` (~1438–1462): the pane map whitelists exactly five fields
  (id, agentId, sessionId, gridPosition, pinnedCommands) — thread `kind` and `conversationId` through
  BOTH `toDtoWorkspace` and the fromDto path or they silently drop on the next save.
- `src/stores/workspaceStore.ts`: `loadCachedWorkspaces` (~98–108) blindly casts `parsed as Workspace[]`
  — add `normalizePanes()` (default missing kind to "terminal", drop malformed panes, preserve unknown
  fields) applied to the localStorage cache AND backend hydration.

**Binding rulings.** `kind` is the sole discriminant (Bravo, ruled). Conversation panes persist
`agent_id: "terminal"` — the documented inert downgrade carrier — NEVER "conversation" (moderator
completion of the ruling). No schema-version stamp / refusal mechanism of any kind (Alpha, ruled on
storage.rs monolith evidence). Deliverable inside the PR description: the audited checklist of every
agentId-keyed site re-keyed on `kind`: `workspaceStore.ts` addPane (~line 341+: conversation panes must
NOT push into `workspace.agents`), removePane (`agents.indexOf`), `WorkspaceView.tsx` ~79–84
agentCounts header badges (exclude conversation panes), modelOverrides/effortOverrides record keys,
Rust `Vec<WorkspaceAgentSlotDto>` handling.

**Tests required.** (a) Serde/DTO round-trip: a workspace slice with a conversation pane survives
save/load with kind+conversationId intact through BOTH the Rust serde path (Rust unit test near
`core/workspace.rs` or `contract_tests.rs`) and the tauri.ts toDto/fromDto path (extend
`src/lib/__tests__/tauriPersistence.test.ts`). (b) Old-binary re-save simulation: strip
kind/conversationId as an old build would, reload, assert the pane parses as a plain terminal pane
(carrier arm hit, not the catch-all) — the sweep half of self-heal is asserted in P1-S2. (c)
`workspaceStore.test.ts` extended: normalizePanes on malformed cache; addPane/removePane with a
conversation pane leaves `agents[]` and agentCounts untouched.

**Done.** tsc + eslint + vitest + `cargo test` green; protected suites untouched-green; PTY code paths
show zero diff; checklist in PR description.

---

### P1-S2 — sessionIndex projection + sessionGlue (GC, reconciliation sweep, openSession skeleton) + store isolation

**Goal.** The derived-projection session model exists: pure selectors over both engines, one attention
vocabulary, one-directional GC, idempotent startup reconciliation, and the shared `openSession()`
materializer skeleton.

**Files.**
- NEW `src/lib/sessionIndex.ts`: pure selectors, zero state. Exports `UnifiedSession` (discriminated
  union `kind: "pty" | "conversation"`; fields id, workspaceId?, paneId?, title, projectPath, attention,
  updatedAt, archived; conversation side adds conversationId/provider/model; PTY side adds ptySessionId)
  and `attentionFor()` — the ONLY status vocabulary: `needs_you | working | idle | done | failed`.
  Conversation attention reads `agentApprovalStore` + `agentPlanStore` + streaming/status; PTY attention
  maps the adapter pattern-parser with ~750ms debounce, `needs_you` only on approval_needed; PTYs never
  report done/failed. Enumerates ALL conversations — placed, unplaced, archived — and EXCLUDES flight
  attempts via a memoized lookup set of flight attempt sessionIds (read from `asyncFlightStore`/
  `flightStore` state; read-layer only, no engine flag).
- NEW `src/stores/sessionGlue.ts`: (a) one-directional GC — subscribe to `agentTaskStore`;
  deleteConversation prunes referencing panes via NEW `workspaceStore.removeConversationPanes(conversationId)`;
  closing a tile NEVER touches the conversation. (b) idempotent startup reconciliation sweep running
  after `hydrateConversations` (`src/stores/agentConversationPersistence.ts:117`) resolves: every
  non-archived, non-flight, unreferenced conversation projects as an unplaced row; a wrapper workspace
  whose conversation pane was stripped (old-binary re-save) self-heals. No localStorage guard key —
  reconciliation IS the repair. (c) `openSession(ref)` skeleton: idempotently materialize a workspace
  (deterministic id `ws-wrap-<convId>`, `origin: "conversation"`, title = conversation auto-title,
  live-follow until first manual rename) with a single conversation pane, then `setActiveWorkspace`.
  Full sidebar consumption is Phase 4; the function + idempotence test land now.
- `src/stores/workspaceStore.ts`: add `removeConversationPanes`; add `origin?: "conversation"` to the
  Workspace type if needed (thread through toDtoWorkspace/persistence like other metadata — check the
  Rust side needs a `#[serde(default)]` mirror; if persisting origin requires Rust changes, do them here
  following P1-S1's pattern).
- `eslint.config.js`: `no-restricted-imports` — `agentTaskStore` and `workspaceStore` may not import
  each other; only `sessionGlue` bridges.

**Binding rulings.** Derived projection, never a merged store. Five-word vocabulary exactly. Archived
conversations included; flight attempts excluded at the read layer. Direction pane→conversationId only.
`sessionId` stays PTY-only.

**Tests required.** NEW `src/lib/__tests__/sessionIndex.test.ts`: vocabulary mapping per source state;
archived conversations enumerated; flight-attempt exclusion (attempt sessionIds absent). NEW
`src/stores/__tests__/sessionGlue.test.ts`: GC prunes panes on deleteConversation and never the
reverse; reconciliation sweep re-surfaces a stripped-pane conversation as an unplaced row with zero
conversation-file mutation (completes P1-S1's re-save simulation into the full self-heal gate);
`openSession` called twice with the same conversation ⇒ exactly one workspace, deterministic id.

**Done.** All new tests + protected suites green; eslint rule enforced (a deliberate violating import
fails lint); zero UI diffs — this sprint dark-ships.

---

### P1-S3 — Contract pin (sessionContract.test.ts) + launchConversation extraction + conversation.worktree field

**Goal.** The frozen api-agent contract is pinned by a standing test; launch logic leaves AgentsView;
worktree metadata is stamped at provisioning (root-cause fix for unlandable work).

**Files.**
- NEW `src/stores/__tests__/sessionContract.test.ts` — standing gate for ALL later phases:
  `createApiConversation({explicitId, skipBackendStart})` ⇒ sessionId===explicitId and zero backend
  start calls (the Flight Deck surface, `asyncFlightStore.ts` ~465–501); hydration round-trip of a
  conversation file including the new `worktree` field and unknown-key preservation; the legacy stale
  `workspaceId` strip (`agentConversationPersistence.ts:23,151`) pinned BY NAME; `canonicalizeAgentCli`
  aliasing. Do NOT touch `events.rs` or `apiAgentListeners.ts`.
- NEW `src/lib/launchConversation.ts`: extract `AgentsView.handleLaunch` (worktree provisioning at
  `AgentsView.tsx` ~300–324 — `getGitBranch` → `createConversationWorktree` under `.pkt-worktrees/<convId>`
  on branch `pkt/<convId>`, SSH path, provider auto-pick); `AgentsView.tsx` delegates, behavior-identical.
- `src/types/agent-conversation.ts`: optional `AgentConversation.worktree { basePath, worktreePath,
  branch, baseBranch, createdAt, state: "active" | "landed" | "discarded" }` — field names
  AttemptTarget-isomorphic. `launchConversation` stamps it at provisioning (today
  `baseBranch = getGitBranch(...) || "HEAD"` is computed then DISCARDED at ~305–315).
- `src/stores/agentConversationPersistence.ts`: persist/hydrate the `worktree` field. Legacy
  conversations: derive worktreePath/branch from `.pkt-worktrees/<convId>` at the READ layer only —
  never persist derived fields at hydration; `baseBranch` stays undefined (Phase 2's UI requires an
  explicit base pick for legacy).

**Binding rulings.** ONE new engine field (`worktree`) and nothing else; no hydration-time bulk writes;
the contract test is Bravo's P0-half moved to Phase 1 by ruling.

**Tests required.** sessionContract.test.ts itself (above); `asyncFlightStore.test.ts` and
`agentTaskStoreCleanup.test.ts` green UNCHANGED after the extraction; a launchConversation unit test
asserting worktree stamping (basePath/branch/baseBranch/state:"active") and the fallback-to-root path
when provisioning fails.

**Done.** New suite green and wired into CI as a standing gate; AgentsView behavior identical (its
existing tests unchanged); protected suites green.

---

### P1-S4 — User-visible fixes: clickable GitDashboard diff rows + Codex honesty

**Goal.** The two standalone fixes that ship even if the program pauses: no more blind commits, and
Codex stops advertising approval postures its adapter cannot honor.

**Files.**
- `src/components/workspace/GitDashboard.tsx`: file rows become clickable — row click opens a diff
  popover/panel reusing the existing `src/components/agents/diff/DiffRows.tsx` + `src/lib/hunkDiff.ts`
  UNMODIFIED, over a plain git-diff fetch for that file. Implement inside GitDashboard itself so every
  mount point inherits it (today the only live mount is `WorkspaceView.tsx:308` — see Flagged risks).
- `src/lib/api-models.ts`: add capability flags to the API provider catalog —
  `supportsApprovals: false` for `api-openai-codex` (the exec adapter maps every PermissionMode to a
  sandbox+never tuple; `agent-sidecar/src/providers/openai-codex.ts`; stdin closed, `-a on-request`
  cannot work; the stdin route was tried and reverted in commit baa8be1).
- `src/components/agents/AgentModeChip.tsx`, `src/components/agents/agentModeChipUtils.ts`,
  `src/components/agents/composer/ModeSelector.tsx` (all render `MODE_ORDER`): filter the ENTIRE mode
  set by capability. PermissionMode is `auto|ask_for_risky|allow_all|deny_all`
  (`src/types/agent-conversation.ts:50` — there is no "Manual" mode). For Codex show ONLY honorable
  postures, relabeled in sandbox vocabulary (Read-only / Workspace-write / Full access), tooltip
  "Codex (exec) can't pause for approvals — the sandbox is the safety boundary".
- Conversation header (AgentChatPane header area / `AgentHeaderBadges.tsx`): posture chip showing the
  true sandbox state.

**Binding rulings.** Capability-filter the whole set (Bravo, ruled outright), not one mode. Do NOT
touch `deriveMode`/`flagsForMode` or the sidecar. DiffRows/hunkDiff consumed, never modified.

**Tests required.** Codex mode UI snapshot/unit test: only honorable postures render for
api-openai-codex; full set for approval-capable providers unchanged (`AgentModeChip.test.ts` /
`agentModeChipUtils.test.ts` extended). GitDashboard row-click test: opens the diff for the correct
file; DiffRows suites untouched. `hunkDiff.test.ts` unchanged.

**Done.** Both fixes demonstrable in the running app; Agents tab otherwise untouched and primary; all
Phase-1 exit gates (spec §Phase 1 build-ready brief) green — this sprint closes Phase 1.

---

## Phase 2 — Endings in the existing Agents tab (1.5 ew)

### P2-S1 — Rust merge_conversation_branch + safety semantics

**Goal.** The net-new local squash-merge command exists with the exact ruled safety semantics — the
backend half of the unlandable-work fix.

**Files.**
- NEW Rust command `merge_conversation_branch(project_path, branch, squash=true default)` in
  `src-tauri/src/commands/git.rs` (registered in `src-tauri/src/lib.rs` alongside
  `commands::git::git_safety_check` at ~line 260). Gated on the existing `git_safety_check`
  clean-root guard (`commands/git.rs:362`). Semantics: refuse on dirty root checkout; on conflict,
  abort cleanly leaving BOTH the worktree AND the user's root checkout intact (squash-merge conflict
  recovery needs an explicit `git merge --abort` / reset path — verify with a fixture, see Flagged
  risks); on success delete `pkt/<convId>` with `-D` (squash leaves no ancestry for `-d`), remove the
  worktree dir, and return enough info for the caller to flip `worktree.state → "landed"`.
- `src/lib/tauri.ts`: typed invoke wrapper `mergeConversationBranch(...)` near
  `removeConversationWorktree` (~line 611).

**Binding rulings.** Squash default; dirty-root refusal via git_safety_check; branch fate is `-D`;
conflicts must leave both checkouts intact; no other local merge path exists today (verified: only
`github_merge_pr` in `commands/github.rs:2160`).

**Tests required.** Rust fixture-repo tests (follow existing patterns in `core/contract_tests.rs` or
git command tests): create → commit in worktree → merge-back ⇒ squash commit on base, branch deleted,
dir removed; dirty-root refusal; conflict path aborts with worktree and root intact (assert file
contents byte-identical pre/post).

**Done.** `cargo test` green including new fixture tests; no TS UI yet (dark-ships); protected suites +
sessionContract green.

---

### P2-S2 — gitPublish extraction + worktreeLifecycle lib + Discard wiring + dirty-check hardening

**Goal.** The shared endings library: PR publishing extracted behavior-preserving from flights, the
shared lifecycle shapes, and the first-ever Discard path with mandatory dirty-checks.

**Files.**
- NEW `src/lib/gitPublish.ts`: `publishBranchAsPr` extracted BEHAVIOR-PRESERVING from
  `asyncFlightStore.publishAttemptAsDraftPr` (`asyncFlightStore.ts:111–210`; gitPushBranch →
  githubCreatePr), shared by flights and sessions, RECORDING the PR number (feeds the cleanup
  predicate). `asyncFlightStore` delegates to it.
- NEW `src/lib/worktreeLifecycle.ts`: shared shapes/predicates for both owners (flights never read the
  new conversation field): lifecycle state transitions, the safe-cleanup predicate (worktree clean AND
  (ancestry-merged OR recorded-PR-reports-merged OR zero commits ahead of base)), dirty-check helper.
- Discard: first-ever wiring of `removeConversationWorktree` (`src/lib/tauri.ts:611`, currently ZERO
  callers) + flag-gated branch delete on `remove_local_worktree` (which is
  `git worktree remove --force` and leaks the `pkt/` branch — add the branch-delete flag on the Rust
  side in `commands/git.rs`), behind confirm. EVERY non-Discard removal path dirty-checks first.
- Store plumbing: `agentTaskStore`/persistence action to flip `conversation.worktree.state`
  (landed/discarded) and record the PR number on the conversation.

**Binding rulings.** Extraction is behavior-preserving and gated by the existing flight tests; the
predicate is Bravo's ruled spec verbatim; no non-Discard path ever removes a dirty tree; shared shapes
live in `lib/worktreeLifecycle.ts`.

**Tests required.** `asyncFlightStore.test.ts` green UNCHANGED post-extraction (flights and sessions
call the same path); PR number recorded assertion; NEW `worktreeLifecycle.test.ts`: predicate truth
table (clean+merged ⇒ safe; dirty ⇒ never; squash-merged-via-recorded-PR ⇒ safe; zero-ahead ⇒ safe);
Discard test: dirty worktree requires confirm and removes dir + branch; state flips persisted through
hydration (sessionContract round-trip covers the field).

**Done.** All green; still no Agents-tab UI (that is P2-S3); flights publish flow verified unchanged.

---

### P2-S3 — WorktreeLifecycleBar + disposable Agents-tab modal host + Finish→Commit CTA

**Goal.** The endings UI: the four-action lifecycle bar inside GitDashboard, reachable from the Agents
tab today via the priced disposable host, entered from the ReviewBar CTA.

**Files.**
- NEW `src/components/workspace/WorktreeLifecycleBar.tsx` mounted inside `GitDashboard.tsx`: four
  actions — (1) Merge back → `mergeConversationBranch` (P2-S1), success flips state→landed; (2)
  Create PR → `gitPublish.publishBranchAsPr` (P2-S2); (3) Discard → P2-S2 wiring behind confirm; (4)
  Keep for later → worktree retained with a visible "worktree pending" chip. Conflicts/refusals surface
  in GitDashboard's existing feedback slot. When the target conversation has a worktree, GitDashboard
  targets `worktree.worktreePath` (branch `pkt/<convId>`); legacy worktrees (baseBranch undefined) get
  an explicit base picker defaulting to the repo default branch, ahead-counts labeled approximate.
- NEW disposable modal host (~30 LOC) in the Agents tab (mounted from `src/components/views/AgentsView.tsx`):
  opens GitDashboard `{projectPath: worktree.worktreePath}` for the selected conversation. Explicitly
  disposable — deleted in P5-S2; keep it a single self-contained file so deletion is one import removal.
- `src/components/agents/review/ReviewBar.tsx`: ADDITIVE "Finish → Commit…" CTA when a session goes
  done/idle with reviewed changes (opens the host/panel). This is the ONLY ReviewBar change; the Y/N
  keydown block (~lines 60–73) is untouched this phase.
- SSH sessions: Land/Merge disabled with the existing remote-read-only message (GitDashboard already
  has `isRemote` handling at ~line 187).

**Binding rulings.** One ending for both tile kinds — GitDashboard, never a per-tile git panel or a
separate commit modal. The modal host is priced throwaway (Bravo's concession, ruled). CTA is additive
to ReviewBar only; ReviewSurface/editBaselineStore/reviewStore untouched.

**Tests required.** Component test: lifecycle bar renders the four actions; merge-back success flips
state and clears the pending chip; Keep shows the chip; Discard on dirty requires confirm.
`reviewStore.test.ts` / `editBaselineStore.test.ts` / ReviewSurface suites untouched-green;
sessionContract green. Phase-2 exit gates (spec §Phase 2) all green — closes Phase 2.

**Done.** Full loop demonstrable in the Agents tab: stream → review → Finish → commit → Land → cleanup.

---

## Phase 3 — Conversation tile + unified add flow (2.25 ew)

### P3-S1 — HARD BLOCKER: keyboardScopeActive Y/N focus gate + Escape layering

**Goal.** The keep-list-protecting focus gate lands FIRST, with dual-mode tests green BEFORE any
ConversationTile can exist. Nothing else in Phase 3 may start until this sprint is merged.

**Files.**
- `src/components/agents/AgentChatPane.tsx`: gains the two additive props — `frame: "standalone" | "tile"`
  (default "standalone") and `keyboardScopeActive?: boolean` — threaded down. No other prop, no fork,
  no extraction.
- `src/components/agents/review/ReviewBar.tsx` (document-level Y/N keydown at ~lines 60–73) and
  `src/components/agents/chat/PendingApprovalsSection.tsx` (document-level keydown at ~line 102): the
  handlers gain ONLY an arming condition. Dual-mode rule: no pane context (keyboardScopeActive
  undefined) → armed exactly as today, standalone AgentsView byte-identical; pane context → armed iff
  the prop is true. The eventual driver is `layoutStore.activePaneId` (`src/stores/layoutStore.ts:9`,
  set by `TerminalPane.tsx:99` today) — the tile passes `keyboardScopeActive={activePaneId === pane.id}`
  in P3-S2.
- Escape layering, condition-based (Alpha's ruled version): comment composer first, then ReviewSurface
  close (`ReviewSurface.tsx:127` window keydown), and the mosaic zoom-exit
  (`WorkspaceMosaicContainer.tsx:31–41`) no-ops while `reviewStore.open`. Implement as explicit
  condition checks, not defaultPrevented ordering.

**Binding rulings.** Timing per moderator ruling: this is Phase 3's first commit, not a standalone
pre-phase. ConversationTile MUST NOT register in renderTile until this sprint's tests are green —
enforce by simply not writing that code yet. Behavior extended, never altered.

**Tests required.** Dual-mode tests: (a) standalone — no prop → one keypress applies as today
(byte-identical assertions on existing behavior); (b) two panes mounted with pending edits, distinct
keyboardScopeActive → one keypress applies ONLY to the armed instance; (c) Escape layering — review-close
vs zoom-exit never double-fire (zoom-exit no-ops while review open). Protected Y/N suites
(`agentApprovalStore.test.ts` + any ReviewBar tests) green; fork-and-resend/queued-send unmodified-green.

**Done.** Merged before any other P3 work exists. AgentsView behavior unchanged (frame defaults to
"standalone", keyboardScopeActive undefined there).

---

### P3-S2 — ConversationTile + renderTile branch + auto-zoom-on-review

**Goal.** The tile exists: a ~140 LOC wrapper mounting the unforked AgentChatPane inside the mosaic,
with created-before-insert ordering, tile chrome on the existing 33px header, and review auto-zoom.

**Files.**
- NEW `src/components/workspace/ConversationTile.tsx` (~140 LOC): wraps `AgentChatPane`
  (`frame="tile"`, `keyboardScopeActive={layoutStore.activePaneId === pane.id}`); sets
  `setActivePaneId(pane.id)` on pointer-down (TerminalPane uses onClick at `TerminalPane.tsx:99` —
  use pointer-down on the tile per spec; do not modify TerminalPane). Header doubles as chrome:
  `MosaicWindowContext.connectDragSource` grip, double-click zoom, zoom button; X removes the PANE
  ONLY (conversation survives as an unplaced fleet row); Archive is an explicit overflow action.
  Interim visual parity with terminal tiles: grip, color dot, title, status pill, zoom in the same
  positions.
- `src/components/workspace/WorkspaceMosaicContainer.tsx`: `renderTile` (~line 106) gains ONE branch on
  `pane.kind === "conversation"`.
- Add-conversation path (minimal, pre-picker): a workspaceStore `addConversationPane(workspaceId,
  conversationId)` that inserts a kind:"conversation" pane; ordering law — the conversation is created
  in `agentTaskStore` (via `launchConversation`) BEFORE pane insertion; no half-born tile.
- Auto-zoom on review: opening ReviewSurface in a tile calls the existing
  `workspaceStore.setZoomedPane` (CSS-maximize, `WorkspaceMosaicContainer.tsx:22`; siblings
  `visibility:hidden`/`display:none`, nothing remounts) with `autoZoomedBy` bookkeeping (a small slice
  or local ref in the tile layer) so closing review un-zooms only if review caused the zoom. Zero new
  zoom machinery.
- Composer pins at tile bottom; `agentDraftStore` already keys drafts per-conversation — no changes.

**Binding rulings.** Unforked AgentChatPane, exactly two props (ruled over the AgentChatBody
extraction). ReviewSurface NEVER renders at raw tile width. X = layout only (Bravo conceded
close-as-archive). CSS-maximize zoom is law (PTY/P0-2). Conversation-created-before-pane-insertion.

**Tests required.** renderTile branch test (conversation pane renders ConversationTile, terminal panes
untouched); two-tiles-mounted variants of fork-and-resend and queued-send (suites themselves
unmodified — add new test files that mount two tiles); per-tile draft independence via agentDraftStore;
zoom safety: opening/closing ReviewSurface never remounts siblings (assert PTY/terminal component
instance identity or mount-count), autoZoomedBy un-zooms only when review caused it; P3-S1 dual-mode
suite still green with real tiles.

**Done.** A conversation tile can be placed next to terminals and driven end-to-end (send, stream,
review, Y/N with focus gate) in a dev build; protected suites zero-modification green.

---

### P3-S3 — Tile responsive header, lifecycle states, N-stream perf gate

**Goal.** The tile is production-grade at any size: container-query collapse, lazy-mounted heavy
controls, loading/missing/failed states, and the ruled streaming perf gate with its named fallback.

**Files.**
- ConversationTile/AgentChatPane header CSS: raw CSS `@container` rules for ALL visual collapse (no
  Tailwind plugin, no ResizeObserver). Always-visible narrow set = three cheap per-slice subscribers:
  `AgentModeChip` (safety posture), the Changes diffstat chip (review entry, existing
  `DiffPaneTrigger`-style +N/−M), the amber approval badge. `ModelSelector`, `ContextUsageRing.tsx`,
  `HeaderActions.tsx`, SSH controls mount LAZILY only when the overflow menu
  (`HeaderOverflowMenu.tsx`) is open or the tile is zoomed — both already JS state (menu open-state,
  `zoomedPaneId`). Zero observers per tile.
- States in ConversationTile: loading renders the header immediately from the session record;
  missing-conversation shows fallback + Remove-tile; failed turns show the red pill + `retryLastTurn`;
  `aria-live` gated to the focused tile only.
- Streaming: ships on the landed rAF `streamCoalescer` + zustand referential isolation + MessageList
  lazy rows — no changes. Numeric gate: 4 concurrent streams in a 2×2 mosaic hold p95 frame <16ms on
  documented reference hardware (define the harness: scripted stream fixtures through the coalescer,
  frame timing via a profiler run; record machine + method in the test/README). Named fallback if
  breached: non-focused streaming tiles coalesce to 4Hz batched flushes via the injectable
  `ScheduleFrame` (`src/lib/streamCoalescer.ts:27` — already injectable); focused tile stays per-frame;
  re-run the gate. Summary-density is second-level only, NOT built speculatively.

**Binding rulings.** Hybrid responsive ruling: CSS handles visual collapse, existing JS state handles
mounting economy, no ResizeObserver. Watch-many-all-live default. `streamCoalescer` semantics untouched.

**Tests required.** Lazy-mount assertions (heavy controls not in DOM until overflow/zoom); profiler
assertion that non-streaming tiles do not re-render on another tile's flush (React profiler or render
counters); `streamCoalescer.test.ts` ordering untouched-green; perf gate result recorded (a
documented measurement, plus the 4Hz fallback path unit-tested through the injectable scheduler even
if the gate passes); state-machine tests for loading/missing/failed.

**Done.** Tile behaves at 200px and full-screen; perf gate recorded green (or fallback engaged and
re-run green); a11y aria-live single-tile verified.

---

### P3-S4 — AddAgentPicker: one add flow, two sections, capability catalog, draft tile

**Goal.** One entry point for adding any agent: searchable picker with Chat agents + Terminals,
capability-filtered postures, instant CLI add, and the first-run draft conversation tile.

**Files.**
- NEW `src/components/workspace/AddAgentPicker.tsx`: single searchable popover (reuse the
  Dropdown-searchable machinery `ProviderPicker.tsx` uses — `searchable` prop on the shared Dropdown).
  Replaces the flat inline dropdown in `WorkspaceView.tsx` (~lines 36–176, `addAgentOpen`/`addPane`)
  at the same anchor; also renders inline+centered as the workspace zero-state (first agent and Nth
  agent are one flow). Sections in capability language: "Chat agents" FIRST — flattened API providers
  from `lib/api-models.ts` (Claude OAuth, Claude API, Codex ChatGPT, OpenAI, OpenRouter, MiniMax,
  Ollama) with color dot · name · default-model subtext · AuthBadge with inline Log-in lifted from
  ProviderPicker; then "Terminals" — the six CLI slots with agent-color dot · installed-gating
  (existing `isAgentInstalledForWorkspace` + `src/lib/agent-install-hints.ts` INSTALL_HINTS tooltips)
  and SSH awareness unchanged. Same vendor may appear in both sections. Templates: single "Workspace
  templates…" footer row opening the existing flow.
- NEW merged catalog: thin static read-layer registry joining `src/lib/api-models.ts` and the CLI
  catalog (`src/lib/cli-catalog.ts` / `src/agents/*` — verify exact CLI source at implementation)
  under capability flags `{face, supportsApprovals, supportsSsh, models[]}` — no change to either
  source of truth. (P1-S4 already added supportsApprovals.)
- Selection behavior: Terminal row → `addPane` instantly (today's behavior). Chat row → DRAFT
  conversation tile: sparkle avatar + "Describe the task to start" + composer footer chips for
  model/mode/worktree that fold into the header chip after first send; first send calls
  `launchConversation` then materializes the pane (created-before-insert). No pre-creation modal.
  Codex chat rows show ONLY honorable postures in sandbox vocabulary (P1-S4 filter reused).
- SSH: a conversation added in a remote workspace auto-inherits `workspace.serverId` as
  `conversation.sshTarget`.

**Binding rulings.** One picker, two labeled sections, capability language never transport language;
Chat agents first; capability-FILTERED mode pickers; rejected: separate Add buttons, runtime-first
wizard. Composer wiring unchanged (chips are additive footer content).

**Tests required.** Picker search disambiguation ("cla" → both sections' hits under headers); CLI
instant-add unchanged (existing WorkspaceView add tests updated only for the new component); draft-tile
flow: chips fold after first send; draft state persists via agentDraftStore; Codex row posture filter;
SSH inheritance unit test. Phase-3 exit gates (spec §Phase 3) all green — closes Phase 3.

**Done.** Adding Claude-chat next to a terminal is one flow from the workspace header and from the
zero-state; Agents tab still primary.

---

## Phase 4 — Fleet layer (1.5 ew)

### P4-S1 — sessionStatus rollup single-truth + focusPaneRequest mechanism

**Goal.** One status truth for every surface, and the focus+flash plumbing that needs-you clicks and
P5 deep links will use.

**Files.**
- NEW `src/lib/sessionStatus.ts`: pure rollup selector — workspace status = max severity across member
  tiles (severity order: needs_you > working > idle > done > failed per the spec's attention semantics;
  PTY tiles only ever contribute working/idle — no fake PTY done states). Built on P1-S2's
  `sessionIndex`.
- Rewire consumers to the single truth: the tab-strip dot (workspace header tabs in
  `WorkspaceView.tsx`) and `src/components/layout/RunningAgentsChip.tsx` (display only — its deep-link
  destination changes in P5).
- NEW `workspaceStore.focusPaneRequest` mechanism (this is NET-NEW — no such symbol exists today):
  a store field + `requestPaneFocus(workspaceId, paneId)` that activates the workspace, sets
  `layoutStore.activePaneId`, and triggers a transient flash on the target pane (consumed by
  WorkspacePane/ConversationTile); never auto-zoom, never rearrange.

**Binding rulings.** `sessionStatus.ts` is the SINGLE status truth for sidebar rows, tab-strip dot,
and RunningAgentsChip. Needs-you navigation = activate + focus + flash only.

**Tests required.** Rollup truth table (mixed member states ⇒ max severity; PTY never done/failed);
RunningAgentsChip/tab-dot read from the selector (unit); focusPaneRequest test: request activates
workspace + sets activePaneId + flash flag clears itself; no zoom state touched.

**Done.** Dark-ships except the (invisible) consumer rewiring; all suites green.

---

### P4-S2 — FleetSidebar replaces WorkspaceSidebar: rows, virtual rows, needs-you, search, materializing open

**Goal.** The fleet list: one sidebar built from AgentSidebar's machinery, unified rows for workspaces
AND unplaced conversations, needs-you pinned group, and open-as-materializing-mutation.

**Files.**
- NEW `src/components/workspace/FleetSidebar.tsx` replacing `WorkspaceSidebar.tsx` in
  `WorkspaceView.tsx` (WorkspaceSidebar file survives until P5 only if the dual-run harness needs it;
  the replaced-in-view swap happens here). Built from `AgentSidebar.tsx` machinery: needs-you pinned
  pseudo-group with amber count, All/Active/Done/Archived filter chips, `/`-search with message scan,
  pin, archive, relative time, project groups + rename — `projectLabels` moves to a shared
  sidebar-prefs store (extend `src/stores/agentSidebarPrefsStore.ts` into the shared store; AgentSidebar
  keeps working from it until P5 deletion).
- Row anatomy: two lines — line 1 rollup icon (from `sessionStatus.ts`) · name · relative time; line 2
  tile chips in agent colors ("Claude · Codex ×2 · Terminal") — OMITTED for single-tile rows (they
  render like today's conversation rows). Multi-tile rows carry per-chip amber dots.
- Virtual rows: `sessionIndex` synthesizes rows for every unplaced, non-archived, non-flight
  conversation; archived unwrapped conversations appear first-class under the Archived filter
  (unarchiving materializes a fresh wrapper). Click = `sessionGlue.openSession(ref)` (P1-S2) —
  idempotent materialization (ws-wrap-<convId>, origin:"conversation", live-follow-then-freeze title)
  before `setActiveWorkspace`. WorkspaceView NEVER renders synthetic records.
- Needs-you click: activate + `focusPaneRequest` (P4-S1) — focus+flash, no auto-zoom, no rearrange.
- New launches (`launchConversation` callers, FleetSidebar "New session" CTA with project picker,
  AddAgentPicker) create real origin:"conversation" workspaces.
- Sidebar subscriptions are per-slice — no full-list re-render per streaming frame.

**Binding rulings.** Row unit is the workspace; no bulk migration; no global inbox; no
pseudo-workspace second render path; open is a materializing mutation through ONE shared function.
Reconciliation sweep (P1-S2) is a prerequisite — already landed.

**Tests required.** openSession idempotence at the sidebar layer (click twice ⇒ one workspace);
reconciliation-scale test: 200+ conversations ⇒ zero conversation-file mutation, stable virtual-row
identity across restarts; needs-you count derived from sessionStatus; single-tile vs multi-tile row
rendering; search/filter/pin parity unit tests (checklist started: search, pins, archive filter,
project rename); per-slice subscription profiler assertion.

**Done.** Sidebar shows workspaces + legacy conversations as one list; clicking any legacy row lands in
a real materialized workspace with the conversation tile.

---

### P4-S3 — Archive lifecycle fan-out + cleanup policy + dual-run parity & mounted-cost gates

**Goal.** Archive/delete lifecycle with the ruled worktree-cleanup policy, plus the two Phase-4 gates
(parity dual-run and mounted-cost) and the migration banner.

**Files.**
- Archive fan-out (in `sessionGlue.ts` / workspaceStore action): archiving a workspace kills member
  PTYs (on archive, NEVER on switch — P0-2 law), archives member conversations, keeps transcripts.
  Deleting a workspace DETACHES conversations, never destroys transcripts.
- Worktree cleanup policy: setting never / only-when-safe [default] / always, evaluated through
  `worktreeLifecycle.ts`'s predicate (P2-S2). Everything not provably safe conservatively Keeps with
  the "worktree pending" chip; `sweepAutoArchive` always Keeps. Explicit archive of a workspace with
  unlanded work raises a non-blocking notification-layer toast (existing notification infra as a
  consumer, never rebuilt) with a "Review worktree" action.
- Dual-run parity gate: a test harness asserting needs-you counts identical between AgentSidebar and
  FleetSidebar on the same store state; parity checklist (search, pins, archive filter, project
  rename) tracked in the PR.
- Mounted-cost gate: 20 materialized conversation-only workspaces behind display:none hold near-zero
  idle CPU with bounded document-listener count (the keyboardScope arming means listeners exist but
  are disarmed — count them). Named fallback if breached: mount-on-activation ONLY for workspaces with
  ZERO PTY panes (`WorkspaceView.tsx:240–244` keep-all-mounted pattern itself never modified).
- "Sessions have moved" banner on the old Agents tab (small additive banner in AgentsView).

**Binding rulings.** Policy over prompt (Bravo, ruled) + the toast amendment; auto-archive
structurally cannot prompt (AgentsView.tsx:100–101 hourly interval) so Keep+chip is mandatory; delete
detaches; PTY kill on archive only.

**Tests required.** Archive fan-out test: PTYs killed on archive, NOT on workspace switch;
dirty/unlanded under only-when-safe ⇒ Kept with chip; clean-and-predicate-safe ⇒ cleans silently;
auto-archive never cleans; delete detaches (conversation survives as virtual row). Dual-run parity
assertion green. Mounted-cost measurement recorded (method documented). Phase-4 exit gates — closes
Phase 4.

**Done.** Fleet layer complete; both sidebars agree; old tab banner live.

---

## Phase 5 — Agents-tab retirement (0.75 ew)

### P5-S1 — Retarget six entry points + redirect shim + hoists

**Goal.** Every road into the Agents tab leads to a materialized workspace; everything AgentsView
hosts that must survive is re-homed. AgentsView still exists (deleted next sprint) behind the shim.

**Files.**
- `src/components/layout/LeftRail.tsx:13`: remove the `agents` rail item.
- `src/App.tsx`: Shift+1 remap (the `"!"` → "agents" mapping at ~line 186) → workspace view; the view
  switch renders the shim for `"agents"`.
- Redirect shim: `CoreView` "agents" (`src/stores/appStore.ts:3`) survives ONE release — a shim that
  resolves `agentTaskStore.selectedConversationId` through the materializing `openSession` path, so
  stale deep links and persisted `activeView='agents'` cold-starts land on a REAL workspace, never
  blank.
- Three deep-link call sites re-pointed to `openSession` + `focusPaneRequest`:
  `src/stores/promptStore.ts:105`, `src/components/layout/RunningAgentsChip.tsx:88`,
  `src/components/agents/PinnedApprovalBanner.tsx:71`.
- Hoists to App level: Ctrl+N (AgentsView.tsx ~158–175) and Ctrl+Shift+V transcript view-mode cycler
  (~179–197) with their typing guards; `sweepAutoArchive` hourly interval (AgentsView.tsx:100–101) to
  an App-shell effect; `AgentsOnboarding.tsx` re-homed to the workspace empty-fleet state.

**Binding rulings.** Six entry points exactly (grep-verified inventory); notification layer producers
change DESTINATION only; shim lives one release.

**Tests required.** Cold-start hydration with persisted `activeView='agents'` lands on the correct
materialized workspace — never blank; deep-link end-to-end: RunningAgentsChip and PinnedApprovalBanner
land on the focused+flashed tile with its pending approval visible; keybinding tests for Shift+1,
Ctrl+N, Ctrl+Shift+V in their new homes; App-level auto-archive interval test.

**Done.** No user-reachable path renders AgentsView except the shim redirect; all suites green.

---

### P5-S2 — Delete AgentsView/AgentSidebar/disposable host + grep-clean + full keep-list smoke

**Goal.** The retirement: dead surfaces deleted after parity sign-off, and the full program-closing
smoke suite.

**Files (deletions).**
- `src/components/views/AgentsView.tsx`, `src/components/agents/AgentSidebar.tsx` (+ its test
  `AgentSidebar.test.tsx` — replaced by FleetSidebar coverage), the standalone launch-variant composer
  path (the AgentsView-only branch in the composer flow — identify via `launchConversation` callers),
  P2-S3's disposable modal host, `src/components/workspace/WorkspaceSidebar.tsx` if still present.
  Precondition: P4-S3's parity checklist signed off (search, pins, archive filter, needs-you counts,
  project rename) — verify before deleting.
- Keep the shim (P5-S1) — it is deleted in a FUTURE release, not this sprint.

**Binding rulings.** Deletion only after the FleetSidebar parity checklist signs off AND the dual-run
parity gate showed identical needs-you counts.

**Tests required / gates.** grep-clean: zero `setActiveView("agents")` call sites outside the shim;
zero remaining imports of AgentsView/AgentSidebar/the disposable host. Full keep-list smoke suite in
tile context: fork-and-resend, queued-send, Y/N approvals (dual-mode), PTY persistence
reload-and-reconnect, DiffRows/hunkDiff, ReviewSurface/editBaselineStore/reviewStore,
notification layer, unified Composer stacking order. sessionContract.test.ts green. Phase-5 exit
gates — closes the program.

**Done.** Single-surface app; `pnpm tsc` + eslint + full vitest + cargo test green; tree committable.

---

## Per-phase regression gates (for peer reviews)

**P1**: (1) serde/DTO round-trip with conversation pane through Rust serde AND tauri.ts toDto/fromDto
(guards the five-field whitelist silent drop); (2) old-binary re-save simulation → reconciliation sweep
re-surfaces the conversation as an unplaced row, zero conversation-file mutation; (3)
sessionContract.test.ts green (explicitId+skipBackendStart ⇒ sessionId==id + zero backend calls;
worktree-field + legacy-workspaceId-strip round-trip); (4) protected suites UNTOUCHED-green
(fork-and-resend, queued-send, Y/N approvals, ReviewSurface applyPipeline, agentWorkspaceDecoupling,
streamCoalescer); (5) PTY persistence smoke + empty diff on PTY paths; (6) asyncFlightStore +
agentTaskStoreCleanup green after the launchConversation extraction; (7) Codex mode snapshot shows
only honorable postures; GitDashboard row click opens the correct file diff; (8) openSession
idempotence.

**P2**: (1) worktree lifecycle fixture tests: create→commit→merge-back ⇒ branch -D + dir removal +
state→landed; dirty-root refusal; conflict aborts with worktree AND root intact; (2) flight draft-PR
publish tests pass unchanged post-extraction; PR number recorded; (3)
ReviewSurface/editBaselineStore/reviewStore untouched-green (CTA additive to ReviewBar only);
sessionContract green; (4) Discard: dirty tree requires confirm, removes dir+branch; Keep retains with
chip; no non-Discard path removes a dirty tree.

**P3**: (1) Y/N dual-mode gate: two tiles, one keypress applies ONLY to the focused tile; standalone
AgentsView Y/N byte-identical; Escape layering never double-fires; (2) protected suites pass with ZERO
modifications; queued-send + fork-and-resend green with two tiles mounted; per-tile drafts independent;
(3) zoom safety: ReviewSurface open/close never remounts siblings — PTY scrollback survives (existing
data-pane-zoomed/CSS path, zero new zoom machinery); streamCoalescer ordering untouched-green; (4) perf
gate: 4 streams in 2×2 hold p95 <16ms; on breach the 4Hz ScheduleFrame fallback engages and the gate
re-runs; non-streaming tiles do not re-render on another tile's flush.

**P4**: (1) dual-run parity: needs-you counts identical AgentSidebar vs FleetSidebar on the same store
state; parity checklist tracked; (2) openSession idempotence + 200-conversation reconciliation-scale
test: zero conversation-file mutation, stable virtual-row identity across restarts; (3) archive
fan-out: PTYs killed on archive NOT on switch; only-when-safe Keeps dirty/unlanded with chip;
clean-and-safe cleans silently; auto-archive never cleans; (4) mounted-cost: 20 display:none
conversation-only workspaces ≈ zero idle CPU, bounded listener count; sidebar per-slice subscriptions.

**P5**: (1) grep-clean: zero setActiveView("agents") outside the shim; zero imports of deleted
surfaces; (2) cold-start with persisted activeView='agents' lands on the materialized workspace;
notification deep links land on the focused+flashed tile with the pending approval visible; (3)
keybindings preserved in new homes (Shift+1, Ctrl+N, Ctrl+Shift+V, /-search) + App-level auto-archive
interval; (4) full keep-list smoke in tile context (fork-and-resend, queued-send, Y/N, PTY
persistence, DiffRows/hunkDiff, ReviewSurface/editBaselineStore/reviewStore, notification layer,
unified Composer).

---

## Flagged risks (spec-vs-code contact points; none re-decided here)

1. **GitDashboard has ONE live mount, not two.** Spec Q5/Workstream E says it "mounts only in
   WorkspaceView and FlightsView today" and requires the clickable rows to work "in both mount
   points" — verified: only `WorkspaceView.tsx:308` mounts it; `FlightsView.tsx:457` is a comment
   reference. P1-S4 implements the rows inside GitDashboard.tsx so any future mount inherits them; no
   FlightsView work exists to do.
2. **`workspaceStore.focusPaneRequest` is net-new.** The spec cites it as the needs-you focus
   mechanism; no such symbol exists anywhere in src today (verified by grep). It is planned as new
   work in P4-S1. `layoutStore.activePaneId` DOES exist and is the real mosaic focus mechanism.
3. **TerminalPane sets focus via onClick, not pointer-down** (`TerminalPane.tsx:99`). The spec says
   the tile sets activePaneId "on pointer-down as TerminalPane does". P3-S2 uses pointer-down on
   ConversationTile per the spec's intent (arm before any keydown) WITHOUT modifying TerminalPane;
   reviewers should not "fix" TerminalPane to match — it is a protected PTY path.
4. **Squash-merge conflict recovery in Rust is subtle.** `git merge --squash` conflicts leave the
   index/worktree dirty and `git merge --abort` does not always apply to squash merges; P2-S1 must
   implement an explicit reset/cleanup path and prove root-checkout-intact with a byte-level fixture
   assertion. The ruling (conflicts leave both checkouts intact) is implementable but needs care.
5. **The perf and mounted-cost gates need concrete harness definitions.** "p95 <16ms on reference
   hardware" and "near-zero idle CPU" are not yet executable: P3-S3 and P4-S3 must document machine +
   method with the measurement, or the gates cannot trigger their fallbacks. Flagged as
   process risk, not a design impossibility.
6. **Workspace `origin` field persistence.** openSession's `origin: "conversation"` marker must
   round-trip persistence; the Workspace DTO/Rust struct has no such field today, so P1-S2 quietly
   grows a second (workspace-level) schema addition beyond the spec's pane-level one. Same
   `#[serde(default)]` inert pattern applies; called out so reviewers gate it like the pane fields.
7. **Shift+1 mapping detail.** App.tsx maps the shifted character `"!"` to "agents" (~line 186), not a
   literal "1"-with-shift check; P5-S1 must remap that entry (and macOS keyboard-layout variance of
   `"!"` is a pre-existing caveat worth a test).
8. **Line-number drift.** All line references (workspaceStore.ts:341/362, tauri.ts:1438–1462,
   AgentsView.tsx:300–324, api/mod.rs:735–741, etc.) were re-verified on branch feat/tile-program at
   planning time but WILL drift as sprints land; implementers should treat them as anchors, not
   coordinates.
