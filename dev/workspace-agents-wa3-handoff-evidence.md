# WA3 — Workspace/Agents Handoff Implementation Evidence

Status: **SOURCE COMPLETE — MANUAL UX / LIVE EXTERNAL-RUNTIME PROOF OPEN**

Date: 2026-07-29

Parent goal:
[`workspace-agents-restructuring-goal.md`](./workspace-agents-restructuring-goal.md)

Locked contract:
[`workspace-agents-wa0-route-contract.md`](./workspace-agents-wa0-route-contract.md)

## Result

PacketADE now has explicit transitions between Workspace, Agents, Flight Deck,
PacketCode, PacketAgent, Git endings, and Monitor. Presentation changes reuse
the original IDs. No handoff clones a conversation, transcript, approval
queue, review record, Flight attempt, or worktree.

`src/lib/agentHandoffs.ts` is the typed handoff boundary. It returns explicit
success/error results for stale conversations, removed Workspaces or Flights,
missing PacketCode, and unavailable SSH targets.

## Action matrix

| Source → destination       | Live action                                       | Identity / authority behavior                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace → Agents         | Workspace header **Delegate**                     | Opens the new-agent launcher with the same local path or encoded SSH server/path. It creates no conversation until the user sends.                                                                                         |
| Agents → Workspace project | **Open project in Workspace**                     | Reuses an active matching local/SSH Workspace or creates a CLI-first one. The conversation remains selected and unattached.                                                                                                |
| Agents → terminal          | **Attach terminal**                               | Adds a separate plain-shell pane on the exact project/worktree. The PTY does not own or replace the conversation.                                                                                                          |
| Agents → PacketCode        | **Continue in PacketCode…**                       | Requires a user-entered objective, shows the exact local/SSH/worktree target, accepts an explicit reference allowlist, copies a bounded v1 JSON payload, and opens/focuses one PacketCode pane. No automatic paste occurs. |
| Agents → Git ending        | **Open Git ending** / **Finish → Commit…**        | Opens the matching CLI-first project Workspace and scopes its existing `GitDashboard` / `WorktreeLifecycleBar` by Workspace ID without attaching the conversation. Merge/PR/discard/keep remains explicit.                 |
| Agents → Flight Deck       | **Add to Flight…**                                | Adds one idempotent `Flight.linkedSessionIds` reference and opens the selected Flight. Conversation state stays agent-owned.                                                                                               |
| Flight attempt → Workspace | Attempt **Open in Workspace**                     | Opens or reuses the exact local/SSH/worktree project as a CLI-first Workspace. The attempt conversation remains in Agents/Flight Deck and no pane is attached.                                                             |
| Flight → PacketAgent       | Existing **Deploy / Keep running / Inspect** card | Uses the frozen W9 worker package; PacketAgent becomes execution owner only after explicit deploy/activate. Live close/restart proof remains gated on a configured PacketAgent runtime.                                    |
| Agent / Flight → Monitor   | **Send to Monitor** / attempt **Monitor**         | Opens a read-only projection. Returning an Agent monitor to the main window now routes to Agents, not Workspace.                                                                                                           |

## PacketCode v1 payload

The copied payload is headed `packetade-packetcode-handoff/v1` and contains:

- source conversation ID, visible title, and update timestamp;
- exact local or SSH target and active worktree identity;
- the objective typed in the confirmation modal;
- only the file/reference strings explicitly entered in that modal;
- source permission mode, write-approval flag, enabled MCP IDs, and the frozen
  MCP trust snapshot when present;
- explicit `false` markers for transcript, secret, hidden-reasoning, and
  authority transfer.

It intentionally contains no messages, tool inputs/outputs, file contents,
diffs, credential values, or inferred references. PacketCode opens separately
and the user pastes the visible payload. That keeps the first contract
reviewable while a future direct PacketCode ingestion protocol is designed.

## Target selection

- Local paths are normalized without treating POSIX paths as
  case-insensitive.
- SSH matching requires the same canonical `ServerConfig.id` and exact remote
  path.
- An active conversation worktree is the target instead of its base checkout.
- Existing compatibility wrapper Workspaces are not selected as the normal
  project Workspace.
- PacketCode never silently falls back to another CLI. Missing local
  PacketCode opens its typed install/locate Settings target; a missing remote
  install returns a server-specific error.
- A removed SSH server produces a typed error and no local fallback Workspace.

## Restart and compatibility behavior

The handoffs reuse persisted `conversationId`, `Workspace.id`, `Flight.id`,
`Attempt.sessionId`, and worktree fields. No new transient router owns those
records. After restart, ordinary conversation links still open Agents, saved
compatibility panes still resolve their conversation references, Flight links
still resolve through `linkedSessionIds`, and Monitor holds only its read-only
route lease.

The owner subsequently retired creation of new Workspace attachments. WA3
keeps `ConversationTile`, wrapper normalization, conversation-pane
persistence, and deletion GC only for previously saved layouts.

## Automated proof

Focused tests cover:

- PacketCode-first project Workspace creation without attachment;
- exact SSH/worktree preservation and removed-server failure;
- separate terminal and PacketCode panes;
- PacketCode unavailable behavior;
- payload allowlist, permission snapshot, and forbidden-content markers;
- stale conversation behavior;
- Git-ending and Flight-attempt project routing without attachment;
- remote Workspace delegation;
- idempotent Flight linking;
- Monitor return routing;
- real menu reachability, Workspace Delegate UI, and ReviewBar Git routing.

Production TypeScript/Vite build and repository lint pass. The final source
checkpoint passes all **165 frontend test files / 1,255 tests**, including WA4
migration and evidence-boundary coverage.

## Remaining gates

1. Manually exercise local and SSH handoffs in the packaged app.
2. Exercise PacketCode paste/launch with a published PacketCode build.
3. Run the configured live PacketAgent close/restart/evidence proof.

Detachable interactive Agent windows remain out of scope until WA5 establishes
a safe single-writer contract.
