# WA0 — Workspace/Agents Route, Ownership, and Compatibility Contract

Status: **LOCKED — WA1–WA4 COMPLETE**

Inventory date: 2026-07-29

Parent goal:
[`workspace-agents-restructuring-goal.md`](./workspace-agents-restructuring-goal.md)

Supporting evidence:
[`workspace-agent-settings-decision-2026-07-29.md`](./workspace-agent-settings-decision-2026-07-29.md)

## Purpose

This contract turns the approved Workspace/Agents product direction into
implementation rules. It inventories the current routing and placement paths,
names the new owners, defines compatibility behavior, and gives WA1–WA4
testable exit gates.

The central rule is:

> A conversation exists independently of its presentation. Agents is the
> default presentation for GUI/API-agent conversations. A Workspace
> conversation pane is a compatibility presentation referenced by
> `pane.conversationId`, not the owner of the conversation.

## Baseline facts at inventory time

This table records the pre-WA1 state that justified the route cutover. The
implementation checkpoint near the end of this document records the current
post-WA1 state.

| Concern                   | Current source of truth                                                  | Current behavior                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Top-level view            | `src/stores/appStore.ts`                                                 | `"agents"` is not a `CoreView`; `normalizeView()` redirects it to `"workspace"`.                                                            |
| Primary navigation        | `src/components/layout/LeftRail.tsx`                                     | No Agents item exists. Workspace is the only conversation-facing destination.                                                               |
| View rendering            | `src/App.tsx`                                                            | Workspace stays mounted for PTYs. Other views render conditionally. The right Agent inspector appears only beside Workspace.                |
| New-session shortcut      | `src/hooks/useAgentTabHoists.ts`                                         | Ctrl/Cmd+N creates and activates an empty Workspace.                                                                                        |
| Workspace add flow        | `src/components/workspace/AddAgentPicker.tsx`                            | One picker shows Chat agents first and terminal/CLI clients second.                                                                         |
| Workspace chat draft      | `src/stores/draftTileStore.ts`, `src/components/workspace/DraftTile.tsx` | Picking a Chat agent creates a draft tile. First send creates the conversation and inserts a real conversation pane.                        |
| Conversation launch       | `src/lib/launchConversation.ts`                                          | The launcher can already create a conversation without a Workspace; placement is an optional `onLaunched` callback.                         |
| Conversation selection    | `src/stores/agentTaskStore.ts`                                           | `selectedConversationId` is global and the conversation record has no Workspace owner.                                                      |
| Pane placement            | `src/types/workspace.ts`, `src/stores/workspaceStore.ts`                 | Reference direction is one-way: a Workspace pane may carry `conversationId`; the conversation does not carry `workspaceId`.                 |
| Deep-link navigation      | `src/stores/sessionGlue.ts`                                              | `focusConversationDeepLink()` calls `openSession()`, which creates or activates a deterministic wrapper Workspace.                          |
| Unplaced conversations    | `src/components/workspace/FleetSidebar.tsx`                              | Selecting a virtual conversation row materializes its wrapper Workspace.                                                                    |
| Conversation persistence  | `src/stores/agentConversationPersistence.ts`                             | Conversations persist independently of Workspace panes.                                                                                     |
| Existing-pane persistence | `src/lib/tauri.ts`                                                       | `kind: "conversation"` plus `conversationId` survives Workspace save/load; old binaries degrade safely through compatibility normalization. |
| Multi-window state        | frontend Zustand stores and scoped listeners                             | Interactive state is WebView-local; a second interactive writer is unsafe.                                                                  |

These facts prove the restructuring does not require an agent-runtime rewrite.
It requires a new default presentation and removal of implicit placement from
new navigation/creation paths.

## Baseline entry-point inventory

### Default conversation navigation

At inventory time, all of these called `focusConversationDeepLink()` and
therefore created or activated a wrapper Workspace:

| Entry point                  | Current caller                                  | WA1 target                                                               |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| Running-agent tray           | `components/layout/RunningAgentsChip.tsx`       | Open the conversation in Agents.                                         |
| Off-screen approval banner   | `components/agents/PinnedApprovalBanner.tsx`    | Open the pending conversation in Agents.                                 |
| Flight planning start/resume | `components/flights/LaunchAsyncFlightModal.tsx` | Open the planning conversation in Agents.                                |
| Flight planning card         | `components/flights/FlightPlanningCard.tsx`     | Open the planning conversation in Agents.                                |
| Review-packet approval       | `components/workspace/GitDashboard.tsx`         | Open the conversation in Agents, retaining the authoritative Git ending. |
| Memory session link          | `components/views/memory/MemoryEventCard.tsx`   | Open the conversation in Agents.                                         |
| Prompt launch                | `stores/promptStore.ts`                         | Open the newly created conversation in Agents.                           |

`FleetSidebar.tsx` also called `openSession()` directly for virtual conversation
rows and its archived-worktree toast. Under the target model:

- Workspace Fleet becomes Workspace-only;
- the Agents conversation list owns unplaced and archived conversations;
- an archived-worktree action opens Agents first, where Git ending remains
  reachable;
- no wrapper placement is created; saved wrappers remain migration-compatible.

### Conversation creation

| Creation path                         | Placement today                                 | Target ownership                                                                                         |
| ------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Workspace Chat-agent picker           | Draft tile, then conversation pane              | Removed from new Workspace creation; New Agent lives in Agents.                                          |
| Agents launch composer                | Retired with old Agents view                    | Restored as the primary interactive creation path.                                                       |
| Flight planning                       | Headless conversation, then wrapper deep link   | Remains headless; opens in Agents when the user asks to view it.                                         |
| Flight reviewer                       | Headless conversation                           | Remains headless; appears in Agents when surfaced.                                                       |
| Async Flight attempt                  | Headless/runtime-owned                          | Remains Flight-owned and is not inserted into Agents as a normal conversation unless explicitly exposed. |
| Prompt library launch                 | Conversation followed by wrapper deep link      | Conversation followed by Agents navigation.                                                              |
| Plan/slash-command child conversation | Selects the returned conversation               | Opens/selects the child in Agents; never silently creates a wrapper.                                     |
| One-shot quality/GitHub AI helpers    | Scoped event stream, not a durable conversation | Unchanged; these are feature operations, not Agents sessions.                                            |

### Existing Workspace conversation presentation

The existing path remains valid for compatibility:

`Workspace.panes[] → kind: "conversation" → conversationId → ConversationTile → AgentChatPane`

Closing the pane removes only the presentation. Archiving or deleting the
conversation remains an explicit conversation-level action.

## Target ownership model

### Conversation owner

`agentTaskStore` plus the existing backend/session persistence owns:

- conversation identity and history;
- provider, model, profile, permission posture, and execution target;
- streaming and status;
- approvals and edits;
- plans and review state;
- Memory/MCP context;
- worktree and Git-ending metadata;
- archive/delete lifecycle.

None of those fields move into Workspace state.

### Agents presentation owner

Agents owns:

- the selected conversation;
- conversation fleet filters, search, grouping, pinning, and attention;
- new GUI-agent launch;
- the large conversation presentation;
- its inspector and cross-surface actions.

The same-main-window route may use the existing global
`selectedConversationId`. WA1 must make visible conversation and selection one
coherent state.

### Workspace presentation owner

Workspace owns:

- CLI/PTY panes and their layout;
- local/SSH project identity;
- file/editor and Git workroom presentation;
- saved layouts/templates;
- explicit compatibility panes that reference an existing conversation.

Workspace must not become the owner of a referenced conversation.

## Navigation API contract

WA1 replaces the ambiguous default deep-link behavior with two explicit
operations.

### `openConversationInAgents(conversationId)`

Default for every normal conversation link:

1. verify the conversation exists;
2. select it in `agentTaskStore`;
3. set `activeView` to `"agents"`;
4. do not create, activate, or mutate a Workspace;
5. return a success/failure result so stale notifications can degrade safely.

### `openConversationProjectInWorkspace(conversationId)`

Project handoff:

1. read the conversation's local/SSH execution identity;
2. locate or create a matching CLI Workspace;
3. activate that Workspace without attaching the conversation;
4. do not move or clone the conversation;
5. offer PacketCode as the preferred new CLI pane when installed.

## Route behavior

| Input                                | Required result                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| User selects Agents in the rail      | Render Agents in the main window.                                                                         |
| Persisted `activeView: "agents"`     | Restore Agents, not Workspace.                                                                            |
| Stale/unknown conversation deep link | Keep the current view and show a non-destructive stale result; create nothing.                            |
| Conversation link from another view  | Select conversation and navigate to Agents.                                                               |
| Existing Workspace conversation pane | Continue rendering in Workspace.                                                                          |
| Close Agents conversation            | Clear selection or return to launcher/list; do not delete or detach anything.                             |
| Delete conversation                  | Confirm, terminate/clean through existing lifecycle, remove all dangling pane references via existing GC. |

## Workspace creation contract

### New default

New Workspace creation exposes only terminal-backed sessions:

1. PacketCode, first when detected;
2. Claude Code;
3. Codex CLI;
4. Gemini CLI;
5. OpenCode;
6. plain terminal;
7. configured custom CLI clients.

The UI uses **Add Session** or **Add CLI**, never a generic **Add Agent** label
for this operation.

### Templates

Existing CLI layout templates remain useful but their names/descriptions must
describe terminal sessions rather than GUI-agent conversations. PacketCode
becomes the recommended one-pane default when available. A missing PacketCode
installation must expose the existing detect/install/path-repair flow rather
than silently selecting a different product.

### Existing data

No migration rewrites a saved Workspace merely because it contains a
conversation pane. New defaults and existing-data compatibility are separate
policies.

## Handoff contract

Every action must declare whether it changes presentation, execution ownership,
or both.

| Action                               | Presentation change                | Execution ownership change                    | Required invariant                                                          |
| ------------------------------------ | ---------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| Workspace → Delegate to Agent        | Opens Agents                       | New agent conversation becomes its own owner  | Source project/selection is copied only through an explicit launch payload. |
| Agents → Open project in Workspace   | Opens/focuses Workspace            | None                                          | Conversation keeps running and remains selected in Agents state.            |
| Agents → Attach terminal             | Opens PTY for project/worktree     | PTY owns only its terminal process            | Conversation and PTY remain separately addressable.                         |
| Agents → Open Git ending             | Opens authoritative ending surface | None until user chooses merge/PR/discard/keep | One worktree state, never a copied Git flow.                                |
| Agents → Add to Flight               | Opens/links Flight                 | Flight gains a reference, not a duplicate     | Bidirectional Flight/session links remain synchronized.                     |
| Flight → Keep running in PacketAgent | PacketAgent status becomes visible | Explicit W9 deploy/activate handoff           | PacketAgent identity/evidence remains authoritative after activation.       |
| Agent/Flight → Send to Monitor       | Opens read-only projection         | None                                          | Monitor cannot approve, edit, or persist interactive state.                 |

## Compatibility and migration rules

1. Do not delete `ConversationTile`, pane schema support, or pane hydration in
   WA1–WA3.
2. Do not rewrite existing Workspace records on load solely to detach
   conversations.
3. Preserve one-directional `pane → conversationId` references.
4. Keep conversation deletion GC so dangling panes disappear safely.
5. Create no new wrapper Workspace or conversation pane through any route.
6. Test data saved by the previous release and data re-saved by an older binary.
7. Keep read/close/GC compatibility while retiring wrapper, draft, and
   attachment producers.

## Local dogfood evidence

The historical WA4 observation recorded content-free local counters only:

- conversation starts in Agents;
- Agents ↔ Workspace handoffs;
- simultaneous visible conversations;
- `needs_you` notification-to-open time;
- single- versus multi-monitor usage;
- compatibility-pane load failures.

Do not record prompt text, transcript text, file content, diffs, secrets,
repository URLs, raw paths, or tool arguments.

## Detachable-window gate

No interactive native Agents window is part of WA1–WA4.

WA5 begins only after one state contract is selected and proven:

- main-window single owner with command-routed projections; or
- backend-authoritative revisioned state with subscriber WebViews.

Required evidence before interactivity:

- one event is processed once across two windows;
- one approval can be answered once;
- stale drafts cannot overwrite newer drafts;
- conversation persistence rejects stale revisions;
- closing either window does not terminate the owned conversation incorrectly;
- review and Git ending remain authoritative;
- capability policy prevents a projection from exceeding its role.

## Implementation slices and proof

### WA1A — route restoration

- Add `"agents"` to `CoreView`.
- Make `normalizeView("agents")` preserve Agents.
- Add Agents to `LeftRail`.
- Render a lazy same-window `AgentsView`.
- Keep Workspace mounted only for PTY continuity; Agents renders conditionally.
- Add app-store, rail, hotkey, and view-routing tests.

### WA1B — agent-first surface

- Restore/adapt the conversation-only sidebar from Git history.
- Reuse the current launch `Composer`, `AgentChatPane`, and inspector.
- Ensure New Agent creates no Workspace or pane.
- Keep archive/delete/pin/search/needs-you behavior.
- Add selection, launch, close, archive, and approval-navigation tests.

### WA1C — default deep-link cutover

- Add `openConversationInAgents()`.
- Retarget all inventoried default callers.
- Prove normal navigation creates zero Workspaces and zero panes.
- Prove no attachment/materialization producer remains and old panes still
  render.

### WA2 — CLI-first Workspace

- Split Chat creation out of `AddAgentPicker`.
- Rename Workspace affordances and empty states.
- Put PacketCode first with detect/install/path repair.
- Update templates and Ctrl/Cmd+N behavior deliberately.
- Prove Workspace creation exposes no new GUI-agent creation path.

### WA3 — handoffs

- Implement each action in the handoff table with typed result/error states.
- Freeze the PacketAgent payload contract.
- Add identity, authority, local/SSH, restart, and stale-target tests.

### WA4 — migration/owner decision

- Run fixture migrations across saved-layout generations.
- Preserve the honest initial content-free sample.
- Apply the owner's final decision to retire new attachments.
- Delete producer/materializer machinery while preserving old-pane
  compatibility.

## WA1 implementation evidence — 2026-07-29

| Slice         | Result                               | Evidence                                                                                                                                                                      |
| ------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WA1A          | Implemented                          | `agents` is restored in `CoreView`, Left Rail, status labels, lazy app routing, persistence normalization, and `Ctrl+Shift+1`.                                                |
| WA1B          | Implemented; manual UX sign-off open | `AgentsView` composes `AgentSidebar`, the existing launch `Composer`, `AgentChatPane`, and `AgentInspectorPane`; launch omits `onLaunched`, so no Workspace placement occurs. |
| WA1C          | Implemented                          | All inventoried ordinary callers use `openConversationInAgents()`; no attachment/materialization API remains; FleetSidebar passes `includeVirtualConversations: false`.       |
| Compatibility | Preserved                            | Existing conversation panes remain valid Workspace panes and are covered by projection/integration tests.                                                                     |

Automated proof:

- focused boundary suite: 11 test files, 59 tests;
- full frontend suite: 161 test files, 1,229 tests;
- targeted ESLint: pass;
- `pnpm build`: pass (existing Vite chunk warnings only).

WA2 and WA3 are now source-implemented. Their current evidence is recorded in
the parent goal and
[`workspace-agents-wa3-handoff-evidence.md`](./workspace-agents-wa3-handoff-evidence.md).
WA4 is complete by explicit owner decision: new attachments are retired and
saved panes remain compatible. No detachable interactive window was added.

## WA0 exit evidence

WA0 is complete when:

- the current entry points and persistence carriers are inventoried;
- every existing path has a target owner;
- default navigation and project handoffs have different named APIs;
- the compatibility and no-cloning invariants are written;
- the handoff authority boundaries are written;
- the detachable-window gate is explicit;
- WA1–WA4 have testable slices;
- `ROADMAP.md`, `backlog.md`, and `dev/README.md` point to this contract.

No application behavior changes are required to close WA0.
