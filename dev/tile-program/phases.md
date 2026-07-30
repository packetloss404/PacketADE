# Conversation-as-Tile Program — Phase Plan (P1–P5)

Derived with planning fidelity from the ruled spec `dev/archive/conversation-tile-design.md` (2026-07-08 two-team consensus). Every ruling in the spec is settled; this document sequences it into entry/exit-gated phases with explicit blast radius. All file references below were re-verified against the working tree on branch `feat/tile-program` on 2026-07-08; corrections to stale spec line numbers are marked **[corrected]** and collected in the appendix.

**Settled rulings (not revisitable in any phase):** derived-projection session model (no merged store) · `kind` discriminant on WorkspacePane (never overloading agentId) · inert-carrier downgrade (`agent_id:"terminal"`, no version-stamp refusal) · endings-first ordering (P2 before any tile work) · two-prop unforked AgentChatPane (no AgentChatBody extraction) · capability-filtered Codex postures (whole mode set, sandbox vocabulary) · CSS-maximize zoom (`setZoomedPane` / `data-pane-zoomed`, never remount) · virtual rows + lazy materialization (no bulk migration).

---

## Standing gates — every phase

These run at the end of **every** phase (P1–P5). A phase cannot exit with any of them red, and by policy any diff to the protected files themselves fails the phase gate.

1. **Protected suites green, unmodified:** `src/stores/__tests__/agentForkAndResend.test.ts`, `agentQueuedSend.test.ts`, `agentWorkspaceDecoupling.test.ts`, `agentApprovalStore.test.ts` (Y/N approvals), `reviewStore.test.ts`, `editBaselineStore.test.ts`, `src/components/agents/review/__tests__/ReviewSurface.applyPipeline.test.tsx`, streamCoalescer ordering tests.
2. **sessionContract.test.ts green** (exists from P1 onward): the api-agent:* contract pin — `createApiConversation({explicitId, skipBackendStart})` ⇒ `sessionId === explicitId` + zero backend start calls (the Flight Deck surface, verified `src/stores/asyncFlightStore.ts:495-496`); hydration round-trip incl. `conversation.worktree` and the legacy `workspaceId` strip (`src/stores/agentConversationPersistence.ts:23,151`); `canonicalizeAgentCli` aliasing. Zero event renames, zero new `start_api_agent_session` params (`src-tauri/src/commands/api_agent.rs:664-685`; its `workspace` param means SSH/local *execution* context and is firewalled from the UI-workspace concept).
3. **PTY persistence smoke:** existing workspaces with live sessionIds reload and reconnect; `git diff` over PTY code paths is empty. The WorkspaceView keep-all-mounted `display:none` pattern (`src/components/views/WorkspaceView.tsx:238-246` **[corrected** from spec's 240-244; content verified: "All active workspaces stay mounted so PTY sessions persist"**]**) is never modified.
4. **Never-modify list (spec's Phase-1 brief, applies program-wide unless a phase explicitly grants additive-only access):** anything under `src/components/agents/review/` (additive ReviewBar CTA in P2 and arming condition in P3 are the only granted exceptions), `editBaselineStore`, `reviewStore`, the Composer, `src/lib/streamCoalescer.ts` (consumed via its injectable `ScheduleFrame`, verified `streamCoalescer.ts:27,52` — never edited), any PTY code path.
5. **Repo conventions:** no prettier/`pnpm format` on `src/`; verify with tsc + eslint + vitest only.

---

## Phase 1 — Foundations, contract pin, and honest fixes (1.75 ew)

### Entry criteria

- Branch `feat/tile-program` off a green main; full existing suite green (baseline recorded).
- Spec and keep list read; the audited agentId-keyed-site checklist template prepared (deliverable is a checked list in the PR description).
- No prior program work required — P1 is the program's root.

### Deliverables (spec rulings, references verified)

All dark-ships except E and F. "Agents tab untouched and primary."

**A — Pane schema (TS + Rust), the kind discriminant + inert carrier + round-trip mirror.**
> "SCHEMA: WorkspacePane gains `kind?: 'terminal'|'conversation'` … plus `conversationId?: string`. Rust mirror is mandatory: `#[serde(default)]` kind/conversation_id on core WorkspacePane (precedent: task_id/flight_id, core/workspace.rs) + a Conversation DTO variant + threading through toDtoWorkspace/fromDto … unmirrored fields silently drop on save."

- `src/types/workspace.ts:3` (`interface WorkspacePane`) — add `kind?: "terminal" | "conversation"` and `conversationId?: string`; absent kind = terminal. Invariant: `conversationId` set iff `kind === "conversation"`. *(Note: the spec's Q1 text says the union is `"pty"|"conversation"` for UnifiedSession but the pane field is `"terminal"|"conversation"` per the build-ready brief — follow the brief for the pane.)*
- `src-tauri/src/core/workspace.rs` — `#[serde(default)] kind: Option<String>` + `conversation_id: Option<String>` on `WorkspacePane` (struct at line 10; precedent `task_id`/`flight_id` verified at lines 20/22).
- `src-tauri/src/api/mod.rs` — `Conversation` variant on `WorkspaceAgentSlotDto` + `conversation_id` on the pane DTO; ts-rs regen. **Inert carrier ruling:** conversation panes always persist `agent_id:"terminal"` — never `"conversation"` — so the `From<String>` catch-all (`_ => Self::Terminal`, verified **exactly** at `api/mod.rs:741`) is never hit; old binaries render a harmless terminal pane. `kind` is the sole discriminant. No version-stamp refusal (ruled out: workspaces live in monolithic `state.v1.json` — `src-tauri/src/core/storage.rs:67` `STATE_FILENAME`, `:101-102` `PersistedState{version,…}` **[corrected** from spec's 102/110**]** — whose `version` is an optimistic-concurrency counter bumped on every save).
- `src/lib/tauri.ts` `toDtoWorkspace` — the pane mapping whitelists **exactly five fields** (id, agentId, sessionId, gridPosition, pinnedCommands; verified at `tauri.ts:1443-1449`, function at 1438-1462) — thread `kind`/`conversationId` through **both** `toDtoWorkspace` and `fromDto` or they silently drop on the next `save_workspaces_slice` round-trip.
- **Audited checklist** (PR-description deliverable) of every agentId-keyed site moved onto `kind`: `workspaceStore.ts:353` (addPane pushes into `workspace.agents` — conversation panes must NOT push; verified exact), `:374` (removePane `agents.indexOf`; verified exact), `WorkspaceView.tsx:80-83` (agentCounts header badges — exclude conversation panes; **[corrected** from spec's 79-84**]**), modelOverrides/effortOverrides record keys, Rust `Vec<WorkspaceAgentSlotDto>` handling.
- `normalizePanes()` — defensive pass on the blindly-cast localStorage workspaces-cache (verified `parsed as Workspace[]` at `workspaceStore.ts:104` **[corrected** from spec's 103**]**): default missing kind to "terminal", drop malformed panes, preserve unknown fields; applied to the cache AND backend hydration.

**B — Projection + glue.**
> "New src/lib/sessionIndex.ts holds pure selectors projecting both stores into UnifiedSession rows … with ONE attention vocabulary: needs_you / working / idle / done / failed; it enumerates ALL conversations — placed, unplaced, AND archived — and excludes Flight Deck attempt conversations via an attempt-sessionId lookup set."

- NEW `src/lib/sessionIndex.ts` — pure selectors, zero state; conversation attention reads agentApprovalStore + agentPlanStore + streaming/status; PTY attention maps the adapter pattern-parser with ~750ms debounce, needs_you only on approval_needed, PTYs never report done/failed; flight-attempt exclusion is a memoized read-layer lookup set (no engine flag).
- NEW `src/stores/sessionGlue.ts` — (a) one-directional GC: deleteConversation prunes referencing panes via new `workspaceStore.removeConversationPanes(conversationId)`; closing a tile NEVER touches the conversation; (b) idempotent startup reconciliation sweep after hydrateConversations (no localStorage guard key — "reconciliation IS the repair"); (c) `openSession(ref)` skeleton: idempotent materialization, deterministic id `ws-wrap-<convId>`, `origin:"conversation"`, title live-follows auto-title until first manual rename. Full sidebar consumption arrives P4; the function + idempotence test land now.
- eslint `no-restricted-imports`: agentTaskStore and workspaceStore may not import each other; only sessionGlue bridges. Reference direction is pane→conversationId ONLY; AgentConversation never gains workspaceId.

**C — Contract pin.** NEW `src/stores/__tests__/sessionContract.test.ts` (standing gate #2 above). Do NOT touch `events.rs` or `src/stores/apiAgentListeners.ts`.

**D — Worktree metadata.**
> "ONE new engine field: conversation.worktree {basePath, worktreePath, branch, baseBranch, createdAt, state: 'active'|'landed'|'discarded'} — AttemptTarget-isomorphic — stamped at provisioning going forward in launchConversation.ts; legacy worktrees derive path/branch at the READ layer only."

- Extract `AgentsView.handleLaunch` (at `src/components/views/AgentsView.tsx:200`; worktree provisioning verified at `:309-314` — `getGitBranch(selectedRepo)` → `baseBranch` computed then **discarded**, the unlandable-work root cause; spec's ~300-324 confirmed) into NEW `src/lib/launchConversation.ts`; AgentsView delegates, behavior-identical.
- Add optional `AgentConversation.worktree` to `src/types/agent-conversation.ts`; launchConversation stamps it at provisioning. Legacy: derive from `.pkt-worktrees/<convId>` (dir constant verified `src-tauri/src/core/worktree.rs:14`, branch `pkt/<id>` at `:23`) at read layer only; `baseBranch` stays undefined — never persist derived fields at hydration.

**E — Blind-commit fix (user-visible).** GitDashboard (`src/components/workspace/GitDashboard.tsx`; props verified `{projectPath, workspaceId?, serverId?}` at `:85-90,:168`) file rows become clickable into a diff popover/panel reusing DiffRows/`lib/hunkDiff.ts` **unmodified**, over a plain git-diff fetch. Works in both verified mount points: `src/components/views/WorkspaceView.tsx` and `src/components/views/FlightsView.tsx`.

**F — Codex honesty (user-visible).**
> "capabilities.supportsApprovals=false; ENTIRE mode set capability-filtered, sandbox-vocabulary relabels, posture chip."

- Add `capabilities` to `src/lib/api-models.ts` (verified: no capabilities/supportsApprovals exists there today — net-new); `supportsApprovals:false` for api-openai-codex. Adapter evidence re-verified: `agent-sidecar/src/providers/openai-codex.ts:104` ("`-a on-request` interactive approval flow can't work here"); `modeToCodexFlags` (~`:110-145`) maps **every** mode to sandbox + `-a never` or `--dangerously-bypass-approvals-and-sandbox`, all `hasApprovals:false`; stdin closed at `:538-547`; stdin route reverted in commit baa8be1. **Caveat [flagged]:** the file-header doc comments at `:91-100` still show stale `-a on-request` mappings — the code, not the comment, is authoritative and matches the spec.
- Filter the ENTIRE mode set wherever modes render (`src/components/agents/AgentModeChip.tsx`, `MODE_ORDER` in `src/components/agents/agentModeChipUtils.ts:13`): `PermissionMode` is `auto|ask_for_risky|allow_all|deny_all` (verified **exactly** at `src/types/agent-conversation.ts:50` — no "Manual" mode exists). Codex shows only honorable postures relabeled Read-only / Workspace-write / Full access + tooltip; posture chip in the conversation header. Do NOT touch `deriveMode`/`flagsForMode` or the sidecar.

### Regression gates (P1 peer review)

- **Serde/DTO round-trip:** a workspace slice with a conversation pane survives save/load with kind+conversationId intact, through BOTH the Rust serde path and the tauri.ts toDto/fromDto path (guards the five-field-whitelist silent-drop hazard).
- **Old-binary RE-SAVE simulation** (Bravo's adopted demand — exercise re-save, not just parse): strip kind/conversationId as an old build would, restart, assert the reconciliation sweep re-surfaces the conversation as an unplaced row with **zero conversation-file mutation** (self-heal).
- **sessionContract.test.ts green** — becomes standing gate for all later phases.
- Standing gates 1–5 (protected suites untouched-green; PTY smoke with zero diffs on PTY paths).
- `asyncFlightStore.test.ts` + `agentTaskStoreCleanup.test.ts` green after the launchConversation extraction; AgentsView's own tests unchanged.
- Codex mode-chip snapshot shows only honorable postures; GitDashboard row click opens the diff on the correct file (both mount points).
- `openSession` idempotence unit test: called twice with the same conversation → exactly one workspace, deterministic `ws-wrap-<convId>`.

### Blast radius (files/stores allowed to change)

- **New:** `src/lib/sessionIndex.ts`, `src/stores/sessionGlue.ts`, `src/lib/launchConversation.ts`, `src/stores/__tests__/sessionContract.test.ts`, eslint rule config.
- **Modified:** `src/types/workspace.ts`, `src/types/agent-conversation.ts` (additive `worktree` field only), `src/stores/workspaceStore.ts` (normalizePanes, removeConversationPanes, kind-keyed sites per checklist), `src/lib/tauri.ts` (toDtoWorkspace/fromDto threading only), `src-tauri/src/core/workspace.rs`, `src-tauri/src/api/mod.rs` (+ ts-rs regen output), `src/components/views/AgentsView.tsx` (delegation-only diff), `src/components/workspace/GitDashboard.tsx` (row click), `src/lib/api-models.ts` (capabilities), `src/components/agents/AgentModeChip.tsx` / `agentModeChipUtils.ts` (capability filter + relabels only — MODE_ORDER filtering, not deriveMode/flagsForMode logic).
- **Forbidden:** `src/components/agents/review/**`, Composer, streamCoalescer, apiAgentListeners, `events.rs`, all PTY paths, `agent-sidecar/**`, AgentChatPane, WorkspaceMosaicContainer.

### Exit criteria

All P1 regression gates green; audited agentId→kind checklist complete in PR description; ts-rs bindings regenerated and committed-ready; Agents tab behavior byte-identical (it remains primary). Program is pause-safe here: two shipped fixes (E, F), all substrate dark.

---

## Phase 2 — Endings in the existing Agents tab (unlandable-work fix) (1.5 ew)

### Entry criteria

- P1 exit gates all green; `sessionContract.test.ts` in CI as a standing gate.
- `conversation.worktree` field live and stamped by `launchConversation.ts` (P2's lifecycle bar reads/writes it).
- Verified-precondition re-check holds: no local merge command exists anywhere in src-tauri (re-verified: only `github_merge_pr`, `src-tauri/src/commands/github.rs:2160`); `removeConversationWorktree` (`src/lib/tauri.ts:611`) still has zero callers (re-verified); `git_safety_check` exists (`src-tauri/src/commands/git.rs:362`, registered `lib.rs:260`).

### Deliverables (spec rulings, references verified)

> "The worst live bug closes before any migration." Ruled ordering (Bravo won, Alpha conceded): endings ship in the EXISTING Agents tab via "an explicitly disposable ~30-LOC modal host, priced here, deleted in Phase 5." AgentsView has no git surface today (verified: GitDashboard mounts only in WorkspaceView and FlightsView).

1. **NET-NEW Rust `merge_conversation_branch(projectPath, branch, squash=true default)`** gated on the existing `git_safety_check` clean-root guard; refuses on dirty root; conflicts surface in the existing feedback slot and leave worktree AND the user's root checkout intact; on success deletes `pkt/<convId>` with `-D` (squash leaves no ancestry for `-d` — Alpha's conceded branch-fate rule), removes the dir, flips `worktree.state → landed`.
2. **`publishBranchAsPr`** extracted behavior-preserving from `asyncFlightStore.publishAttemptAsDraftPr` (verified at `src/stores/asyncFlightStore.ts:111`) into NEW `src/lib/gitPublish.ts` (`gitPushBranch → githubCreatePr`), shared by flights and sessions, **recording the PR number** (feeds the cleanup predicate). Shared shapes in NEW `src/lib/worktreeLifecycle.ts` (AttemptTarget-isomorphic; flights never read the new conversation field).
3. **Discard** — first-ever wiring of `removeConversationWorktree` + flag-gated branch delete behind confirm (note: `remove_local_worktree` is `git worktree remove --force` and leaks the `pkt/` branch — verified `core/worktree.rs:529` region); **every non-Discard removal path dirty-checks first** (Bravo's safety spec).
4. **Keep for later** — worktree retained with a visible "worktree pending" chip.
5. **WorktreeLifecycleBar** (Merge back / Create PR / Discard / Keep-with-chip) mounted inside GitDashboard; reachable from the Agents tab via the disposable ~30-LOC modal host.
6. **ReviewBar "Finish → Commit…" CTA** — strictly additive to the protected, unmoved ReviewBar (`src/components/agents/review/ReviewBar.tsx`), shown when a session goes done/idle with reviewed changes.
7. **SSH sessions:** Land disabled with the existing remote-read-only message.
8. Legacy worktrees: explicit base picker (baseBranch unknown → defaults to repo default branch), ahead-counts labeled approximate. Read-layer derivation only.

### Regression gates (P2 peer review)

- **Worktree lifecycle vitest on a fixture repo:** create → commit → merge-back → `branch -D` + dir removal + `state→landed`; dirty-root refusal; conflict path aborts with worktree and user's root checkout intact.
- **Flight draft-PR publish tests pass unchanged post-extraction** (`asyncFlightStore.test.ts`; flights and sessions call the same gitPublish path); PR number recorded.
- **Discard test:** dirty worktree requires confirm and removes dir + branch; Keep retains worktree with pending chip; **no non-Discard path ever removes a dirty tree**.
- ReviewSurface/editBaselineStore/reviewStore suites untouched-green (the CTA is additive to ReviewBar only); sessionContract.test.ts green; standing gates 1–5.

### Blast radius

- **New:** `src-tauri/src/commands/` merge command (+ `lib.rs` registration), `src/lib/gitPublish.ts`, `src/lib/worktreeLifecycle.ts`, WorktreeLifecycleBar component, the disposable modal host (~30 LOC, tagged for P5 deletion).
- **Modified:** `src/components/workspace/GitDashboard.tsx` (lifecycle bar mount + focused-scope plumbing), `src/stores/asyncFlightStore.ts` (extraction delegation only — behavior-preserving), `src/components/agents/review/ReviewBar.tsx` (**additive CTA only** — sole granted exception to the review/ freeze), `src/lib/tauri.ts` (new invoke wrappers), `src/components/views/AgentsView.tsx` (modal host mount), `src-tauri/src/core/worktree.rs` (dirty-check + flag-gated branch delete).
- **Forbidden:** AgentChatPane, WorkspaceMosaicContainer, ReviewSurface/reviewStore/editBaselineStore, Composer, sidecar, PTY paths, workspaceStore schema beyond P1 shape.

### Exit criteria

All P2 gates green; the unlandable-work loop closes end-to-end in the Agents tab (stream → review → Finish → stage/commit → Land → cleanup); program pause-safe with both worst live bugs (unlandable worktrees, Codex lie) fixed. Agents tab still primary.

---

## Phase 3 — Conversation tile + unified add flow (2.25 ew)

### Entry criteria

- P1+P2 exit gates green. Pane schema round-trips; sessionGlue.openSession exists with idempotence test.
- Moderator ruling on timing re-verified as still true: **zero** `layoutStore`/`activePaneId` references anywhere under `src/components/agents/` (re-verified by grep on 2026-07-08 — still zero hits), so the arming conditional's first true test surface arrives in this phase.

### Deliverables (spec rulings, references verified)

**FIRST COMMIT — hard-blocks the rest of the phase (ruled: Alpha's timing, Bravo's mechanism and blocking discipline):**
> "keyboardScopeActive threaded into ReviewBar/PendingApprovals Y/N handling driven by layoutStore.activePaneId, dual-mode arming (no pane context → armed as today; pane context → armed iff focused), condition-based Escape layering (comment composer > ReviewSurface close > mosaic zoom-exit no-ops while reviewStore.open), dual-mode tests green BEFORE ConversationTile registers in renderTile."

- ReviewBar's document-level Y/N keydown verified at `ReviewBar.tsx:71-73` (`document.addEventListener("keydown", handler)`); it gains **only an arming condition**. Focus mechanism verified: `layoutStore.activePaneId` (`src/stores/layoutStore.ts:9,41,127`) is read by WorkspacePane for `isFocused` (`src/components/workspace/WorkspacePane.tsx:45-47`) and set by TerminalPane on click (`src/components/session/TerminalPane.tsx:51,99` — note: **onClick, not pointer-down** as the spec loosely phrases; ConversationTile should match the existing onClick convention or upgrade both consistently — a fidelity note, not a redesign).
- Dual-mode rule: no pane context → armed exactly as today, so standalone AgentsView behavior is untouched (byte-identical).

**Then:**
- **ConversationTile.tsx (~140 LOC)** wrapping the **UNFORKED** AgentChatPane (`src/components/agents/AgentChatPane.tsx`, 396 LOC), which gains **exactly two additive props** — `frame: "standalone"|"tile"` (default standalone) and `keyboardScopeActive`. No AgentChatBody/PaneHeaderShell extraction (ruled; deferred post-retirement with an interim visual-parity requirement: grip, color dot, title, status pill, zoom in the same positions as terminal tiles). In frame="tile" the existing 33px header doubles as chrome: `MosaicWindowContext.connectDragSource` grip, double-click zoom, zoom button; **X removes the PANE ONLY** (conversation survives as unplaced fleet row; Archive is explicit overflow).
- `WorkspaceMosaicContainer.renderTile` (`src/components/workspace/WorkspaceMosaicContainer.tsx`) gains **one branch on `pane.kind`**.
- Ordering: conversation created in agentTaskStore BEFORE pane insertion (no half-born tile); loading renders header from the session record; missing-conversation fallback + Remove-tile; failed turns show red pill + retryLastTurn; aria-live gated to the focused tile.
- **Auto-zoom on review:** ReviewSurface (verified exactly 699 LOC, `src/components/agents/review/ReviewSurface.tsx`) NEVER renders at raw tile width — opening review auto-zooms via existing `setZoomedPane` (`workspaceStore.ts:58`) CSS-maximize (`data-pane-zoomed`, `src/styles/mosaic-overrides.css:71`, `WorkspacePane.tsx:530`; siblings `visibility:hidden`, nothing remounts — PTY/P0-2 law) with `autoZoomedBy` bookkeeping so closing review un-zooms only if review caused the zoom. Zero new zoom machinery.
- **Responsive (ruled hybrid, no ResizeObserver):** raw CSS `@container` for all visual collapse; always-visible narrow set = three cheap per-slice subscribers (AgentModeChip posture, Changes diffstat chip as review entry, amber approval badge); ModelSelector/ContextUsageRing/HeaderActions/SSH mount lazily only when overflow menu opens or tile is zoomed (both already JS state). Composer pins at tile bottom; `agentDraftStore` already keys drafts per-conversation (verified `agentDraftStore.ts:29-31`) — N tiles get independent drafts/queued-send free.
- **Streaming:** ships on the landed rAF streamCoalescer + zustand referential isolation + MessageList lazy rows, behind the numeric gate below; fallback via the injectable `ScheduleFrame` (verified `src/lib/streamCoalescer.ts:27,52`) — non-focused streaming tiles coalesce to 4Hz, focused stays per-frame. Watch-many-all-live default. (Alpha's Summary-density mode is second-level fallback only if 4Hz fails the re-run — not built speculatively.)
- **AddAgentPicker** replacing WorkspaceView's flat inline dropdown (same anchor) + workspace zero-state variant (inline, centered): single searchable popover (reuse the Dropdown-searchable machinery ProviderPicker uses, `src/components/agents/composer/ProviderPicker.tsx`); "Chat agents" section FIRST (flattened API providers with color dot · name · default-model subtext · AuthBadge with inline Log-in), then "Terminals" (six CLI slots with `isAgentInstalledForWorkspace` gating — verified `WorkspaceView.tsx:53` — + `INSTALL_HINTS` tooltips, `src/lib/agent-install-hints.ts:13`, SSH awareness unchanged). Merged catalog = thin static read-layer registry joining `lib/api-models.ts` and `src/agents/*` / `src/lib/cli-catalog.ts` under capability flags `{face, supportsApprovals, supportsSsh, models[]}`. Terminal row adds a pane instantly; Chat row adds a **draft conversation tile** (sparkle avatar, "Describe the task to start", model/mode/worktree chips in the first-run composer footer folding into the header after first send — no pre-creation modal). Codex rows capability-filtered per P1's F. Remote workspaces: conversation auto-inherits `workspace.serverId` as `conversation.sshTarget`. Templates stay behind a single "Workspace templates…" footer row. Rejected (settled): separate Add-CLI/Add-conversation buttons, runtime-first wizard.
- Agents tab still primary.

### Regression gates (P3 peer review)

- **Y/N dual-mode gate:** two tiles with pending edits — one keypress applies ONLY to the focused tile; standalone AgentsView Y/N behavior byte-identical; Escape layering test: review-close vs zoom-exit never double-fire (zoom-exit no-ops while `reviewStore.open`).
- **Hard-block audit:** the dual-mode tests were green in a commit strictly before ConversationTile registers in renderTile (peer review checks commit order).
- **Protected suites pass with ZERO modifications** (AgentChatPane props are additive): queued-send-while-streaming and fork-and-resend green **with two tiles mounted** (new Phase-3 variants added alongside, originals untouched); per-tile drafts independent via agentDraftStore.
- **Zoom safety:** opening/closing ReviewSurface in a tile never remounts siblings — PTY scrollback survives (existing `data-pane-zoomed` CSS path, zero new zoom machinery); streamCoalescer ordering tests untouched-green.
- **Perf gate:** 4 concurrent streams in a 2x2 mosaic hold p95 frame <16ms on reference hardware; on breach the named fallback engages (4Hz coalescing via injectable ScheduleFrame) and the gate re-runs; profiler assertion that non-streaming tiles do not re-render on another tile's flush.
- Standing gates 1–5.

### Blast radius

- **New:** `ConversationTile.tsx`, `AddAgentPicker` component (+ merged-catalog registry module), dual-mode/Escape-layering tests, two-tile suite variants.
- **Modified:** `src/components/agents/AgentChatPane.tsx` (**two additive props only**, defaults preserve standalone), `src/components/agents/review/ReviewBar.tsx` (+ PendingApprovals handling) (**arming condition only** — second granted exception to the review/ freeze), `src/components/workspace/WorkspaceMosaicContainer.tsx` (one renderTile branch), `src/components/views/WorkspaceView.tsx` (picker anchor + zero-state), `src/stores/workspaceStore.ts` (autoZoomedBy bookkeeping only), tile-scoped CSS (@container rules).
- **Forbidden:** ReviewSurface/reviewStore/editBaselineStore internals, Composer wiring, streamCoalescer edits (injection only), any PTY path, AgentsView behavior (still primary), sidebar files, forking/rewriting AgentChatPane.

### Exit criteria

All P3 gates green; a conversation tile lives beside terminal tiles with the full protected stack (queued-send, fork-and-resend, ReviewBar, ReviewSurface auto-zoom) working multi-instance; one add flow replaces the flat dropdown; standalone AgentsView untouched and still primary. Pause-safe.

---

## Phase 4 — Fleet layer: FleetSidebar, virtual rows, archive lifecycle (1.5 ew)

### Entry criteria

- P3 exit gates green (tiles exist; openSession materialization path proven by unit test since P1).
- sessionIndex enumerates all conversations (placed/unplaced/archived) with flight-attempt exclusion — P1 substrate confirmed against live data.
- Note (verified): `workspaceStore.focusPaneRequest` does **not exist yet** — it is net-new machinery this phase builds (the spec names it as the mechanism, not as existing code). `src/stores/agentSidebarPrefsStore.ts` already exists as the natural home for the shared sidebar-prefs (projectLabels currently lives on agentTaskStore — verified `AgentSidebar.tsx:127`).

### Deliverables (spec rulings, references verified)

> "FleetSidebar replaces WorkspaceSidebar, built from AgentSidebar's strictly-richer machinery … The row unit is the workspace; a new pure selector src/lib/sessionStatus.ts computes the rollup (max severity across member tiles) and is the SINGLE status truth also driving the tab-strip dot and RunningAgentsChip."

- **FleetSidebar** (from `src/components/agents/AgentSidebar.tsx` machinery: needs-you pinned pseudo-group with amber count — verified `AgentSidebar.tsx:52,137,227-232` — All/Active/Done/Archived filter chips, /-search with message scan, pins, archive, relative time, project groups + rename via shared sidebar-prefs store) replaces `src/components/workspace/WorkspaceSidebar.tsx`. AgentSidebar itself dies in P5, not here.
- NEW `src/lib/sessionStatus.ts` — single-truth rollup selector for sidebar rows, tab-strip dot (`WorkspaceView.tsx:96-100` tab strip), and `src/components/layout/RunningAgentsChip.tsx`.
- Row anatomy: line 1 = rollup icon · name · relative time; line 2 = tile chips in agent colors, **omitted for single-tile rows** (they render like today's conversation rows). PTY tiles only ever contribute working/idle — no fake PTY done states. Multi-tile rows carry per-chip amber dots.
- **Virtual rows + materializing open (settled ruling — no bulk migration):** sessionIndex synthesizes virtual rows for every unplaced, non-archived, non-flight conversation; `sessionGlue.openSession(ref)` — used by sidebar click, needs-you click, and (in P5) the redirect shim — idempotently materializes `ws-wrap-<convId>`, `origin:"conversation"`, live-follow-then-freeze title, before `setActiveWorkspace`. **WorkspaceView never renders synthetic records; no dual render path.** (Render-model evidence re-verified: every active workspace is a header tab `WorkspaceView.tsx:52,96-100` and stays permanently mounted behind `display:none` `:238-246`.) New launches create real `origin:"conversation"` workspaces via launchConversation.ts.
- **Needs-you click** = activate workspace + focus+flash the offending pane via net-new `workspaceStore.focusPaneRequest` — **never auto-zoom, never rearrange**.
- **Archive lifecycle (ruled policy):** fan-out — kill member PTYs **on archive, never on switch**; archive member conversations; keep transcripts. Worktree cleanup policy `never / only-when-safe [default] / always` with the specified predicate — worktree clean AND (ancestry-merged OR recorded-PR-reports-merged OR zero commits ahead of base); everything else conservatively Keeps with the "worktree pending" chip; **auto-archive always Keeps**; explicit archive of unlanded work raises a non-blocking toast with "Review worktree" action (no modal, no second codepath). Deleting a workspace DETACHES conversations, never destroys transcripts. Archived unwrapped conversations are first-class rows under the Archived filter; unarchive materializes a fresh wrapper.
- **Dual-run:** old Agents tab and FleetSidebar run simultaneously with the parity gate below, then "Sessions have moved" banner on the old tab.

### Regression gates (P4 peer review)

- **Dual-run parity assertion:** needs-you counts identical between AgentSidebar and FleetSidebar on the same store state; parity checklist tracked (search, pins, archive filter, project rename).
- **openSession idempotence at scale:** virtual row → real workspace exactly once (deterministic `ws-wrap-<convId>`); reconciliation-scale test at 200+ conversations asserting zero conversation-file mutation and stable virtual-row identity across restarts.
- **Archive fan-out:** PTYs killed on archive, NOT on workspace switch (P0-2 lesson — explicit gate); dirty/unlanded worktree archived under only-when-safe is Kept with chip; clean-and-predicate-safe cleans silently; **auto-archive never cleans**.
- **Mounted-cost gate:** 20 materialized conversation-only workspaces behind `display:none` hold near-zero idle CPU with bounded document-listener count; named fallback = mount-on-activation for **zero-PTY workspaces only** (the PTY keep-all-mounted pattern is never modified); sidebar per-slice subscriptions — no full-list re-render per streaming frame.
- Standing gates 1–5.

### Blast radius

- **New:** FleetSidebar component(s), `src/lib/sessionStatus.ts`, focusPaneRequest machinery in workspaceStore, archive fan-out + cleanup-policy logic (settings entry for the policy), parity/scale tests.
- **Modified:** `src/stores/sessionGlue.ts` (openSession full consumption), `src/lib/sessionIndex.ts` (virtual-row synthesis), `src/stores/workspaceStore.ts` (focusPaneRequest, archive fan-out, delete-detaches), `src/stores/agentSidebarPrefsStore.ts` (shared prefs incl. projectLabels move), `src/components/views/WorkspaceView.tsx` (sidebar swap, banner), `src/components/layout/RunningAgentsChip.tsx` (rollup consumption — destination unchanged until P5), notification-layer **consumers** only (toast producer).
- **Forbidden:** AgentsView/AgentSidebar deletion (P5), deep-link retargets (P5), engine stores (agentTaskStore substores), review/ stack, PTY keep-all-mounted pattern, Composer, streamCoalescer.

### Exit criteria

All P4 gates green; parity checklist signed off or explicitly tracked to P5 entry; FleetSidebar is the live sidebar with the old tab still reachable (dual-run). Pause-safe.

---

## Phase 5 — Retirement of the Agents tab (0.75 ew)

### Entry criteria

- P4 exit gates green **and** the FleetSidebar parity checklist fully signed off (search, pins, archive filter, needs-you counts, project rename) — the spec makes deletion conditional on this sign-off plus the dual-run parity gate.
- The six entry points re-verified (all exact on 2026-07-08): `src/components/layout/LeftRail.tsx` rail item; `src/App.tsx` hotkey — **[corrected]** the spec says "Shift+1" but the verified binding is **Ctrl+Shift+1** (viewMap `"!" → "agents"`, `App.tsx:186`, inside the ctrl+shift handler at `:150`); `App.tsx` view switch; deep-link call sites `src/stores/promptStore.ts:105`, `src/components/layout/RunningAgentsChip.tsx:88`, `src/components/agents/PinnedApprovalBanner.tsx:71` (all `setActiveView("agents")`, verified exact).

### Deliverables (spec rulings, references verified)

1. **Six entry points retargeted:** LeftRail item removed; Ctrl+Shift+1 remapped; App.tsx view switch; the three deep-link call sites re-pointed to `openSession` + `focusPaneRequest` so notification deep links land on the focused+flashed tile.
2. **Redirect shim:** CoreView `"agents"` survives ONE release, resolving `selectedConversationId` through the same materializing openSession path — stale deep links and persisted `activeView='agents'` cold-starts land on a REAL workspace, never a blank view — then is deleted (next release).
3. **Hoists:** Ctrl+N (verified `AgentsView.tsx:158-176`) AND Ctrl/Cmd+Shift+V transcript view-mode cycler (verified `AgentsView.tsx:178-198`, `cycleTranscriptViewMode`) to App level — **[flagged]** `App.tsx:174` already binds Ctrl+Shift+V globally for push-to-talk; today the two globals coexist by accident of AgentsView mounting, and the hoist must explicitly reconcile the collision (see risks). `sweepAutoArchive` hourly interval (verified `AgentsView.tsx:100-101`, `window.setInterval(sweepAutoArchive, 60*60*1000)`; fn at `agentConversationPersistence.ts:108`) moves to an App-shell effect. `AgentsOnboarding` (`src/components/agents/AgentsOnboarding.tsx`) re-homes to the workspace empty-fleet state. (Launch logic already hoisted in P1.)
4. **Deletion list** (only after parity sign-off): `src/components/views/AgentsView.tsx`, `src/components/agents/AgentSidebar.tsx` (+ its test's AgentsView-coupled parts migrated), the standalone launch-variant composer path, Phase 2's disposable modal host.

### Regression gates (P5 peer review)

- **grep-clean:** zero `setActiveView("agents")` call sites outside the shim; zero remaining imports of AgentsView/AgentSidebar/the disposable host.
- **Cold-start hydration** with persisted `activeView='agents'` lands on the correct materialized workspace — never blank; notification deep links (RunningAgentsChip, PinnedApprovalBanner) land on the focused+flashed tile with its pending approval visible (end-to-end test per the keep-list plan).
- **Keybinding gate:** Ctrl+Shift+1, Ctrl+N, Ctrl+Shift+V (transcript cycling — with the push-to-talk collision explicitly resolved and tested), and /-search all preserved in their new homes; auto-archive still sweeps (App-level interval test).
- **Full keep-list smoke suite in tile context:** fork-and-resend, queued-send, Y/N approvals, PTY persistence, DiffRows/hunkDiff, ReviewSurface/editBaselineStore/reviewStore, notification layer, unified Composer.
- Standing gates 1–5.

### Blast radius

- **Modified:** `src/App.tsx` (hotkeys, view switch, shim, sweep effect), `src/components/layout/LeftRail.tsx`, `src/stores/promptStore.ts:105` region, `src/components/layout/RunningAgentsChip.tsx:88` region, `src/components/agents/PinnedApprovalBanner.tsx:71` region (destination change ONLY — the notification layer itself is untouched infrastructure), empty-fleet state (AgentsOnboarding re-home), `src/stores/appStore.ts` (shim resolution).
- **Deleted:** AgentsView.tsx, AgentSidebar.tsx, standalone launch-variant composer path, P2 modal host.
- **Forbidden:** everything else — this phase is retarget + hoist + delete; zero engine, review-stack, PTY, or tile changes.

### Exit criteria

All P5 gates green; grep-clean; one-release shim in place with a tracked follow-up to delete it; PacketADE is single-surface. Program complete at 7.75 ew total (P1 1.75 + P2 1.5 + P3 2.25 + P4 1.5 + P5 0.75).

---

## Appendix — verified-reference corrections and confirmations

Confirmed **exact** (spec line = code line): `api/mod.rs:741` (`_ => Self::Terminal`) · `workspaceStore.ts:353/374` · `ReviewBar.tsx:71` keydown install · `agent-conversation.ts:50` PermissionMode · `promptStore.ts:105` / `RunningAgentsChip.tsx:88` / `PinnedApprovalBanner.tsx:71` · `AgentsView.tsx:100-101` sweep interval · `tauri.ts:611` removeConversationWorktree (zero callers re-confirmed) · `tauri.ts:1443-1449` five-field pane whitelist · `agentConversationPersistence.ts:23,151` workspaceId strip · `storage.rs:67` STATE_FILENAME · `core/workspace.rs:20/22` task_id/flight_id · ReviewSurface exactly 699 LOC · zero layoutStore/activePaneId refs under `src/components/agents/` · GitDashboard props/mounts · codex adapter all-modes-`-a never` · `.pkt-worktrees/<id>` + `pkt/<id>` naming · `ScheduleFrame` injectable · per-conversation drafts.

Corrections (all trivial drift, no ruling affected):
- `workspaceStore.ts:103` → **:104** (`parsed as Workspace[]`).
- `WorkspaceView.tsx:79-84` agentCounts → **:80-83**; tabs/mounted refs (52/98/240-244) confirmed at :52 / :96-100 / :238-246.
- `storage.rs:102,110` PersistedState → struct at **:101-102**.
- "Shift+1 hotkey" → actually **Ctrl+Shift+1** (`App.tsx:150,186`, `"!"` in viewMap).
- Spec's "sets it on pointer-down as TerminalPane does" → TerminalPane uses **onClick** (`TerminalPane.tsx:99`).
- `workspaceStore.focusPaneRequest` and `api-models.ts` capabilities do not exist yet — both are net-new deliverables (P4 and P1 respectively), consistent with the spec's intent but phrased there as if extant.
- `openai-codex.ts:91-100` header comments are stale (`-a on-request` mappings); the actual `modeToCodexFlags` code matches the spec's claim.
- A shared sidebar-prefs store already exists (`src/stores/agentSidebarPrefsStore.ts`) — the P4 projectLabels move has a ready home.
