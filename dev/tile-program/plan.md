# Conversation-as-Tile Program — Charter (plan.md)

**Program:** conversation-as-tile / single-surface migration
**Branch:** feat/tile-program
**Authoritative design spec:** `dev/archive/conversation-tile-design.md` (two-team consensus, 2026-07-08 — FINAL, RULED)
**Prerequisite context:** `dev/archive/consensus-ux-consolidation-plan.md` (completed 20-item consolidation program; its Keep list is protected here)
**Total budget:** 7.75 engineer-weeks across 5 independently-shippable phases

This charter governs execution. It does not re-decide anything: every contested point in the spec was cross-examined, defended, and ruled by a moderator with code evidence. Rulings are settled. If a ruling proves impossible on contact with the code, the implementing engineer STOPS and flags it to the program owner — nobody silently re-decides.

---

## 1. Objective and north star

PacketADE becomes a **single-surface app**: Workspaces is the one place you work, and the standalone Agents tab retires. Concretely:

- The left sidebar becomes a **fleet list of sessions** — every agent, API-driven or CLI, is one row; anything needing your attention (pending approval, question) is pinned at top with an amber count.
- A **"session" is not a new database object**. It is a read-only projection over the two engines that already exist (the API conversation store and the workspace/PTY store), unified into one five-word status vocabulary: `needs_you / working / idle / done / failed`.
- Inside a workspace, an **agent conversation becomes a tile** placed next to terminal tiles in the mosaic. The tile's face is the chat itself — the same transcript, approvals, review bar, and composer that exist today, mounted **unmodified** inside a thin wrapper. Opening review auto-maximizes via the existing CSS zoom; nothing remounts, so sibling terminal sessions survive (the PTY/P0-2 lesson is law).
- **Adding an agent is one picker** with two sections — "Chat agents" and "Terminals" — in capability language, never transport language. Picking a chat agent drops a draft tile; model/mode/worktree are set right in the composer.
- **Work finally ends in a commit.** Conversation worktrees are unlandable today (the cleanup function has zero callers — verified, still true at `src/lib/tauri.ts:611`). Every workspace gets one git panel (the existing GitDashboard, focused-pane-scoped) with a lifecycle bar: Merge back / Create PR / Discard / Keep-with-chip. This fix, plus Codex ceasing to advertise approval modes its adapter can't honor, ships FIRST, in the existing Agents tab.
- **Existing conversations are never bulk-migrated.** They appear as derived virtual rows; a real workspace record is materialized only when opened (`sessionGlue.openSession`, deterministic `ws-wrap-<convId>` id). Upgrade day rewrites nothing; downgrade shows a harmless inert terminal pane and the new build self-heals it via the reconciliation sweep.
- The Agents tab survives **one release as an invisible redirect**, then is deleted.

North star (inherited from the consolidation program): an orchestrator's seat, not a cockpit — one calm conversation per agent, one door to review, one dial for autonomy, one ending in git. The engine (`api-agent:*` contract, substores, PTY persistence, diff primitives) does not move; only the front door does.

## 2. Scope

**In scope**
- WorkspacePane schema extension (`kind` discriminant + `conversationId`) in TS and Rust, with the inert `agent_id:"terminal"` downgrade carrier and DTO round-trip threading.
- New read-layer/glue modules: `src/lib/sessionIndex.ts` (derived projection), `src/stores/sessionGlue.ts` (GC, reconciliation sweep, `openSession`), `src/lib/sessionStatus.ts` (single-truth rollup), `src/lib/launchConversation.ts` (launch hoist), `src/lib/gitPublish.ts` + `lib/worktreeLifecycle.ts` (shared endings layer).
- `conversation.worktree` engine field (AttemptTarget-isomorphic + state enum) stamped at provisioning; legacy worktrees derived at the read layer only.
- Net-new Rust `merge_conversation_branch` (squash default, `git_safety_check`-gated); Discard wiring; WorktreeLifecycleBar in GitDashboard; "Finish → Commit…" CTA on ReviewBar; clickable diff rows in GitDashboard.
- Codex honesty: `supportsApprovals:false` capability, whole-mode-set filtering, sandbox-vocabulary relabels, posture chip. Catalog/chip layer only.
- ConversationTile wrapping the **unforked** AgentChatPane (exactly two additive props: `frame`, `keyboardScopeActive`); Y/N focus gating; condition-based Escape layering; auto-zoom-on-review; container-query responsive header.
- AddAgentPicker (single searchable popover, Chat agents + Terminals, merged capability catalog).
- FleetSidebar replacing WorkspaceSidebar (built from AgentSidebar's machinery); virtual rows + lazy materialization; archive lifecycle with the never/only-when-safe/always cleanup policy.
- Agents-tab retirement: six entry points retargeted, one-release redirect shim, keybinding/interval/onboarding hoists, then deletion of AgentsView/AgentSidebar/the Phase-2 disposable modal host.
- `sessionContract.test.ts` and the full regression-gate suite as standing all-phase gates.

**Explicit non-goals (do not touch)**
- **Flight Deck / FlightsView and asyncFlightStore behavior** — untouched except the behavior-preserving `publishBranchAsPr` extraction into `gitPublish.ts`, gated by its existing tests. Attempt conversations never appear in the fleet sidebar (read-layer exclusion set, no engine flag).
- **GitHub, Issues, and Memory views** — untouched.
- **The Toolbar** — untouched, except the six retargeted deep links / entry points named in Phase 5 (LeftRail item, Shift+1, App view switch, `promptStore.ts:105`, `RunningAgentsChip.tsx:88`, `PinnedApprovalBanner.tsx:71`).
- **The `api-agent:*` contract — FROZEN.** Zero event renames, zero additions; `startApiAgentSession` gains no parameters; `createApiConversation` options (`explicitId`, `skipBackendStart`) byte-identical; its `workspace` param (execution context, R0 vocabulary) firewalled from the UI-workspace concept. Pinned by `sessionContract.test.ts` from Phase 1.
- **The Codex sidecar/adapter** — no proto/JSON-stdin rewrite (tried and reverted, commit baa8be1). Honesty ships at the catalog/chip layer only; `deriveMode`/`flagsForMode` untouched.
- **No merged session store, no bulk migration, no global inbox, no pseudo-workspace second render path, no per-tile git panels, no separate commit modal, no runtime-first wizard, no separate Add-CLI/Add-conversation buttons** — all explicitly rejected by both teams.
- **Anything under `src/components/agents/review/`, editBaselineStore, reviewStore, the Composer, streamCoalescer, and every PTY code path**: never modified (additive CTA on ReviewBar and the arming condition on its keydown are the only sanctioned diffs, per spec).
- `AgentConversation` never gains `workspaceId` (reference direction is pane→conversationId only).

## 3. Five-phase overview and why this order

Ordering is **risk-first and pause-safe**: each phase is independently shippable, and the program is net-positive at every pause point. The **endings-first ruling** (Q6, Bravo won, Alpha conceded) is the ordering's spine: the UX finding named unlandable worktrees the worst live bug, and deferring the fix behind tile work would leave it live ~6 weeks. So the two worst shipped bugs (unlandable worktrees, the Codex mode lie) close in Phases 1-2, inside the EXISTING Agents tab, before any migration surface exists.

| Phase | Effort | Delivers | Why here |
|---|---|---|---|
| **P1 — Foundations, contract pin, honest fixes** | 1.75 ew | Pane schema (TS+Rust+DTO threading past the five-field whitelist), inert downgrade carrier + agentId-keyed-site audit, `normalizePanes()`, `sessionIndex` projection, `sessionGlue` (GC/reconciliation/openSession skeleton) + eslint store-isolation rule, `sessionContract.test.ts`, `conversation.worktree` stamped via the `launchConversation.ts` extraction; user-visible: clickable GitDashboard diff rows (blind-commit fix), Codex honesty. | Dark-ships the substrate every later phase stands on; pins the frozen contract in CI before anything can drift; the two cheapest honest fixes ship even if the program pauses here. Bravo's contract-test half of the withdrawn P0 pre-phase lands here. |
| **P2 — Endings in the existing Agents tab** | 1.5 ew | `merge_conversation_branch` (dirty-root refusal, conflict-intact, branch `-D` + dir removal + state→landed), `gitPublish.ts` extraction (PR number recorded), Discard (first-ever caller of `removeConversationWorktree`, dirty-checked), Keep-with-chip, WorktreeLifecycleBar in GitDashboard reachable via an explicitly disposable ~30-LOC modal host (priced, deleted in P5), Finish→Commit CTA on ReviewBar. | The worst live bug closes before any migration (the ruled ordering). All backend work is permanent regardless of where UI eventually mounts; the disposable host is cheap pause insurance. |
| **P3 — Conversation tile + unified add flow** | 2.25 ew | FIRST COMMIT (hard-blocks the phase): Y/N focus gate — `keyboardScopeActive` driven by `layoutStore.activePaneId`, dual-mode arming, condition-based Escape layering, dual-mode tests green BEFORE ConversationTile registers in renderTile. Then ConversationTile (~140 LOC, unforked AgentChatPane, two additive props), renderTile branch on `pane.kind`, auto-zoom-on-review with `autoZoomedBy`, container-query header, draft-tile first-run flow, AddAgentPicker + zero-state. Streaming behind the numeric gate (4 streams, 2x2, p95 <16ms) with the 4Hz ScheduleFrame fallback. | The gate lands exactly when its multi-pane arm first becomes testable (the ruled timing — no untestable branch bit-rotting for weeks) yet still hard-blocks any second chat pane from mounting. The keep-list stack first goes multi-instance here, so the unforked-two-prop composition minimizes diff in exactly the riskiest phase. Agents tab still primary. |
| **P4 — Fleet layer** | 1.5 ew | FleetSidebar (needs-you pinned group, filters, search, pins, project groups via shared sidebar-prefs), `sessionStatus.ts` single-truth rollup (sidebar + tab-strip dot + RunningAgentsChip), virtual rows + `openSession` materialization, archive lifecycle fan-out + cleanup policy + unlanded-work toast, dual-run parity gate, "Sessions have moved" banner. | Needs the tile (P3) so multi-tile rows and needs-you focus targets exist; needs endings (P2) so archive's unlanded-work guard has something to guard. Dual-run de-risks the cutover before anything is deleted. |
| **P5 — Agents-tab retirement** | 0.75 ew | Six entry points retargeted to `openSession` + `focusPaneRequest`; "agents" CoreView becomes a one-release redirect shim; Ctrl+N, Ctrl+Shift+V, `sweepAutoArchive` interval, and AgentsOnboarding hoisted to App level / empty-fleet state; AgentsView + AgentSidebar + standalone composer path + P2's modal host deleted after parity sign-off. | Deletion is last and gated on the parity checklist + dual-run gate — the old surface dies only after the new one is proven equivalent on the same store state. |

Every phase gates on: the protected keep list untouched, the PTY persistence smoke, and `sessionContract.test.ts` green. Per-phase regression gates are enumerated in the spec's Phase plan and are binding.

## 4. Protected keep-list obligations

The consolidation program's Keep list (dev/archive/consensus-ux-consolidation-plan.md) remains protected; the spec's "Keep-list protection plan" is the binding per-item mechanism. Summary of obligations:

1. **Fork-and-resend** — AgentChatPane never forked/rewritten; two additive props with standalone-preserving defaults; suite unmodified every phase + P3 two-tiles variant; engine paths pinned by `sessionContract.test.ts`.
2. **Queued-send-while-streaming** — Composer and agentDraftStore move nowhere; drafts already per-conversation-keyed; suite unmodified every phase + P3 two-tile independence test.
3. **Y/N approvals** — extended, never altered: the document-level keydown (`ReviewBar.tsx:71`) gains only an arming condition; no-pane-context behavior byte-identical; dual-mode tests land as P3's first commit before any second pane can mount.
4. **PTY persistence** — keep-all-mounted display:none pattern never modified; mount-on-activation fallback applies ONLY to zero-PTY workspaces; zoom is the existing CSS-maximize, never a remount; archive kills PTYs, workspace switch never does (explicit P4 gate); reload-and-reconnect smoke every phase; `sessionId` stays pane-only.
5. **DiffRows/hunkDiff** — consumed by composition, never modified (P1 clickable rows, ReviewSurface); suites untouched every phase.
6. **ReviewSurface/editBaselineStore/reviewStore** — never rendered below zoomed width; Finish CTA additive to ReviewBar only; any diff to these files fails the phase gate by policy.
7. **Notification layer** — untouched infrastructure; the three deep-link producers change only their destination, in P5, gated by an end-to-end landing test.
8. **Unified Composer** — mounted per tile, wiring unchanged; first-run chips are additive footer content; approval/diff-comment/ReviewBar stacking preserved pixel-for-pixel; existing component tests run unmodified.

Also protected by construction: Flight Deck's attach-by-explicitId flow (headlessness proof), `agentWorkspaceDecoupling.test.ts`, and the legacy `workspaceId`-strip in `agentConversationPersistence.ts` (gets a named pin test in P1). Repo convention: never run prettier/`pnpm format` on `src/`; verify with tsc + eslint + vitest.

## 5. Top program risks and mitigations

1. **Silent field drop in the DTO whitelist (data loss on save).** `toDtoWorkspace` whitelists exactly five pane fields (`src/lib/tauri.ts` ~1443-1449), so unmirrored `kind`/`conversationId` vanish on the next save. *Mitigation:* thread both fields through toDtoWorkspace AND fromDto in P1; serde/DTO round-trip test is a P1 exit gate and a standing gate thereafter.
2. **Downgrade corruption.** An old binary reading a conversation pane could coerce it into a live shell-spawning pane (the `From<String>` `_ => Terminal` catch-all). *Mitigation:* the ruled inert carrier — conversation panes persist `agent_id:"terminal"`; old binaries render a benign terminal tile and strip the new fields on re-save; the P1 old-binary RE-SAVE simulation gate proves the reconciliation sweep re-surfaces the conversation as an unplaced row with zero conversation-file mutation. No version-stamp refusal (rejected: it would lock a downgraded binary out of the entire monolithic `state.v1.json`).
3. **Keep-list regression when the protected stack goes multi-instance (P3).** One keypress applying to two tiles, double-fired Escape, remount-destroyed review state or PTY scrollback. *Mitigation:* Y/N focus gate as P3's hard-blocking first commit with dual-mode tests; condition-based Escape layering; CSS-maximize-only zoom (zero new zoom machinery); protected suites must pass with ZERO modifications each phase; any diff to review-stack files fails the gate by policy.
4. **`api-agent:*` contract drift breaking Flight Deck / Remote Agents R0.** *Mitigation:* contract frozen by charter AND pinned by `sessionContract.test.ts` from P1 (explicitId/skipBackendStart, sessionId==id, hydration round-trip, legacy-key strip, canonicalizeAgentCli); eslint no-restricted-imports keeps the stores from coupling; sessionIndex is a deletable read-only projection; breaking it turns CI red inside the increment that broke it.
5. **Destructive git operations (the fix for unlandable work must not create data loss).** *Mitigation:* `merge_conversation_branch` gated on the existing `git_safety_check` clean-root guard; conflicts leave both worktree and root checkout intact; every non-Discard removal path dirty-checks first; Discard is confirm-gated; cleanup-on-archive defaults to only-when-safe with the specified predicate (clean AND ancestry-merged OR recorded-PR-merged OR zero-ahead), everything else Keeps visibly; auto-archive always Keeps. The failure mode of an imperfect predicate is visible accumulation, never loss. Fixture-repo lifecycle tests are P2 gates.
6. **N-tile streaming performance (watch-many-all-live posture).** *Mitigation:* numeric gate — 4 concurrent streams in a 2x2 mosaic hold p95 frame <16ms on reference hardware; named fallback (non-focused tiles coalesce to 4Hz via the injectable ScheduleFrame) engages on breach and the gate re-runs; Summary-density is the recorded second-level fallback only, not built speculatively; profiler assertion that non-streaming tiles don't re-render on another tile's flush.
7. **Mounted-cost blowup from materialized conversation-only workspaces** (every active workspace is a permanently-mounted header tab). *Mitigation:* no bulk migration — lazy materialization only on open; P4 mounted-cost gate (20 materialized conversation-only workspaces near-zero idle CPU, bounded listener count); named fallback: mount-on-activation for zero-PTY workspaces (PTY keep-all-mounted pattern itself never modified).
8. **Cutover strands users or loses parity.** *Mitigation:* dual-run parity gate (identical needs-you counts on the same store state) + parity checklist (search, pins, archive filter, project rename) before deletion; archived unwrapped conversations are first-class Archived-filter rows; the one-release redirect shim materializes real workspaces for stale deep links and persisted `activeView='agents'` cold-starts; grep-clean gate at P5.
9. **Scope creep / silent re-decision.** Every contested point already carries a ruling with code evidence. *Mitigation:* this charter's stop-and-flag rule; the rejected-alternatives list in §2 is a hard fence; the PaneHeaderShell extraction and Summary-density mode are explicitly recorded as post-program/conditional items, not backlog to smuggle in.

## 6. Definition of done

The program is done when ALL of the following hold:

1. **All five phases merged** to main, each having individually passed its spec-enumerated regression gates.
2. **Full gate green, including e2e:** `sessionContract.test.ts`; every protected keep-list suite passing with zero modifications to protected files; PTY reload-and-reconnect smoke; serde/DTO round-trip + old-binary re-save simulation; worktree lifecycle fixture tests (merge-back, dirty-root refusal, conflict-intact, Discard, Keep); Y/N dual-mode + Escape layering tests; perf gate (4-stream p95 <16ms or documented fallback engaged); mounted-cost gate; dual-run parity assertion; end-to-end notification deep-link landing tests (focused+flashed tile with pending approval visible); tsc + eslint + vitest green.
3. **Migration verified against legacy persisted data:** real pre-program `state.v1.json` and on-disk conversation files hydrate with zero conversation-file mutation; every legacy unplaced conversation (including archived) appears as a stable virtual row; reconciliation-scale test at 200+ conversations passes with stable identity across restarts; `openSession` idempotence (exactly one `ws-wrap-<convId>` workspace per conversation); legacy worktrees usable via the explicit base picker.
4. **Old Agents deep links redirect:** persisted `activeView='agents'` cold-starts and all retargeted producers (`promptStore.ts:105`, `RunningAgentsChip.tsx:88`, `PinnedApprovalBanner.tsx:71`, LeftRail, Shift+1, view switch) land on a real materialized workspace with the offending pane focused+flashed — never a blank view; the redirect shim survives exactly one release, then its deletion is a scheduled follow-up.
5. **Deletion complete:** grep-clean for `setActiveView("agents")` outside the shim; zero imports of AgentsView/AgentSidebar/the disposable modal host; hoisted keybindings (Shift+1, Ctrl+N, Ctrl+Shift+V), App-level sweepAutoArchive interval, and re-homed AgentsOnboarding all verified in their new homes.
6. **Honesty fixes live:** Codex mode UI shows only honorable postures (snapshot-gated); GitDashboard file rows open real diffs; `removeConversationWorktree` has a caller; a conversation's work can Merge back / Create PR / Discard / Keep from inside the app.

Post-program (recorded, explicitly out of this program's DoD): PaneHeaderShell shared-header-grammar extraction; deletion of the redirect shim after one release; Summary-density fallback only if 4Hz coalescing fails its re-run; remote git write enabling Land on SSH sessions.
