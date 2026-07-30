# Main App Navigation, Buttons, and Right-Panel Audit

Date: 2026-07-29

Status: **REVIEW COMPLETE — DECISIONS MADE 2026-07-30; IMPLEMENTATION OPEN (MS1–MS4)**

Scope: PacketADE's main application shell, not the Settings information
architecture

## Executive verdict

PacketADE's primary Left Rail routes are real and the core navigation is
functional. The main weakness is not a collection of dead pages. It is that
navigation metadata and right-side panel state are owned in several different
places, so they drift, compete for width, or carry stale local/conversation
context across surfaces.

The three most important conclusions are:

1. **Workspace can show an unrelated Agent inspector.** A conversation selected
   in Agents remains global and causes `App` to mount `AgentInspectorPane`
   beside a CLI-first Workspace.
2. **The Agent right panel has split ownership.** Preview open/close state,
   selected inspector tab, conversation identity, file selection, and review
   presentation are not governed by one controller.
3. **Local and SSH context are not consistently separated.** Several shell,
   Preview, Diff, Git, and handoff actions either show stale local state or call
   local-only filesystem operations for an SSH conversation.

This audit is a source and test review. It did not change product behavior.

## Recommended shell responsibility map

| Shell area      | Recommended responsibility                                                                 |
| --------------- | ------------------------------------------------------------------------------------------ |
| Title bar       | PacketADE identity and native window controls                                               |
| Primary rail    | Workspaces, Agents, Flight Deck, Issues, Memory, Git Hosts; Settings anchored at the bottom |
| Global toolbar  | Command palette, truthful global New menu, operational status, Agents, spend, project scope |
| Surface sidebar | Workspace list, Agent conversations, or Flights—never mixed ownership                       |
| Main canvas     | Active terminal, chat, board, list, or detail surface                                       |
| Right dock      | One surface-owned Inspector, Editor, Git, Preview, Review, or Files presentation at a time  |
| Status strip    | Active-surface context, relevant project/branch, dictation, and infrastructure health        |

## P0 findings — correctness and safety

### 1. Workspace mounts a stale global Agent inspector

`App` mounts `AgentInspectorPane` whenever Workspace is active and a global
`selectedConversationId` exists. It does not prove that the conversation is a
saved pane in the active Workspace. After moving from Agents to Workspace, an
unrelated Agent rail can therefore squeeze the CLI workroom.

Evidence:

- `src/App.tsx:275-285`
- `src/App.tsx:337-340`
- `src/components/views/AgentsView.tsx:148-155`

Recommendation: remove the App-level Workspace inspector. If old saved
conversation panes need an inspector, open it only from an explicitly focused
saved pane in that Workspace.

### 2. Right-side panels have no shared width or ownership arbitration

Workspace may render its 480px Editor and 280px Git panel together. `App` can
then add a 280–720px Agent inspector outside Workspace. Combined with the 240px
Workspace sidebar and 44px primary rail, these widths exceed PacketADE's
supported 800px minimum window before the terminal canvas receives meaningful
space.

Evidence:

- `src/components/views/WorkspaceView.tsx:209-313`
- `src/components/workspace/FleetSidebar.tsx:374`
- `src/components/agents/AgentInspectorPane.tsx:49-52`
- `src/components/agents/AgentInspectorPane.tsx:146-203`
- `src-tauri/tauri.conf.json:23`

Recommendation: introduce one surface-scoped `RightDock` owner with mutually
exclusive modes, one resizer, available-width clamping, and automatic collapse
below a minimum center width.

### 3. Preview ownership is global and internally inconsistent

`previewPaneStore` contains no conversation ID. A relative Markdown path opened
for conversation A can therefore be resolved against conversation B's project
after selection changes.

The header action toggles `previewPaneStore.open`, but the inspector observes
only the false-to-true edge. Choosing **Hide preview pane** sets `open` false
without changing the visible Preview tab. Closing embedded Preview changes the
local inspector tab without closing the global store. A later Markdown open can
update invisibly because `open` was never reset correctly.

Evidence:

- `src/stores/previewPaneStore.ts:5-39`
- `src/components/agents/chat/HeaderOverflowMenu.tsx:224-232`
- `src/components/agents/AgentInspectorPane.tsx:87-97`
- `src/components/agents/AgentInspectorPane.tsx:291-296`
- `src/components/agents/AgentPreviewPane.tsx:51-59`

Recommendation: use one conversation-scoped dock record containing
`{ conversationId, expanded, activeTab, previewTarget }`.

### 4. SSH conversations expose local-only Inspector operations

The Files tab correctly admits that SSH is unsupported. Preview does not: it
calls local `readFileContents` without an SSH target. Applied-file Review reads
and Undo writes are also local-only, while the Inspector still exposes them for
SSH API conversations. Aggregate diff failures silently become zero-line
counts.

Plan's **Hand off to Codex** explicitly sets `sshTarget: null`, losing the
remote execution identity.

Evidence:

- `src/components/agents/AgentFilePane.tsx:281-294`
- `src/components/agents/AgentPreviewPane.tsx:66-99`
- `src/components/agents/review/ReviewSurface.tsx:518`
- `src/components/agents/review/ReviewSurface.tsx:553-572`
- `src/lib/aggregateConversationDiffs.ts:59-61`
- `src/lib/aggregateConversationDiffs.ts:82-103`
- `src/components/agents/PlanPanel.tsx:229-257`

Recommendation: disable these disk-backed actions for SSH immediately or
implement a single remote-aware file contract before exposing them.

## P1 findings — product behavior and wiring

### 5. Files advertises a Preview path that is not wired

File rows call an optional `onSelectFile`, but `AgentInspectorPane` does not
provide it. Preview nevertheless tells the user to open Markdown from Files.
File clicks currently fall back to copying a path.

Evidence:

- `src/components/agents/AgentFilePane.tsx:221-238`
- `src/components/agents/AgentInspectorPane.tsx:310-315`
- `src/components/agents/AgentPreviewPane.tsx:163-170`

Resolution: folded into decision 5 by the 2026-07-30 amendment — the wired
Markdown viewer in the reconnected `RightDock` Editor panel resolves this
finding; it closes with the D5 implementation.

### 6. Plan and Changes each have competing presentations

Plan appears above chat, in the Inspector Plan tab, and again inside Preview.
The two `PlanPanel` mounts have independent local collapsed state, and the
Inspector Plan tab can be blank when no plan exists.

Changes opens a transcript-covering overlay while the Inspector contains a
second `ReviewSurface` in its Diff tab.

Evidence:

- `src/components/agents/AgentChatPane.tsx:306-309`
- `src/components/agents/AgentChatPane.tsx:362-370`
- `src/components/agents/AgentInspectorPane.tsx:286-300`
- `src/components/agents/AgentPreviewPane.tsx:193-205`
- `src/components/agents/DiffPaneTrigger.tsx:22`

Recommendation: make Plan and Review authoritative in the right dock. Keep only
compact summaries or triggers in chat.

### 7. The Workspace Editor panel is unreachable

`editorStore.openFile` has no production caller outside its declaration and
tests. The shell still carries a full 480px Editor pane. If it is reconnected,
its local dirty buffer can be discarded without confirmation when the pane,
tab, or Workspace changes.

Evidence:

- `src/stores/editorStore.ts:22-35`
- `src/components/views/WorkspaceView.tsx:58-64`
- `src/components/views/WorkspaceView.tsx:251-294`
- `src/components/editor/EditorPane.tsx:16-63`

Recommendation: either remove the unreachable pane or promote it into the
shared dock with real open-file producers and dirty-buffer protection.

### 8. Shell project context can lie for SSH Workspaces

Switching to an SSH Workspace intentionally preserves the old local
`layoutStore.projectPath`. The Status Strip and `useGitInfo` continue showing
and polling that local path. The toolbar folder picker can also overwrite the
local fallback while the remote Workspace is active.

Evidence:

- `src/stores/layoutStore.ts:45-90`
- `src/stores/layoutStore.ts:170-176`
- `src/components/layout/Toolbar.tsx:86-108`
- `src/components/layout/StatusStrip.tsx:95-121`
- `src/hooks/useGitInfo.ts:7-45`

Recommendation: derive shell context from a typed local-or-SSH target owned by
the active surface. Disable the local folder picker for SSH until it has a
server-aware action.

### 9. Main navigation metadata is duplicated and drifting

Left Rail, Status Strip, command palette, hotkeys, and module registration
maintain separate route lists. The command palette omits Agents, Flight Deck,
Costs, and canonical Dictation. Dictation exists as both core `"dictation"` and
module `"mod:dictation"`, producing inconsistent highlighting and status text.

Evidence:

- `src/components/layout/LeftRail.tsx:12-65`
- `src/components/layout/StatusStrip.tsx:9-20`
- `src/components/common/CommandPalette.tsx:38-117`
- `src/lib/viewHotkeys.ts:16`
- `src/modules/dictation.ts:11-20`

Recommendation: create one route registry containing label, icon, aliases,
shortcut, placement, and enabled predicate.

### 10. Creation labels do not match their actions

The global New button claims it creates a session, Flight, or Issue, but its
menu contains only Flight and Issue. Fleet's **New session** creates an empty
Workspace. Ctrl/Cmd+N outside Agents also creates a Workspace named **New
Session**.

Evidence:

- `src/components/layout/Toolbar.tsx:148-177`
- `src/components/workspace/FleetSidebar.tsx:101-106`
- `src/components/workspace/FleetSidebar.tsx:395-401`
- `src/hooks/useAgentTabHoists.ts:37-53`

Recommendation: make New a truthful creation hub for Workspace, CLI Session,
Agent, Flight, and Issue. Rename Fleet's action **New Workspace** unless it is
changed to add a session to the active Workspace.

### 11. Git-host capability gating is incomplete

The capability catalog says Gitea lacks GitHub check runs, AI assist, and draft
toggling. `GitHubView` currently uses capabilities primarily for Activity.
Checks, AI actions, and draft controls can remain visible even though the
backend rejects unsupported Gitea operations.

Repository or host switches also do not reliably clear selected PR/detail and
diff state.

Evidence:

- `src/lib/git-hosts.ts:42-70`
- `src/components/views/GitHubView.tsx:169-174`
- `src/components/views/GitHubView.tsx:426`
- `src/components/views/GitHubView.tsx:497-615`
- `src/components/views/github/PRActionBar.tsx:128-145`
- `src/stores/githubStore.ts:539-550`
- `src-tauri/src/commands/github.rs:2993`

### 12. Several operational indicators can report false success

- **Running Agents → Stop** marks the conversation idle before backend
  cancellation succeeds; failure is only logged.
- **Today's spend** sums every hydrated API conversation without filtering by
  day or archive state.
- **Commit after review** checks the commit message and staged files, but not
  pending Flight review/approval state.
- Flight-level **Send to Monitor** drops failures without user feedback.

Evidence:

- `src/stores/agentTaskStore.ts:985-1014`
- `src/components/layout/LiveSpendChip.tsx:61-89`
- `src/components/workspace/GitDashboard.tsx:400-418`
- `src/components/workspace/GitDashboard.tsx:697-719`
- `src/components/views/FlightsView.tsx:692-697`

### 13. Side chat requests are not isolated

Closing Side Chat removes frontend listeners but does not cancel its backend
stream. Reopening and asking again uses the same unscoped event names, so a
prior request can append to or complete the new answer.

Evidence:

- `src/stores/sideChatStore.ts:37-55`
- `src/stores/sideChatStore.ts:81-124`
- `src/lib/events.ts:21-25`
- `src-tauri/src/commands/side_chat.rs:113-178`

Recommendation: add request IDs to events and a cancellation command.

## P2 findings — clarity, alignment, and accessibility

- Rename shell **GitHub** to **Git Hosts** so navigation matches
  GitHub/Gitea/Forgejo behavior.
- Status Strip calls Settings **Tools**, while the rail calls it Settings and
  the toolbar uses Tools for optional modules.
- Replace toolbar **VT** with **Dictation** or a clear microphone state.
- Rename **Attach terminal** to **Open terminal in Workspace**.
- Rename **Continue in CLI** to **Copy CLI launch command**; it copies a command
  and does not transfer conversation state.
- Rename **Open Git ending** to user-facing completion language such as
  **Finish work…**.
- The Agent header requires one ellipsis to reveal a second ellipsis. Use one
  responsive overflow menu.
- Workspace selection is duplicated between the Fleet sidebar and horizontal
  tabs.
- Side Chat and pinned approvals occupy the same bottom-right region; Side Chat
  can cover the approval banner.
- Left Rail and native window controls rely on `title` instead of explicit
  `aria-label`; the rail lacks `aria-current` and a navigation landmark.
- Toolbar dropdowns lack `aria-expanded`, menu roles, keyboard traversal, and
  Escape handling.
- Several visual tabs lack `tablist`/`tab` semantics.
- Toolbar and fixed sidebars have no responsive overflow strategy at the
  supported minimum width.

## Right-panel wiring matrix

| Feature                        | Verdict                   | Notes                                                                 |
| ------------------------------ | ------------------------- | --------------------------------------------------------------------- |
| Inspector Overview             | Wired                     | Conversation metadata and aggregate change summary render             |
| Inspector collapse/resize      | Wired and tested          | Pointer and keyboard resize clamp and persist                         |
| Plan                           | Wired but duplicated      | Multiple mounts; blank Inspector state before a plan                  |
| Preview                        | Partially broken          | Hide/close ownership, conversation scope, and SSH filesystem are wrong |
| Diff/Review                    | Wired but duplicated      | Overlay and Inspector compete; applied SSH file operations unsafe     |
| Files                          | Partially wired           | Local browse works; file-to-Preview callback absent; SSH blocked       |
| Workspace Git                 | Local/remote aware        | Fixed width and can compete with Editor/Inspector                     |
| Workspace Editor              | Production-unreachable    | No `openFile` producer; dirty close protection absent                 |
| Monitor                        | Wired, explicitly read-only | Agent and Flight routes reach the Rust-leased secondary window      |

## What should be preserved

- Six primary product modes in the Left Rail.
- Workspace PTY keep-alive across navigation.
- Surface-owned sidebars for Workspaces and Agent conversations.
- Running Agents tray and needs-you prioritization.
- Spend HUD as a concept, after its accounting boundary is corrected.
- Typed PacketCode Settings recovery.
- Git-host capability metadata, after all consumers honor it.
- Inspector compact rail, collapse, and accessible resize behavior.
- Read-only Monitor as an explicit overflow destination.
- The shared Agent conversation engine and existing approval/review contracts.

## Recommended implementation sequence

### MS1 — correctness boundaries

1. Remove the unscoped Workspace Agent inspector.
2. Gate local-only Inspector and handoff actions for SSH.
3. Make Preview state conversation-scoped and make Hide/Close authoritative.
4. Add cancellation acknowledgment for Running Agents and Side Chat.
5. Clear repository/PR detail state across repo and host switches.

### MS2 — one right dock

1. Introduce a surface-scoped `RightDock` controller.
2. Make Inspector, Git, and Editor mutually exclusive owners.
3. Add one shared resizer and minimum-center-width collapse.
4. Route Files → Markdown Preview and Changes → Review through the dock.
5. Reconnect the lightweight Editor as a first-class dock panel (decided
   2026-07-30): wire `editorStore.openFile` production callers and protect
   dirty buffers. Per the same-day D5 amendment, the panel must also open and
   preview Markdown (`.md`) files, resolving finding P1-5.

### MS3 — one navigation registry

1. Define route label/icon/shortcut/placement metadata once.
2. Generate Left Rail, command palette, Status Strip labels, and hotkeys from it.
3. Collapse Dictation to one route identity.
4. Make the global New menu truthful.
5. Rename GitHub shell language to Git Hosts and correct action labels.

### MS4 — product polish and proof

1. Add responsive and accessibility semantics.
2. Add remote/local context tests.
3. Add right-dock ownership and minimum-width tests.
4. Add Gitea capability and repo-switch tests.
5. Run a packaged local/SSH and 800px-to-ultrawide visual matrix.

## Decisions requested from the owner

All five decisions were made by the owner on 2026-07-30.

1. Remove the Workspace-level Agent inspector now, keeping Inspector owned by
   Agents. **Recommended: yes.**
   — **DECIDED 2026-07-30: YES.** Remove the Workspace-level Agent inspector;
   Inspector is owned solely by the Agents view (resolves P0-1).
2. Replace independent right panels with one `RightDock`. **Recommended: yes.**
   — **DECIDED 2026-07-30: YES.** Build one `RightDock` controller owning
   width/stacking/visibility of all right-side panels (resolves P0-2, helps
   P0-3).
3. Disable unsupported SSH Preview/Diff/Editor actions before adding full remote
   parity. **Recommended: yes.**
   — **DECIDED 2026-07-30: YES.** Gate/disable local-only actions (Preview,
   applied-Review, Undo, Plan handoff, diff) on SSH conversations now; full
   remote parity later (resolves P0-4).
4. Make one route registry own rail, palette, labels, and hotkeys.
   **Recommended: yes.**
   — **DECIDED 2026-07-30: YES.** A single route registry owns the left rail,
   command palette, labels, and hotkeys (resolves UX-14/P1-9; enables the
   creation-label fixes).
5. Reconnect the lightweight Editor through the dock or remove its unreachable
   shell. **Decision required after reviewing PacketCode/editor positioning.**
   — **DECIDED 2026-07-30: RECONNECT.** The lightweight Editor becomes a
   first-class `RightDock` panel: wire `editorStore.openFile` production
   callers and protect dirty buffers. In-app quick editing IS part of
   PacketADE's positioning. This folds into decision 2's `RightDock` scope and
   lands inside the MS2 milestone.
   — **AMENDED 2026-07-30 (same day):** D5's scope explicitly includes a wired
   Markdown viewer — the reconnected `RightDock` Editor panel must open and
   preview `.md` files, resolving finding P1-5 (Files advertises a
   Markdown-Preview path that is not wired; `onSelectFile` not provided by
   `AgentInspectorPane`).

## Evidence limits

High confidence:

- source-level routing and handler wiring;
- store ownership and missing production consumers;
- local-only versus SSH-aware command boundaries;
- fixed-width conflicts at the declared minimum window size.

Still requires packaged proof:

- precise visual behavior across Windows/macOS/Linux WebViews;
- live SSH error presentation;
- behavior with real GitHub and Gitea accounts;
- native keyboard and screen-reader behavior.
