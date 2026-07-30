# Agents & Workspace Consolidation Program — Two-Team Consensus (2026-07-01)

Produced by a 37-agent, two-team adversarial review (Team Alpha: product-design lens; Team Bravo: staff-engineering lens), each with independent code review of both panes, competitor UX research, and deep-dive sub-teams, followed by cross-examination, defense rounds, and a neutral moderator synthesis. Every load-bearing claim below was re-verified against the code by the moderator before ruling.

## Executive summary

Both teams — one reviewing through a product-design lens, one through an engineering lens — independently converged on the same diagnosis: PacketADE's engine (substores, PTY persistence, diff primitives, SSH discipline) is genuinely strong, but the visible surface renders every concept 2-5 times, ships ~1,800 LOC of verified dead or fake controls, and carries a handful of core-loop correctness bugs (zoom spawns a duplicate paid agent process; turns with 3+ edits render zero edit cards; the mode chip misreports and clobbers permission state; GitDashboard's default commit errors 100% of the time; plan approval desyncs and double-sends). The path to Cursor/Conductor-level slickness is roughly 60% deletion and consolidation, 25% correctness fixes, 15% a budgeted typography/spacing pass — not new features. After cross-examination, every disagreement resolved to 'which half survives', never 'whether to consolidate'; the six contested calls are ruled below, each checked against the code by the moderator. The program is ordered P0 (trust-destroying bugs + fake UI, mostly small), P1 (the structural consolidations that produce the slick feel), P2 (state-layer long tail that stops the clutter growing back). Estimated net deletion: ~40% of current chrome and several thousand LOC, funded back into one excellent review surface, one autonomy dial, and a visual-polish pass.

## North star

PacketADE should feel like an orchestrator's seat, not a cockpit: one calm conversation per agent, one door to review, one dial for autonomy. Every concept has exactly one home — one mode chip (with a fine-flags popover), one model picker, one context ring, one pricing table, one plan surface approved inline where you finish reading, one pending-changes bar above the composer that expands into the single multibuffer review with keyboard-rhythmic Keep/Undo, anchored to recorded baselines so diffs stay truthful after apply, on every runtime. Tool bursts fold themselves into live one-line rollups as they complete; approvals arrive rarely and mean something (reads never prompt, in-project edits auto-apply into review, only shell/network/out-of-project interrupts); denial steers the agent instead of stalling it. The sidebar curates itself — grouped by project, 'needs you' pinned on top, merged work auto-archived — and the UI earns its quiet because the already-shipped notification layer guarantees it will speak when it matters. The Workspace is a stable, opinionated pipeline: templates as the front door, panes with four-element headers, zoom that maximizes the pane you already have, and GitDashboard as the single ending (review → stage → commit → archive). Nothing on screen is fake, dead, or duplicated — every control visibly does what it claims — and the ~40% of chrome this frees is spent where Conductor spent it: two text sizes, whitespace between turns, borders only on interactive elements, one excellent diff. The engine was always good; the product becomes the calm cockpit-free window onto it.

## Consensus findings (both teams converged independently — highest confidence)

1. Autonomy/permission state has no single source of truth: four adjacent header controls (mode chip, Plan toggle, permission <select>, Approve-writes toggle) all write the same three flags AgentModeChip derives. Moderator-verified in agentModeChipUtils.ts: deriveMode has no deny_all branch (a 'Deny risky' session displays as full-tools — a safety-posture misrepresentation) and flagsForMode hardcodes approveWrites:false in all four branches, so any chip cycle silently destroys the approveWrites setting.

2. ~1,800 LOC of verified dead or fake UI shipped in the flagship surfaces: layout preset buttons and Ctrl+1-4 write to a mosaicStore nothing mounted reads; a ~460-line dead layout/ component cluster; 'Keep terminals alive' toggle read by nothing, shown in two places; NewAgentTaskModal + legacy AgentTask store lane; ServerSelectorPopover; three onClick-less sidebar buttons; @web:/@git: mention tabs whose tokens nothing resolves — all kept green by tests that render dead code.

3. Workspace zoom is destructive: the overlay mounts a SECOND WorkspacePane for the zoomed pane (moderator-verified: WorkspaceMosaicContainer.tsx:119 vs :147, original hidden 'invisible absolute') and useTerminalSession's 200ms auto-start spawns a duplicate paid agent PTY, clobbering sessionId bookkeeping and orphaning the original session.

4. Chrome density is 3-4x every leading product: ~14-19 interactive controls in a 33px chat header plus an 8-cluster SessionHealthBar; model shown 4x; context % computed twice with mismatched warning thresholds; cost in 3 places via 2 pricing systems; up to ~33-38 stacked approval controls using 6 affirmative and 4 negative verbs where Cursor shows 2-4.

5. Diff review sprawls across ~9 surfaces on 2 incompatible hunk engines: PendingEditPrompt's private engine can accept both sides of a replace (probe-confirmed merge corruption), DiffPane's apply writes directly to disk bypassing respondEdit (leaving the agent blocked and 'Reject' lying to the model), and the two stacked batch banners label the identical action 'Accept all' vs 'Apply all' (moderator-verified).

6. Plan approval runs on two unsynchronized systems: PlanModeApprovalMenu never calls agentPlanStore.approvePlan (moderator-verified — it only flips planMode/permissionMode and sends canned text, including a literal 'approach X vs Y' placeholder), so PlanPanel sticks on 'proposed' and repeat clicks double-send approvals to the model; the Spec→Plan→Code FSM is process ceremony no leader ships.

7. Two parallel composer implementations (~3,100 LOC) where @ and / have different semantics in 'new chat' vs 'reply', slash-command resolution is triplicated and order-coupled, and bare Tab sends the message — a keyboard-navigation landmine.

8. Streaming and scrolling are broken where users judge slickness (converged after cross-exam, both mechanisms verified): the chunk listener rebuilds the ENTIRE conversations array per streamed token with zero batching (apiAgentListeners.ts, 10 full-array map sites), stream-settle causes a measured 318px lurch, and WKWebView ships no CSS scroll anchoring so scrolling up through history jumps on 27/33 lazy-row mounts (max 840px) against MessageList's own documented false assumption.

9. The diff data layer is untruthful (Bravo-found, Alpha-adopted): no recorded baselines means every non-pending surface diffs proposed content against LIVE disk, degrading applied edits to +0/-0 whole-file dumps; and the transcript edit layer keys only on tc.name==='write_file', so it never fires for Claude Code (Write/Edit) or Codex (apply_patch) sessions.

10. Confirmed core-loop rendering bug (Bravo-found, Alpha-adopted): MultiFileEditCard bails when call.input arrives as a JSON string, so turns with 3+ completed write_file calls render ZERO edit cards after ToolCallRenderer already suppressed the individual ones.

11. GitDashboard's default commit path errors 100% of the time (moderator-verified: stageAll defaults true at line 152, passed to gitCommit at line 258, hard-rejected by src-tauri core/git.rs:235-237), while a second commit UI (CommitModal) with opposite staging semantics lives in the global Toolbar — two commit UIs, one broken by default.

12. Test coverage is inverted: dead code is tested while the file-writing hunk math (applyAcceptedHunks/mergeHunks), the entire chat render path, and all approval components have zero coverage.

13. The sidebar buries the one signal that matters ('needs you') under ~14 elements per row including O(messages) per-row cost aggregation, and a single global agentInputText field bleeds half-typed drafts across conversation switches.

14. The keep-list is near-identical across teams: the consolidation seeds already exist in-repo (DiffRows + lib/hunkDiff, the substore split, ExplorationRollupCard, AgentModeChip's derived-mode pattern, workspace PTY persistence, SSH host-key discipline, fork-and-resend, templates, GitDashboard) — the redesign is finishing consolidations the team already started.

## Change program

### P0

#### P0-1. Purge the dead/fake feature batch (~1,800 LOC)

*type: cut · pane: both · effort: small*

Both teams independently verified the same corpses: mosaicStore + dead layout/ cluster + preset buttons + Ctrl+1-4 no-ops, 'Keep terminals alive' placebo (both surfaces), NewAgentTaskModal + legacy AgentTask lane, ServerSelectorPopover, onClick-less sidebar buttons, @web:/@git: zero-resolver mention tabs, and the tests that green-light them. Visible controls that do nothing teach users the UI lies; deleting first shrinks every later refactor.

#### P0-2. Fix workspace zoom's duplicate-agent spawn

*type: fix · pane: workspace · effort: small*

Moderator-verified: the zoom overlay mounts a second WorkspacePane while hiding the original, and useTerminalSession auto-starts a duplicate paid, file-writing agent PTY after 200ms, clobbering setPaneSession and orphaning the original on unmount. Replace with CSS-maximize/portal of the already-mounted tile. Trust-destroying bug in the most-demoed gesture; small fix.

#### P0-3. Fix the disappearing-edits bug with one shared parseToolInput decoder

*type: fix · pane: agents · effort: small*

MultiFileEditCard bails on JSON-string inputs so turns with 3+ write_file calls render zero edit representation. Unify the six duplicated string/object hedges on ToolCallCard's correct one and add the render test with realistic string inputs that would have caught it.

#### P0-4. Redesign the mode-flag bijection, THEN collapse four permission controls into AgentModeChip + fine-flags popover

*type: fix · pane: agents · effort: small*

Moderator-verified both bugs: deriveMode has no deny_all branch and flagsForMode hardcodes approveWrites:false everywhere — so the bijection redesign (deny_all representable, approveWrites never clobbered, both test cases added) is a hard prerequisite, then the Plan toggle, permission <select>, and Approve-writes toggle die into the chip's popover. One source of truth for autonomy; the single loudest calm-per-line win.

#### P0-5. Remove keyboard landmines and per-message chrome filler

*type: cut · pane: agents · effort: small*

Cut Tab-to-send (hijacks focus navigation — verified), the Alt model-nudge (silently swaps billing models), Ctrl+S draft stash (replaced by invisible per-conversation draft persistence), AgentQuickActions ('Undo' sends a prayer to the model), and the AssistantCostPill's one-IPC-per-message against a static pricing table (stamp costUsd on the message, show on hover). Pure subtraction, immediate polish.

#### P0-6. Streaming + scroll fluidity workstream

*type: fix · pane: agents · effort: medium*

Two independent, both-verified defects that define the 'not slick' feel: rAF-coalesce the chunk listener so per-token events stop rebuilding the entire conversations array (10 full-array map sites, one save per chunk), add the ~15-line WKWebView scrollTop compensation on lazy-row mounts (27/33 scroll-up jumps), make ExplorationRollupCard live/incremental so stream-settle changes nothing (kills the 318px lurch), and move composer draft text out of the god store. Neither fix substitutes for the other; ship both.

### P1

#### P1-7. Repair diff-pipeline foundations before redesigning it: baselines + tool-name normalization + tests

*type: fix · pane: agents · effort: medium*

Record per-tool-call/turn baselines (generalize anthropic.ts's existing readBefore capture) so review surfaces stop diffing against live disk and stay truthful after apply — a hard prerequisite for both the review bar and tiered gating. Normalize Write/Edit/NotebookEdit/apply_patch/write_file into one canonical pipeline so the transcript edit layer fires on Claude Code and Codex. Cover hunkDiff/mergeHunks/write_file parsers/planDetection — zero-coverage, file-writing logic.

#### P1-8. One canonical review surface with one hunk engine and one apply pipeline

*type: redesign · pane: agents · effort: large*

Inline edits collapse to one-line file chips; a persistent 'N files · +X/-Y · Review' bar above the composer expands into the single multibuffer review (DiffPane/EmbeddedDiffPane merged) with per-hunk keep/undo from lib/hunkDiff ONLY; delete PendingEditPrompt's corrupting private engine; ALL applies flow through respondEdit — no direct-to-disk side door; merge TurnDiffSummary + PendingApprovalsRollup into one banner; 'reviewed' survives as an explicit GitHub-style Viewed checkbox on a normal persisted slice. Covers all ~9 diff-adjacent surfaces and fixes correctness bugs simultaneously.

#### P1-9. Tiered approval gating + pin approvals that scroll out of view

*type: redesign · pane: agents · effort: medium*

Never prompt for reads/search; auto-apply in-project edits into the post-hoc review bar (requires the baselines item); reserve blocking prompts for shell/network/out-of-project; deny-and-continue so rejection steers instead of stalling; fold 'Always allow rule' into a split-button scope on Allow; make Y/N work while collapsed. Pin approvals that scroll away — the genuinely missing half of the notifications story (the OS-notification layer itself already ships and is protected, not rebuilt). Collapses the ~33-38-control approval stack while making remaining prompts meaningful.

#### P1-10. Chat header consolidation: ~14-19 controls to ~5, delete SessionHealthBar

*type: simplify · pane: agents · effort: medium*

Resting header = AgentModeChip, model picker, ContextUsageRing (one threshold constant), Changes chip, overflow menu (verbosity/export/ContinueIn/memory toggle), close. SessionHealthBar dies as a component — project/branch/session-cost fold into one thin element; the MCP checkbox popover (a 288px settings panel whose caption admits changes apply on next launch) moves to Settings. Verbosity becomes ONE global keyboard-cycled view mode (Summary/Normal/Verbose), never JSON-in-the-chat.

#### P1-11. Unify plan approval on the inline menu; cut the Spec FSM; inline Restore replaces CheckpointPanel

*type: simplify · pane: agents · effort: medium*

PlanModeApprovalMenu stays as THE approval (Bravo reversed after verifying plan_block is a TodoWrite mirror that cannot carry approval) but must call agentPlanStore.approvePlan to kill the verified desync/double-send, and the 'approach X vs Y' placeholder string is fixed. PlanPanel slims to an auto-hiding pinned checklist; SpecPanel + the Spec→Plan→Code FSM are decisively cut; CheckpointPanel (whose own banner admits it doesn't rewind code) becomes a per-message Restore affordance on fork-and-resend. Worst-case chrome drops from 6 strips to ~3.

#### P1-12. Merge the two composers into one component

*type: redesign · pane: agents · effort: large*

One component, launch/chat variant prop, one trigger system (usePrefixMatcher + InputPopover), one slash-command source of truth shared by popover and keyboard handler (kills the order-coupled triplication and the querySelector/synthetic-mousedown hack), one @ / semantic, attachment staging ported, MentionSourcePicker files-only. Fork-and-resend and queued-send-while-streaming are explicit protected behaviors with regression gates; unit-test the now-single keyboard handler. Deletes ~3,100 LOC of duplication.

#### P1-13. Sidebar diet + self-cleaning list + per-conversation drafts

*type: simplify · pane: agents · effort: medium*

First-class 'needs you' status sorted to top with a count badge; three-fact rows (status/title/agent) dropping the O(messages) per-row cost pills and per-keystroke full scans; hard-code group-by-project; cut tags (write-only — read by no search/filter/group code) and the sort/group configurators; auto-archive merged/closed sessions; fix the global agentInputText draft bleed with per-conversation drafts.

#### P1-14. Workspace chrome diet: tile headers, one creation flow with templates as the front door

*type: simplify · pane: workspace · effort: medium*

Tile header = grip, identity dot (colors from lib/agentColors, deleting the five divergent hand-rolled maps), name, status, zoom, one overflow. ONE 'Add agent' entry point — delete NewAgentModal and the collision with the Agents pane. WorkspaceCreationModal leads with the one-click templates (the genuinely good part, promoted per both teams' final lists); location/name/per-agent tuning collapse behind the AdvancedAccordion. Cut the accent-color picker and the memory-dashboard sidebar sections; workspace list owns its 240px.

#### P1-15. Git consolidation: GitDashboard surface + CommitModal's working engine + per-file staging

*type: simplify · pane: workspace · effort: medium*

Moderator-ruled after verifying both halves: GitDashboard is the single git home (review gating, trailers, remote read-only handling survive) but its commit engine is the broken half — stageAll defaults true and the Rust safety layer hard-rejects it, so the default commit errors 100% of the time (flip that default day one). Transplant CommitModal's staged-only engine, snapshotted projectPath, and Fixes #N guard; ADD a per-file stage/unstage UI (agents write unstaged trees — staged-only with no staging UI stalls silently); then delete the CommitModal shell and the error-swallowing Toolbar pull/push/commit trio.

#### P1-16. Typography and spacing pass (design tokens), sequenced after structural consolidation

*type: add · pane: both · effort: medium*

Both teams converged post-debate: Conductor's praised slickness shipped as type, spacing, and border discipline, not panels — deletion alone yields a sparse cockpit, not a slick product. Two text sizes (11px body / 10px meta), whitespace between turns, borders only on interactive elements, per-turn metadata on hover, fixed scannable status labels replacing tabStore's randomized ones. Runs last among P1s so tokens style surfaces that have stopped moving.

#### P1-17. One global transcript view mode + uniform one-line tool rows

*type: simplify · pane: agents · effort: medium*

Replace the per-conversation verbosity <select> threaded through 6 components with a single Summary/Normal/Verbose enum (keyboard-cycled, in overflow); non-edit/non-terminal tools render as one-line verb rows; merge the three 'agent is working' indicators. Summary mode doubles as the multi-agent scan view — the payoff for an orchestration product.

### P2

#### P2-18. Memory affordances collapse to one surface

*type: simplify · pane: both · effort: small*

One header/overflow toggle whose popover shows 'N patterns · M lessons · ~X tok' with a preview; MemoryInjectionCard shrinks to a one-line collapsed row; delete ContextPreviewChevron and the workspace 'Memory learning/injecting' chip. Memory has a dedicated view one rail-click away; three ambient treatments is two too many.

#### P2-19. Small-cuts batch: disabled Cloud segment, Preview Browser sub-tab, Inspector regex plan parser

*type: cut · pane: agents · effort: small*

All agreed by both teams: a permanently disabled button for a nonexistent feature is anti-polish; the sandboxed iframe browser silently blanks on most real sites with 'Open externally' one button over; the regex checkbox parser is a second heuristic plan derivation that can disagree with the store-backed Plan tab one click away.

#### P2-20. State-layer pruning + orchestration convergence on asyncFlightStore

*type: cut · pane: both · effort: large*

Cut ideationStore/goalStore/deployStore (each competes with just asking the agent); delete vestigial AgentConversation mirror fields and dual-write persistence; prune near-duplicate api-* provider variants; unify on ONE pricing source; converge orchestration on asyncFlightStore's worktree-attempt path, retiring the tick-loop scheduler and flightPlannerStore FSM and decoupling agentApprovalStore's cross-store reach. Every store deleted is chrome that can never demand a chip again — this is what stops the clutter growing back.

## Contested points and moderator rulings

### Which surface owns plan approval

- **Team Alpha:** Keep the inline PlanModeApprovalMenu as THE approval (the Claude Code/Cursor pattern — decision appears where the user finished reading the plan), wire it to agentPlanStore.approvePlan to kill the desync; plan_block cannot carry approval because it is a TodoWrite mirror, and no structured plan-proposal event exists anywhere in the pipeline.
- **Team Bravo:** Initially: cut the looksLikePlan regex menu as legacy and converge on PlanPanel fed by structured plan_block events with posture choices in its footer. Reversed in defense after verifying protocol.ts calls plan_block a 'structured TodoWrite mirror' and no proposal event exists.
- **Moderator ruling:** Alpha's direction stands, now unanimous. I re-verified PlanModeApprovalMenu.tsx: its handler touches only setPlanMode/setPermissionMode/sendMessage — approvePlan is never called, confirming the desync/double-send mechanic. Bravo's contributions survive inside the item: decisively cut the Spec FSM, fix the 'approach X vs Y' placeholder, and swap the regex trigger for a real proposal event only when the sidecar grows one.

### Which commit implementation survives the git consolidation

- **Team Alpha:** GitDashboard is the single git home; initially proposed deleting CommitModal outright for its 'staged-only' semantics, then conceded the engine question after Bravo's evidence.
- **Team Bravo:** Initially nominated CommitModal as the sole commit UI (backend-aligned staged-only engine), then flipped to 'GitDashboard's inline flow survives' — a wording that contradicts their own finding that its stageAll path is backend-rejected.
- **Moderator ruling:** I verified both halves myself: core/git.rs:235-237 hard-rejects stage_all, and GitDashboard defaults stageAll=true and passes it straight through — its default commit errors 100% of the time. Ruling: GitDashboard is the surface (keep review gating, flight trailers, remote read-only handling); CommitModal's staged-only engine plus snapshotted projectPath and Fixes #N are transplanted in; a per-file stage/unstage UI is ADDED because agents write unstaged trees and staged-only with no staging affordance stalls silently; then the modal shell and the error-swallowing Toolbar git trio are deleted. Flip the stageAll default immediately as an interim fix.

### Is the AgentModeChip collapse safe to execute as-is

- **Team Alpha:** Top-3 priority; originally claimed 'tests confirm the round-trip is safe' with deny_all as the only defect. Retracted the safety claim in defense.
- **Team Bravo:** The round-trip destroys state: flagsForMode hardcodes approveWrites:false in all four branches and rewrites permissionMode on manual→manual, so making the chip the ONLY control ships a state-eating widget unless the mapping is redesigned first.
- **Moderator ruling:** Both verified by me in agentModeChipUtils.ts (lines 16-22 and 25-45). Bravo is right on the prerequisite, Alpha is right on the priority: the bugs live in the exact 52-line file the consolidation must touch anyway, and today four controls already reach the broken mapping. Ruling: one P0 item — bijection redesign (deny_all branch, approveWrites representable and never clobbered, both test cases) as an explicit first step, then the collapse.

### OS notifications: missing table-stakes feature or already shipped

- **Team Alpha:** Listed 'notifications when an agent finishes or blocks' as the one missing table-stakes feature and the enabler for deleting ambient status chrome. Withdrew after Bravo's evidence.
- **Team Bravo:** The feature already ships pref-gated and debounced: notifySessionComplete/notifySessionError/notifyApprovalNeeded through notificationStore prefs, plus the useTerminalSession PTY side — scheduling new work here wastes a priority slot.
- **Moderator ruling:** Bravo is right; Alpha's withdrawal is accepted. The notification layer moves to the protected keep list so consolidation doesn't regress it, and the genuinely missing sub-feature — pinning approvals that scroll out of view — is promoted into the tiered-gating item. Alpha's underlying principle survives as the north star's contract: a quiet UI is only trustworthy because the system guarantees interruption.

### Review-action verbs: Keep/Undo vs Accept/Reject

- **Team Alpha:** Standardize the batch review bar on one verb pair: Keep/Undo.
- **Team Bravo:** Standardize on Accept/Reject everywhere across approvals and review.
- **Moderator ruling:** Neither team addressed that these describe different moments. Ruling: two pairs, each with exactly one home, never mixed within a surface — blocking pre-apply prompts (shell/network/out-of-project) use Allow/Deny as PermissionPrompt already does; the post-hoc review bar uses Keep/Undo (the Cursor pattern, and the only truthful pair once tiered gating makes auto-applied edits the common case — you cannot 'Reject' a change already on disk). The current 'Accept all' vs 'Apply all' mismatch on stacked banners (verified) dies with the banner merge.

### Visual design: distinct workstream or byproduct of deletion, and when

- **Team Alpha:** A budgeted typography/spacing/border pass is where the freed chrome budget goes — Conductor's praised slickness shipped as type and spacing, not panels; deletion alone yields a sparse cockpit.
- **Team Bravo:** Conceded the gap but insists on deletion-first ordering: polishing a header with 19 controls is wasted motion; the token pass is the finish coat after surfaces stop moving.
- **Moderator ruling:** Both right; no real conflict. Ruling: it is a distinct, P1-priority workstream (Alpha) executed last among the P1s, after header/review/plan/composer consolidation stabilizes the layouts it will style (Bravo).

### Scope of the 'dead diff pipeline' on Claude Code/Codex runtimes

- **Team Alpha:** Bravo's 'whole pipeline is dead weight' overstates: the approval-time path DOES fire on Claude Code (canUseTool intercepts Write/Edit/NotebookEdit, captures a true readBefore baseline, emits pending_edit) and Codex surfaces apply_patch approvals; the dead zone is specifically the post-hoc transcript layer keyed on 'write_file'. 'Most-used runtimes' was asserted without data.
- **Team Bravo:** Conceded the overstatement but sharpened the residual: with approveWrites OFF, the anthropic hook returns early, so Claude Code sessions get NO diff representation anywhere — approval-time or post-hoc.
- **Moderator ruling:** Alpha's scoping is correct and matters (nobody should conclude approval review is broken on Claude Code); Bravo's approveWrites-off addendum is real and makes the case stronger, not weaker. The prescription is unchanged and unanimous: tool-name normalization + recorded baselines as a named P1 prerequisite for the review surface.

### useReviewedDiffs reviewed-badge subsystem

- **Team Alpha:** Keep the concept — GitHub PR review's persisted per-file 'Viewed' checkbox is the reference workflow and the hook feeds the exact review pane being promoted; simplify the implementation to a normal persisted store slice with an explicit checkbox.
- **Team Bravo:** Initially cut ('no leader tracks per-tool-call review acknowledgment' — retracted as factually wrong); conceded to keep-concept, replace-implementation.
- **Moderator ruling:** Alpha's position, now unanimous: an explicit Viewed checkbox in the canonical review surface, backed by a persisted slice; the 191-line hand-rolled pub/sub + unbounded localStorage implementation dies.

## Cut list

- Dead layout/ cluster (MosaicContainer, MosaicTile, MosaicToolbar, SessionTabBar, ~460 LOC) + mosaicStore + PaneLayoutControls preset buttons + Ctrl+1-4 handler (verified no-ops)
- NewAgentTaskModal + legacy AgentTask lane in the god store (~350 LOC) + ServerSelectorPopover + the tests that green-light them
- 'Keep terminals alive' placebo toggle (sidebar footer AND settings card — read by nothing)
- Three onClick-less WorkspaceSidebar buttons
- @web:/@git: mention tabs + MentionTypeBar + WebInputPopover/GitBranchPopover (~320 LOC, zero token resolvers)
- Tab-to-send, Alt+./Alt+, reasoning nudge, Ctrl+S draft stash (replaced by invisible per-conversation draft persistence)
- AgentQuickActions chips (Continue/Explain/Undo — 'Undo' sends a prayer to the model)
- Per-message AssistantCostPill IPC (stamp costUsd on the message, show on hover)
- ComposerModePicker's permanently disabled 'Cloud' segment + caption
- PendingEditPrompt's private hunk engine / 'Pick hunks' picker (probe-confirmed merge corruption; silently ignored by some providers)
- SpecPanel + the Spec→Plan→Code FSM (specStage, approveSpec, criteria editor)
- CheckpointPanel side rail (359 LOC — replaced by inline per-message Restore on fork-and-resend)
- SessionHealthBar as a component (project/branch/cost fold into one thin element)
- Inspector 'Plan progress' regex checkbox parser
- Preview pane Browser sub-tab (sandboxed iframe that blanks on most real sites)
- Per-pane accent color picker + the five divergent hand-rolled agent-color maps (unify on lib/agentColors)
- Sidebar conversation tags (write-only: read by no search/filter/group code) + group/sort configurators
- WorkspaceSidebar Learned Patterns / Recent Learnings / Session Stats sections + workspace header 'Memory learning/injecting' chip
- CommitModal shell + Toolbar pull/push/commit trio (after engine transplant into GitDashboard)
- NewAgentModal (one 'Add agent' entry point survives)
- MCP checkbox popover from the header badge row (relocate to Settings)
- MemoryInjectionCard prose + ContextPreviewChevron (one memory surface survives)
- useReviewedDiffs hand-rolled pub/sub + unbounded localStorage (concept survives as a Viewed checkbox on a persisted slice)
- ideationStore, goalStore (+ PlanPanel goal-binding row), deployStore
- Orchestration tick-loop scheduler + flightPlannerStore FSM (converge on asyncFlightStore's worktree-attempt path)
- tabStore randomized status labels ('Cogitated', 'Brewed') — fixed scannable vocabulary
- SessionHealthBar vanity counts, SUB-AGENT footer rows, bash 'ask agent to re-run' button

## Keep list (protected — regression gates required where noted)

- Mount-once lazy virtualization + ResizeObserver bottom-pin — correctly sized (transcripts peak ~132 rows, p95=99; NO windowing library) — with the WKWebView scrollTop-compensation caveat now attached
- diff/DiffRows.tsx shared renderer + lib/hunkDiff.ts (probe-verified correct) as the ONLY diff renderer and hunk engine
- The substore architecture (agentApprovalStore/agentPlanStore/agentStreamingStore/persistence/listeners) + centralized failTurn unwind — the pattern everything converges on
- Fork-and-resend (edit-a-prior-message) and queued-send-while-streaming — PROTECTED behaviors with explicit regression gates on the composer/timeline consolidation; fork-and-resend also subsumes checkpoints
- ExplorationRollupCard — promoted to the LIVE streaming representation
- Y/N keyboard approvals with typing-context guards + collapse-at-3 hysteresis
- AgentModeChip's derived-mode pattern (post bijection fix) — it absorbs its neighbors
- PermissionPrompt's core: real command surfaced up front, amber→red destructive-bash escalation, derivePatternHint rule derivation
- Per-row diff line-comments feeding the next turn (CommentableRow / ToolDiffView hover composer) — Conductor's most-praised pattern; add a visible queue indicator
- SideChatOverlay (validated by Claude Code's side chat) — give it one visible entry point, enforce the read-only contract
- ContinueInMenu (OS/CLI/VS Code/Cursor handoff with honest disabled reasons) — also the new home for Codex handoff; fix the synthetic-mousedown hack
- AdvancedAccordion — the design instinct the whole product needs
- Workspace PTY persistence (sessions survive view switches) + SSH host-key pinning discipline + read_file_for_diff path canonicalization
- Workspace templates (Solo/Duo/Review Trio) — PROMOTED to the creation flow's front door
- GitDashboard as the single git home (with CommitModal's engine transplanted in)
- The existing pref-gated OS notification layer (notifySessionComplete/notifySessionError/notifyApprovalNeeded + PTY side) — protect, do not rebuild
- ModelSelector's ctx/pricing metadata + live Ollama list; attachment staging (ported to the unified composer)
- usePrefixMatcher + InputPopover as the surviving trigger/listbox primitives
- The behavioral store test suites (~287 tests) — extend to the render/diff layer, never replace
- AgentsOnboarding + DiffPaneTrigger-style compact +N/-M chip + export-in-overflow
- workspaceStore (418 lines, synchronous, single-writer) + pane-key diffing in WorkspaceMosaicContainer

## Implementation notes

- Execute P0 first (all small/medium, all moderator-verified bugs or dead code); P0 deletions shrink every later P1 refactor.
- The typography/spacing token pass (P1) runs LAST among P1s, after structural consolidation stabilizes the layouts it styles.
- Protected behaviors (fork-and-resend, queued-send-while-streaming, Y/N approvals, exploration rollups, per-row diff comments, PTY persistence) must have regression coverage before the consolidations that touch them land.
- Never run prettier/pnpm format on src/ (repo convention). Verify with tsc + eslint + vitest.
