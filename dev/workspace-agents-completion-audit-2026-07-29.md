# Workspace/Agents Completion Audit — 2026-07-29

Status: **COMPLETE — FINAL OWNER POLICY VERIFIED**

Parent goal:
[`workspace-agents-restructuring-goal.md`](./workspace-agents-restructuring-goal.md)

Final attachment record:
[`workspace-agents-wa4-dogfood-gate.md`](./workspace-agents-wa4-dogfood-gate.md)

## Bottom line

The approved product structure is present in source:

- Agents is the first-class same-window home for new GUI/API-agent work.
- Workspace is CLI/PTY-first and recommends PacketCode when detected.
- Normal navigation opens Agents and creates no wrapper Workspace or pane.
- The owner explicitly retired **Open alongside Workspace** and every API that
  could create a new conversation pane.
- Git-ending and Flight-attempt handoffs open the exact CLI-first project
  Workspace without attaching the conversation.
- Existing saved conversation panes still hydrate, render, close, and
  garbage-collect safely.
- Cold-start hydration mounts no hidden xterm mosaic and launches no hidden
  PTY.
- Monitor is a Rust-restricted, repeatable read-only projection.
- No detachable interactive Agents window exists; WA5 still requires a safe
  single-writer state contract.

## Requirement audit

| North-star requirement                        | Result                                   | Direct evidence                                                                                                                                                          |
| --------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First-class same-window Agents                | **Pass**                                 | `agents` is a persisted route and `AgentsView` owns launch, selection, chat, approvals, review, and inspector.                                                           |
| GUI-agent creation belongs to Agents          | **Pass**                                 | `AgentsView` launches headless conversations; Workspace imports no GUI-agent launcher or provider catalog.                                                               |
| CLI/PacketCode-first Workspace                | **Pass in source and local runtime**     | Workspace creation/Add Session expose only PacketCode, coding CLIs, and terminal; missing PacketCode routes to typed Settings recovery.                                  |
| New Workspace attachment removed              | **Pass**                                 | No `Open alongside` action, attachment handoff, wrapper materializer, conversation-pane insertion API, or draft tile remains. The architecture test rejects regressions. |
| Existing conversation-pane compatibility      | **Pass locally**                         | Old layout fixtures and real saved state preserve `conversationId` references; `ConversationTile`, normalization, deletion GC, and orphan reconciliation remain.         |
| Required cross-surface handoffs               | **Source pass; external proof partial**  | Typed project/terminal/PacketCode/Git/Flight/PacketAgent/Monitor handoffs preserve local/SSH/worktree identity without cloning conversation state.                       |
| Safe startup hydration                        | **Pass locally and in packaged Windows** | Conversation hydration precedes reconciliation; stale PTY IDs clear; only a selected visible Workspace starts panes; navigation preserves live PTYs.                     |
| No unsafe detachable interactive Agent window | **Pass**                                 | The only secondary product WebView is Monitor; Rust denies all unreviewed non-main commands and Monitor uses an exact read-only allowlist.                               |
| Final Workspace attachment policy             | **Pass by explicit owner decision**      | The owner retired new attachments after reviewing the product split. The incomplete observation sample is preserved but is not misrepresented as the reason.             |

## Preservation guardrails

`scripts/workspace-agents-boundaries.test.mjs` fails the normal frontend suite
if:

- a production Workspace surface launches a GUI agent;
- `openSession`, `addConversationPane`, `ensureConversationWorkspace`,
  `attachConversationToWorkspace`, `openConversationAlongsideWorkspace`, or
  `DraftTile` reappears;
- the saved-pane renderer or deletion GC disappears;
- a secondary native window is introduced outside the reviewed Monitor path;
- Monitor loses its awaited read-only refresh or gains shell, filesystem, or
  process plugin capability.

## Startup and hydration evidence

The isolated Windows release gate used the real saved three-Workspace state:

1. Welcome hydrated metadata with zero PTYs and without loading Workspace/xterm
   chunks.
2. Persisted terminal IDs normalized to `null`.
3. Conversation hydration completed before `initialized` enabled
   reconciliation.
4. Opening Agents launched no CLI.
5. Opening Workspace launched nothing until an actual Workspace was selected.
6. Selecting SideStep launched exactly its saved Claude and Codex panes.
7. Workspace → Agents → Workspace retained the same live PTY IDs.
8. Closing PacketADE reaped both child CLIs.

Monitor now uses a separate repeatable read-only snapshot instead of the
main-renderer one-shot hydration function. Consecutive polls replace state
atomically, failed polls retain the previous snapshot, and Monitor cannot save
auto-archive changes.

## Owner decision versus historical sample

The historical local sample contained roughly two hours, zero genuine Agent
starts/handoffs, five clean migration audits, five compatibility loads, and no
missing/orphan/failure evidence.

That sample was below the planned seven-day/10-start/10-handoff recommendation
threshold. The owner explicitly superseded the wait after deciding the hybrid
Workspace conversation-pane workflow was not wanted. No events were
manufactured.

## External-runtime matrix

| Gate                                                   | Result          | Reason                                                                                                                       |
| ------------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Local Windows hydration and Claude/Codex PTY lifecycle | **Pass**        | Packaged app starts only selected panes, preserves IDs across navigation, resolves `codex.cmd`, and reaps children on close. |
| SSH Workspace/handoff runtime                          | **Unavailable** | No configured `ServerConfig`; source and fixture tests preserve exact server/worktree identity.                              |
| Published PacketCode paste/launch                      | **Unavailable** | No PacketCode executable is installed in a declared location; missing-install recovery is test-covered.                      |
| PacketAgent source contract                            | **Pass**        | PacketADE and PacketAgent W9 fixture contracts agree.                                                                        |
| Credentialed PacketAgent close/restart interop         | **Unavailable** | No PacketAgent base URL, token, Workspace ID, or listener is configured.                                                     |

These environment-gated proofs remain backlog/release work; they do not change
the completed Workspace/Agents ownership decision.

## Final verification checkpoint

The complete post-decision gate passed on 2026-07-29:

- Vitest: **165 files / 1,255 tests passed**;
- Rust library: **430 passed / 0 failed / 2 ignored**;
- TypeScript and Vite production build: passed;
- ESLint: passed with zero errors and nine pre-existing Fast Refresh warnings;
- Prettier, `git diff --check`, `cargo check`, and `cargo fmt --check`: passed;
- the normal suite's Workspace/Agents architecture scan passed, proving no
  production attachment producer or unreviewed secondary-window path remains.

The Workspace/Agents restructuring goal is complete. Packaged SSH, published
PacketCode, configured PacketAgent, and a future detachable interactive Agents
window remain explicitly separate release or follow-on gates.
