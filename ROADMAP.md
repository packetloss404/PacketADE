# PacketADE Roadmap

Last updated: 2026-05-27

`ROADMAP.md` is the short product-direction document. It says what matters now
and why. The task ledger lives in [`backlog.md`](./backlog.md); implementation
briefs, runbooks, and historical planning live under [`dev/`](./dev/README.md).
For architectural conventions, see [`AGENTS.md`](./AGENTS.md) and
[`CLAUDE.md`](./CLAUDE.md).

## North Star

PacketADE is a local-first agent development environment: the desktop remains
the source of truth for providers, models, secrets, workspaces, MCP config,
permissions, memory, and execution. The next phase adds an optional Packet
Cloud relay so trusted phones can control that desktop safely from anywhere
without turning PacketADE into a cloud-only coding agent.

## Now

| ID  | Track                                     | Priority | Status                                            | Canonical Plan                                                                                                   |
| --- | ----------------------------------------- | -------: | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| R0  | Remote Agents: PWA + Packet Cloud relay   |       P0 | Planning complete; ready for implementation split | [`dev/remoteagents/README.md`](./dev/remoteagents/README.md)                                                     |
| R1  | Docs and planning consolidation           |       P1 | In progress                                       | [`dev/README.md`](./dev/README.md)                                                                               |
| R2  | Distribution readiness: signing + updater |       P1 | Blocked on signing certificates                   | [`dev/updater-setup.md`](./dev/updater-setup.md), [`dev/multi-platform-build.md`](./dev/multi-platform-build.md) |

### Remote Agents Acceptance Shape

The first Remote Agents release is successful when a user can sign into a
Packet account from a PWA, trust a desktop host, see configured PacketADE
providers/models/profiles, start or continue API-agent conversations, stream
`api-agent:*` events, approve or deny permission/edit prompts, and receive push
notifications for attention-needed events. Provider secrets, MCP servers,
files, shells, and execution remain on the desktop. End-to-end encryption is a
gate before any external beta.

## Next

| ID  | Track                            | Priority | Status      | Notes                                                                                                                                                                                   |
| --- | -------------------------------- | -------: | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | Sidecar-over-SSH                 |       P1 | Open        | Biggest remaining remote-workspace gap for subscription providers. Tracked in [`backlog.md`](./backlog.md).                                                                             |
| N2  | Swarm orchestration escalation   |       P2 | Partial     | Auto-reassignment remains deferred. See [`dev/bridgemind/swarm-orchestration-plan.md`](./dev/bridgemind/swarm-orchestration-plan.md).                                                   |
| N3  | PacketADE MCP provider transport |       P2 | Deferred    | Frontend provider config exists; Rust transport is deferred. See [`dev/mcp-provider-transport.md`](./dev/mcp-provider-transport.md).                                                    |
| N4  | Git review packet integration    |       P2 | Partial     | Workspace GitDashboard exists; review packet and mission approval ties need wiring. See [`dev/zen-workspace/features-git-workspace.md`](./dev/zen-workspace/features-git-workspace.md). |
| N5  | Cost alerts                      |       P2 | Not started | Budget and alert workflows on top of Cost Dashboard / LiveSpendChip. See [`dev/moat/cost-dashboard-plan.md`](./dev/moat/cost-dashboard-plan.md).                                        |

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

Sprints 0-4, Mission Planner v1, workspace panes, Issues, GitHub + Memory,
dictation, cost analytics, API-agent conversations, sidecar protocol v6, local
quality gates, and the Agents-pane "match Claude Code & Codex" initiative are
shipped. The full release narrative lives in [`CHANGELOG.md`](./CHANGELOG.md).

Run the usual gates before release: `pnpm lint`, `pnpm test`, `pnpm build`,
`pnpm e2e`, `cargo check --manifest-path src-tauri/Cargo.toml`, and
`cargo test --manifest-path src-tauri/Cargo.toml`.

## Architectural Debt

- Rust backend test coverage is much stronger after the v0.9.2 / v0.9.3 audit
  waves, but several command/core follow-ups remain in `backlog.md`.
- Store consolidation should be product-led. `historyStore`,
  `projectHistoryStore`, and `promptStore` may overlap; `flightStore` and
  `orchestrationStore` currently have a clean CRUD/runtime boundary.
- Mid-session MCP hot-swap is not supported; `enabledMcpServerIds` changes
  apply on the next session start.
- Remote Agents must stay narrow: no generic remote Tauri bridge, no cloud-side
  provider secret handling, and no raw PTY control in the v1 scope.

## Release Path

1. Keep Remote Agents implementation split against the six-agent runbook.
2. Land a private PWA/relay alpha with desktop-owned execution and audited
   command envelopes.
3. Acquire Windows + macOS signing certificates.
4. Wire signing config and the Tauri updater.
5. Expand E2E coverage across workspace session creation, API-agent launch,
   Remote Agents approval flow, and mission approval cycle.
