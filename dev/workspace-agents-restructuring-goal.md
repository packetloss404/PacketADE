# Workspace/Agents Restructuring — Current Product Goal

Status: **COMPLETE — FINAL OWNER DECISION APPLIED**

Approved direction: 2026-07-29

Final Workspace-attachment decision: 2026-07-29

Canonical evidence:
[`workspace-agent-settings-decision-2026-07-29.md`](./workspace-agent-settings-decision-2026-07-29.md)

Implementation contract:
[`workspace-agents-wa0-route-contract.md`](./workspace-agents-wa0-route-contract.md)

> [!IMPORTANT]
> Make new PacketADE Workspaces CLI/PacketCode-first. Move new GUI-agent
> creation into a first-class Agents surface in the existing main window.
> Preserve existing conversation-pane compatibility during the transition.
> Connect the surfaces with explicit handoffs. Do not build an interactive
> detachable Agents window until agent state has a safe single-writer contract.

## Implementation checkpoint — 2026-07-29

- **WA0 is complete and locked.**
- **WA1A route restoration is implemented:** `agents` is a persisted
  same-window route with Left Rail, status-strip, and keyboard navigation.
- **WA1B agent-first surface is implemented:** Agents owns a cross-project
  conversation sidebar, launcher, active chat, and inspector. A new launch uses
  the headless conversation path and does not create a Workspace or pane.
- **WA1C deep-link cutover is implemented:** ordinary conversation links open
  Agents; Workspace no longer projects unplaced conversations as virtual rows,
  and no production or store API can create a new conversation pane.
- **Compatibility remains intact:** previously placed conversation panes still
  render and contribute to their owning Workspace row, but closing one is
  permanent placement removal.
- **WA2 is source-complete:** Workspace creation and Add Session are CLI-only;
  detected PacketCode is recommended/default; missing PacketCode opens its
  typed Settings recovery target; saved conversation panes remain readable.
- **WA3 is source-complete:** typed handoffs connect Workspace, Agents,
  PacketCode, Git endings, Flight Deck, PacketAgent, and Monitor without
  cloning identity or state. See
  [`workspace-agents-wa3-handoff-evidence.md`](./workspace-agents-wa3-handoff-evidence.md).
- **The ownership boundary is regression-enforced:** the normal test suite
  rejects new Workspace GUI-agent producers, every conversation-pane
  attachment/materialization API, dormant draft tiles, and unreviewed
  secondary windows. Monitor application
  commands are Rust-allowlisted to read/focus/close operations, all other
  non-main window labels are denied by default, and Monitor uses repeatable
  atomic read-only conversation snapshots that cannot persist auto-archive
  changes or discard the last safe projection after a failed refresh.
- **Startup/runtime hardening is implemented and packaged locally:** large
  Codex analytics histories are parsed off the Tauri command thread with a
  bounded reverse reader; cold-start hydration clears stale PTY ids, awaits
  conversations before reconciliation, and does not mount or launch hidden
  Workspace terminals; the Windows resolver rejects the Codex Store desktop
  app in favor of the CLI wrapper.
- **Automated gates:** production frontend build, TypeScript, repository lint,
  Prettier, and diff checks pass; the complete frontend suite passes **165
  files / 1,255 tests**, including route/creation/handoff boundaries and WA4
  migration fixtures. Rust library tests pass **430 / 430** with two explicitly
  ignored real-user-state tests; `cargo check` and `cargo fmt --check` pass.

The local packaged Windows startup/Workspace/Agents/CLI gate passes. The owner
has now explicitly retired creation of new Workspace conversation attachments;
the planned elapsed-use recommendation threshold no longer blocks this goal.
Existing saved panes remain load-compatible. SSH, published PacketCode, and
configured PacketAgent runtime proofs remain separate environment gates. The
detailed audit is in
[`workspace-agents-completion-audit-2026-07-29.md`](./workspace-agents-completion-audit-2026-07-29.md).
The final decision record, historical sample, and migration fixtures are in
[`workspace-agents-wa4-dogfood-gate.md`](./workspace-agents-wa4-dogfood-gate.md);
WA4 is complete by explicit owner decision.

### Packaged Windows runtime proof — 2026-07-29

An isolated embedded Windows release artifact was exercised against the real
saved three-Workspace state:

- Welcome remained responsive and had **zero PTYs**; neither the Workspace nor
  xterm chunks loaded before the first Workspace visit.
- `load_persisted_state` and `load_conversations` each completed in roughly
  **10 ms**. A 5.31 GB / 1,136-file Codex history no longer starved the native
  loop; analytics completed in roughly **2.1 s** in its blocking worker while
  unrelated Tauri invokes stayed responsive.
- Agents loaded normally without mounting Workspace or launching a CLI.
- Opening Workspace took roughly **0.47 s** and still launched nothing until a
  specific Workspace was selected.
- Selecting SideStep launched exactly its saved Claude and Codex panes. Both
  were alive; Codex used the npm CLI wrapper instead of the Windows Store
  desktop executable.
- Workspace → Agents → Workspace preserved the same two PTY session ids with
  no duplicate launch or teardown.
- Closing PacketADE terminated the exact test process and both child CLIs.

This completed goal remains the canonical product contract for Workspace and
Agents. Remote Agents remains planned and paused at its existing Sprint-0
decision gate until the owner resumes it.

## The decision in one sentence

Change where agent work is presented, not what the agent system can do.

PacketADE keeps its GUI/API-agent engine, provider abstraction, approvals,
plans, diffs, Memory, review, worktree endings, cost tracking, and resumable
conversations. Those capabilities gain an agent-first home instead of being an
equal default tile in every Workspace.

## Product responsibility map

| Product or surface  | Primary responsibility                                                       |
| ------------------- | ---------------------------------------------------------------------------- |
| PacketCode          | Fast terminal-native coding-agent inner loop                                 |
| PacketADE Workspace | High-density CLI/PTY workroom for active, hands-on work                      |
| PacketADE Agents    | Delegated AI work, attention, approvals, plans, diffs, and review            |
| Flight Deck         | Structured delivery across plans, tasks, attempts, reviewers, and publishing |
| Monitor             | Read-only operational awareness on another display                           |
| PacketAgent         | Durable bounded execution after PacketADE closes                             |

These are different presentations over connected projects, conversations,
worktrees, reviews, and execution state. They must not become isolated products
inside the app.

## Workspace contract

Workspace is the professional CLI command center.

New Workspaces should:

- create terminal/CLI panes by default;
- recommend PacketCode first when it is detected;
- continue to support Claude Code, Codex CLI, Gemini, OpenCode, plain shells,
  and local or SSH projects;
- emphasize persistent layouts, pane health, reconnect/replay, broadcast
  prompts or commands, prompt libraries, runbooks, Git, files, and project
  status;
- use language such as **Add Session** or **Add CLI**, not **Add Agent**, for
  its primary creation action;
- show small global agent attention/status affordances without turning the
  default mosaic into an agent conversation dashboard.

Workspace does not own the GUI-agent runtime. It may present a compatible view
of an existing conversation during migration, but new GUI-agent creation
belongs to Agents.

## Agents contract

Agents is a first-class route in the existing PacketADE main window.

Its baseline layout should provide:

- a cross-project conversation and attention list;
- clear `needs_you`, running, failed, and completed states;
- one large active conversation rather than many cramped equal tiles;
- the existing composer, streaming transcript, tool cards, and attachments;
- approvals, plan, changes, review, diff, Memory, MCP sources, cost, and
  worktree-ending inspection;
- launch controls for provider/auth identity, model, profile, project,
  local/SSH target, permission mode, and worktree isolation;
- explicit actions that move the user to the best surface for the next step.

Side-by-side agent comparison can follow after the single-conversation
experience is coherent. The first version does not need to reproduce the
Workspace mosaic.

## Required handoffs

The restructuring succeeds only if moving between surfaces feels continuous.

Required contracts:

- **Workspace → Delegate to Agent**
- **Agents → Open project in Workspace**
- **Agents → Send/continue in PacketCode**
- **Agents → Attach terminal**
- **Agents → Open Git ending**
- **Agents → Add to Flight**
- **Flight Deck → Open attempt in Workspace**
- **Flight Deck → Keep running in PacketAgent**
- **Agents or Flight Deck → Send to Monitor**

A handoff changes presentation or execution ownership deliberately. It must not
clone the underlying conversation, worktree, approval queue, review state, or
history.

## Compatibility policy

The owner decision is **retire new attachments; preserve old layouts**:

- existing persisted conversation panes remain readable and removable;
- active conversations and transcripts remain resumable in Agents;
- old layouts continue to normalize and render safely;
- no menu, handoff, session-glue, Workspace-store, wrapper, or draft API can
  create a new conversation pane;
- Git-ending and Flight-attempt handoffs open the project in a CLI-first
  Workspace without attaching the conversation;
- closing an existing conversation pane does not delete its conversation and
  cannot be reversed through a new attachment action.

The compatibility renderer and migration/GC logic remain because deleting user
data was never part of this decision.

## Why the detachable Agents window is later

A separate native Agents window is a desirable multi-monitor destination, but
the current frontend is not safe for two interactive writers:

- Zustand stores and listener registries are WebView-local;
- scoped agent event listeners can be installed in more than one window;
- drafts, approval queues, streaming buffers, review state, and selections are
  frontend-owned;
- two windows could hydrate and save the same conversation;
- duplicate listeners could process one event twice or race persistence.

The current Monitor window is read-only in both UI and Rust application-command
authority. It still does not prove multi-writer safety because it never owns
interactive Agent state.

Before an interactive detachable window ships, one of these must exist:

1. the main window is the single owner and detachable views route commands
   through it; or
2. Rust owns canonical revisioned conversation, approval, and persistence state
   while all windows subscribe to snapshots and events.

## Implementation sequence

### WA0 — lock the contract and baseline

- Keep this document, `ROADMAP.md`, `backlog.md`, and `dev/README.md` aligned.
- Inventory all conversation entry points, deep links, wrapper Workspace
  creation, focus/selection behavior, and persistence migration paths.
- Define measurable dogfood events without recording prompts or source code.

The locked route, ownership, compatibility, handoff, and proof contract is in
[`workspace-agents-wa0-route-contract.md`](./workspace-agents-wa0-route-contract.md).

Exit: every current creation/navigation path has an intended destination and
compatibility rule.

### WA1 — first-class same-window Agents surface

- Restore/add the `agents` application route.
- Build the conversation fleet and attention filters.
- Reuse the existing `AgentChatPane`, composer, inspector, approvals, review,
  plan, diff, Memory, and ending components.
- Fix the current focus/selection seam so the visible conversation is the
  selected conversation.
- Retarget conversation notifications and deep links to Agents.

Exit: a user can create, resume, supervise, approve, review, and finish a GUI
agent conversation without creating or entering a Workspace.

### WA2 — CLI-first Workspace defaults

- Make new Workspace creation CLI/PTY-only by default.
- Put PacketCode first when detected and provide install/path recovery when it
  is missing or unhealthy.
- Rename Workspace creation language around sessions and CLIs.
- Retain existing conversation-pane read compatibility.
- Stop creating wrapper Workspaces for ordinary new conversation navigation.

Exit: a new user encounters a clear CLI workroom, while an upgraded user loses
no saved conversations or layouts.

### WA3 — cross-surface handoffs

- Implement the required Workspace, Agents, Flight Deck, PacketCode,
  PacketAgent, and Monitor actions.
- Preserve conversation IDs, worktree identity, review state, and approvals.
- Define deep-link routes that survive app restart where appropriate.
- Make the destination and any execution-ownership change explicit.

Exit: each major work mode can move to the next without copying state or asking
the user to reconstruct context.

### WA4 — compatibility migration and owner decision

- Migration fixtures and real-state audits prove old panes hydrate safely.
- The initial content-free observation sample was preserved honestly.
- The owner explicitly retired new attachments before the planned elapsed-use
  threshold because the desired product responsibility split was already
  known.
- Every producer and dormant materializer is removed while read/GC
  compatibility remains.

Exit: **complete** — no new attachment can be created and old data remains safe.

### WA5 — detachable-window prerequisite

- Choose and implement the single-writer state contract.
- Add revisioned multi-window persistence and approval tests.
- Start with a read-only or single-owner projection.
- Enable full interactivity only after duplicate-listener and stale-writer
  tests pass.

Exit: **Open Agents in New Window** cannot duplicate actions or corrupt state.
This phase is later and does not block WA1–WA4.

## Current-goal definition of done

The active goal is complete when:

- Agents is a coherent first-class same-window surface;
- new Workspaces are CLI/PacketCode-first;
- existing conversation panes and data migrate safely;
- the required handoffs preserve identity and state;
- wrapper Workspace creation is no longer required for normal agent
  navigation;
- the owner decision removes all new Workspace attachment creation while
  preserving old-pane compatibility;
- documentation, tests, and terminology describe the new ownership model.

A detachable interactive window is a follow-on goal after its state-safety
prerequisite. Remote Agents is also a later resumed goal, not part of this
definition of done.

## Guardrails

- Do not delete or fork the shared conversation engine.
- Do not revive the removed autonomous Flight Planner.
- Do not make PacketCode and GUI agents compete for the same job.
- Do not clone conversations, worktrees, approvals, reviews, or histories when
  changing surfaces.
- Do not make two WebViews interactive owners of the same state.
- Do not reintroduce Workspace conversation attachment or wrapper-creation
  APIs.
- Do not remove compatibility before migration proof.
- Do not silently broaden permissions, MCP trust, or execution scope during a
  handoff.

## Session-start reminder

For any new PacketADE planning or implementation session:

1. Read this document first.
2. State which WA phase is active.
3. Preserve the responsibility map and handoff invariants.
4. Record open implementation work in `backlog.md`.
5. Update this document when an owner decision changes the goal.

If another planning document conflicts with this one, this document owns the
Workspace/Agents product direction until the owner explicitly changes it.
