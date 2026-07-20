# PacketADE Roadmap

Last updated: 2026-07-19 (hardening loop and Flight Deck runtime audit complete)

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

| ID  | Track                                     | Priority | Status                                            | Canonical Plan                                                                                                   |
| --- | ----------------------------------------- | -------: | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| R0  | Remote Agents: PWA + Packet Cloud relay   |       P0 | Blocked on three Sprint-0 product decisions        | [`dev/remoteagents/README.md`](./dev/remoteagents/README.md)                                                     |
| R1  | Docs and planning consolidation           |       P1 | Refreshed; ongoing maintenance                    | [`dev/README.md`](./dev/README.md)                                                                               |
| R2  | Distribution readiness: signing + updater |       P1 | Still blocked on signing certificates             | [`dev/updater-setup.md`](./dev/updater-setup.md), [`dev/multi-platform-build.md`](./dev/multi-platform-build.md) |
| R3  | Flight Deck planning scope                |       P1 | Decision needed after runtime audit               | [`backlog.md`](./backlog.md#flight-deck)                                                                        |

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
have now been removed as well. The next product gates are the three Remote
Agents Sprint-0 decisions (auth provider, E2EE timing, and code location) and
Flight Deck's scope: keep the streamlined parallel-attempt board, or add the
recommended lightweight conversation-backed planning step without restoring
the deleted autonomous Planner v1.

| ID | Track | Priority | Status | Next action |
| --- | --- | ---: | --- | --- |
| D1 | Remote Agents Sprint 0 | P0 | Blocked | Decide auth provider, E2EE timing, and code location; then split the six-agent implementation runbook. |
| D2 | Flight Deck scope | P1 | Decision needed | Keep the parallel-attempt board only, or add the recommended lightweight conversation-backed planning step. |
| D3 | API-agent concurrency | P2 | Ready | Redesign F28 per-turn cancellation, then thread `toolUseId` through G11 edit responses. |
| D4 | SSH parity verification | P2 | Ready / environment-gated | Fix the saved-password path probe and run the live Codex-over-SSH smoke. |
| D5 | Signing and updater | P1 | Externally blocked | Acquire Windows/macOS credentials, then follow the existing release runbooks. |

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

Sprints 0-4, the Flight Deck worktree-attempt runtime, workspace panes, Issues, GitHub + Memory,
dictation, cost analytics, cost guardrails / budget thresholds, API-agent
conversations, sidecar protocol v8 (v6→v7 planner-amputation, v7→v8 S8-Phase-B
MCP-over-SSH), PacketADE-as-MCP-server (N3), MCP servers over SSH (S8 A+B),
remote git commands (S7), Codex-over-SSH (S9), local quality gates, and the
conversation-as-tile single-surface consolidation (the "match Claude Code &
Codex" initiative, now folded into the Workspace tile surface) are shipped. The
full release narrative lives in [`CHANGELOG.md`](./CHANGELOG.md).

The former autonomous Flight Planner v1 is historical, not a shipped current
surface: its UI/FSM was removed during the July 6 orchestration convergence and
its unreachable Rust/sidecar backend was amputated July 11. The next Flight Deck
decision is whether to keep the intentionally smaller parallel-attempt board or
add a lightweight explicit planning step on the normal conversation contract;
the deleted autonomous runtime should not be restored wholesale.

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

1. Resolve the three Remote Agents Sprint-0 decisions, then split work against the six-agent runbook.
2. Land a private PWA/relay alpha with desktop-owned execution and audited
   command envelopes.
3. Acquire Windows + macOS signing certificates.
4. Wire signing config and the Tauri updater.
5. Expand E2E coverage across workspace session creation, API-agent launch,
   Remote Agents approval flow, and the Flight attempt lifecycle.
