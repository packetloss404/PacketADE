# PacketADE Roadmap

Last updated: 2026-07-27 (Flight supervision loops and PacketCode source
integration complete)

`ROADMAP.md` is the short product-direction document. It says what matters now
and why. The task ledger lives in [`backlog.md`](./backlog.md); implementation
briefs, runbooks, and historical planning live under [`dev/`](./dev/README.md).
For architectural conventions, see the local generated `AGENTS.md` and
`CLAUDE.md` files (intentionally gitignored).

## North Star

PacketADE is a local-first agent development environment: the desktop remains
the source of truth for providers, models, secrets, workspaces, MCP config,
permissions, memory, and execution. The next phase adds an optional Packet
Cloud relay so trusted phones can control that desktop safely from anywhere
without turning PacketADE into a cloud-only coding agent.

## Now

| ID  | Track                                     | Priority | Status                                      | Canonical Plan                                                                                                   |
| --- | ----------------------------------------- | -------: | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| R0  | Remote Agents: PWA + Packet Cloud relay   |       P0 | Blocked on three Sprint-0 product decisions | [`dev/remoteagents/README.md`](./dev/remoteagents/README.md)                                                     |
| R1  | Docs and planning consolidation           |       P1 | Refreshed; ongoing maintenance              | [`dev/README.md`](./dev/README.md)                                                                               |
| R2  | Distribution readiness: signing + updater |       P1 | Still blocked on signing certificates       | [`dev/updater-setup.md`](./dev/updater-setup.md), [`dev/multi-platform-build.md`](./dev/multi-platform-build.md) |
| R3  | Flight Deck supervision                   |       P1 | Core loops implemented; manual/SSH smoke remains | [`dev/bridgemind/reviewer-gate-loop.md`](./dev/bridgemind/reviewer-gate-loop.md), [`dev/bridgemind/cooperative-flight-graph-loop.md`](./dev/bridgemind/cooperative-flight-graph-loop.md), [`dev/bridgemind/coordination-inbox-loop.md`](./dev/bridgemind/coordination-inbox-loop.md), [`dev/bridgemind/autonomy-policy-loop.md`](./dev/bridgemind/autonomy-policy-loop.md) |
| R4  | PacketCode integration                   |       P1 | Source integration complete; release proof gated | [`dev/bridgemind/packetcode-bridgecode-loop.md`](./dev/bridgemind/packetcode-bridgecode-loop.md)                   |
| R5  | PacketAgent deploy/supervise handoff     |       P1 | Contract-only here; blocked on separate project | [`dev/bridgemind/packetagent-handoff-loop.md`](./dev/bridgemind/packetagent-handoff-loop.md)                       |

### Remote Agents Acceptance Shape

The first Remote Agents release is successful when a user can sign into a
Packet account from a PWA, trust a desktop host, see configured PacketADE
providers/models/profiles, start or continue API-agent conversations, stream
`api-agent:*` events, approve or deny permission/edit prompts, and receive push
notifications for attention-needed events. Provider secrets, MCP servers,
files, shells, and execution remain on the desktop. End-to-end encryption is a
gate before any external beta.

The v0.9.4 trust wave (SSH host-key pinning on async launch, remote SSH
file-tool confinement) hardened the *runtime* connection path, but it does not
touch binary distribution. R2 stays blocked on the same external dependency:
acquiring Windows + macOS code-signing certificates. Once certificates land,
the remaining R2 work is wiring the signing config and Tauri updater per the
canonical plan docs.

## Next

The reliability loop in
[`dev/p1-p2-fix-loop-spec.md`](./dev/p1-p2-fix-loop-spec.md) is complete. The
orphaned deploy backend was already deleted; its unused constants and test mocks
have now been removed as well. Flight Deck Option B is implemented as an
explicit read-only `AgentConversation`: the user refines a structured plan,
applies milestones/tasks to the Flight, and launches attempts separately. It
does not restore the deleted autonomous Planner v1.

| ID  | Track                   | Priority | Status                                 | Next action                                                                                                         |
| --- | ----------------------- | -------: | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| D1  | Remote Agents Sprint 0  |       P0 | Blocked                                | Decide auth provider, E2EE timing, and code location; then split the six-agent implementation runbook.              |
| D2  | Flight Deck scope       |       P1 | Complete                               | Option B shipped: upfront conversation-backed planning with explicit apply; attempts remain user-launched.          |
| D3  | API-agent concurrency   |       P2 | Complete                               | Turns now have compare-and-remove ownership; sidecar protocol v9 targets edit responses by `toolUseId`.             |
| D4  | SSH parity verification |       P2 | Partially complete / environment-gated | Saved-password path probing is fixed; run the live Codex-over-SSH smoke when a configured remote host is available. |
| D5  | Signing and updater     |       P1 | Externally blocked                     | Acquire Windows/macOS credentials, then follow the existing release runbooks.                                       |
| D6  | Flight supervision gates |       P1 | Core implementation complete          | Run packaged local/SSH/manual matrices for Reviewer Gate, cooperative integration, inbox delivery, and bounded YOLO. |
| D7  | PacketCode release proof |       P1 | Source integration complete           | Publish signed multi-platform artifacts; run clean-machine install/upgrade/rollback and cross-product smoke.          |

## Later

- Codex CLI app-server transport (A6): revisit when PacketADE needs long-lived
  app-server capabilities that `codex exec` cannot provide.
- Send to Monitor / multi-monitor operations: paused after planning while the
  current feature and bug-check pass runs. See
  [`dev/send-to-monitor-plan.md`](./dev/send-to-monitor-plan.md).
- Native iOS / TestFlight for Remote Agents: evaluate after the PWA relay,
  auth, push, and mobile UX prove useful.
- Plugin system: community manifest format after distribution and updater work
  are no longer blocked.
- Multi-model A/B comparison: the agent tray and worktree-per-conversation
  foundation make this approachable, but it is not on the current path.

## Shipped Foundation

Sprints 0-4, the Flight Deck worktree-attempt runtime, Reviewer Gate,
cooperative Flight graphs, Coordination Inbox, bounded YOLO policy, PacketCode
source integration, workspace panes, Issues, GitHub + Memory,
dictation, cost analytics, cost guardrails / budget thresholds, API-agent
conversations, sidecar protocol v10 (v6→v7 planner-amputation, v7→v8 S8-Phase-B
MCP-over-SSH, v8→v9 targeted edit responses, v9→v10 explicit `cancelled` terminal marker), PacketADE-as-MCP-server (N3), MCP servers over SSH (S8 A+B),
remote git commands (S7), Codex-over-SSH (S9), local quality gates, and the
conversation-as-tile single-surface consolidation (the "match Claude Code &
Codex" initiative, now folded into the Workspace tile surface) are shipped. The
full release narrative lives in [`CHANGELOG.md`](./CHANGELOG.md).

The former autonomous Flight Planner v1 is historical, not a shipped current
surface: its UI/FSM was removed during the July 6 orchestration convergence and
its unreachable Rust/sidecar backend was amputated July 11. Flight Deck now has
the deliberately smaller Option B planning step on the normal conversation
contract; the deleted autonomous runtime remains out of scope.

Run the usual gates before release: `pnpm lint`, `pnpm test`, `pnpm build`,
`pnpm e2e`, `cargo check --manifest-path src-tauri/Cargo.toml`, and
`cargo test --manifest-path src-tauri/Cargo.toml`.

## Architectural Debt

- Rust backend test coverage is much stronger after the v0.9.2 / v0.9.3 audit
  waves, but several command/core follow-ups remain in `backlog.md`.
- Store consolidation should be product-led. `historyStore`,
  `projectHistoryStore`, and `promptStore` may overlap; `flightStore` (CRUD)
  and `asyncFlightStore` (runtime) now hold the flight state after
  `orchestrationStore` was pruned and its runtime responsibilities converged
  onto `asyncFlightStore`.
- Mid-session MCP hot-swap is not supported; `enabledMcpServerIds` changes
  apply on the next session start.
- Remote Agents must stay narrow: no generic remote Tauri bridge, no cloud-side
  provider secret handling, and no raw PTY control in the v1 scope.

## Release Path

1. Run the packaged local/SSH/manual Flight supervision matrices and the
   PacketCode clean-machine release matrix.
2. Resolve the three Remote Agents Sprint-0 decisions, then split work against the six-agent runbook.
3. Land a private PWA/relay alpha with desktop-owned execution and audited
   command envelopes.
4. Consume the versioned PacketAgent worker contract when its separate project
   ships W1–W9; do not recreate durable execution in PacketADE.
5. Acquire Windows + macOS signing certificates.
6. Wire signing config and the Tauri updater.
7. Expand E2E coverage across workspace session creation, API-agent launch,
   Remote Agents approval flow, and the Flight attempt lifecycle.
