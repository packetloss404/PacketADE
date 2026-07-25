# Dev Planning Docs

Last updated: 2026-07-19

This directory holds **active** planning docs with outstanding work items plus the engineering reference docs that used to live in `docs/`. Completed docs have been moved to `dev/archive/`.

## Planning Ownership

Use these as the trust anchors before reading older plan files:

| Area                       | Canonical owner                                                                                                                                                                                                                      | Notes                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Live task register         | [`../backlog.md`](../backlog.md)                                                                                                                                                                                                     | Single source for outstanding work. The July P1/P2 hardening loop is complete.                           |
| Reliability remediation   | [`reliability-low-fix-loop-2026-07-19.md`](./reliability-low-fix-loop-2026-07-19.md)                                                                                                                                                  | Completed 30-finding revalidation, fix, regression, and verification record.                            |
| Release priorities         | [`../ROADMAP.md`](../ROADMAP.md)                                                                                                                                                                                                     | Short current summary; detailed plans stay in this folder.                                             |
| Remote/mobile agent access | [`remoteagents/README.md`](./remoteagents/README.md)                                                                                                                                                                                 | Supersedes the older `mobile/` investigation for phone/PWA work.                                       |
| Multi-monitor operations   | [`send-to-monitor-plan.md`](./send-to-monitor-plan.md)                                                                                                                                                                               | Paused planning doc for detached Monitor windows; no implementation until current feature/bug checks.  |
| Competitor landscape       | [`competitors.md`](./competitors.md)                                                                                                                                                                                                 | Master competitor index (12 peers). Deep dives: [`bridgemind/bridgespace-competitive-brief.md`](./bridgemind/bridgespace-competitive-brief.md), [`bridgemind/bridgeswarm-teardown.md`](./bridgemind/bridgeswarm-teardown.md). Provider/auth abstraction is the moat the field lacks. |
| Flight escalation loop      | [`bridgemind/flight-escalation-loop.md`](./bridgemind/flight-escalation-loop.md)                                                                                                                                                      | Scoped, loop-ready plan for structured escalation + auto-reassignment (BridgeSwarm supervision parity). Supersedes Phase 4 of the stale `swarm-orchestration-plan.md`. |
| Memory v0.9+ loop           | [`memory-v9-loop.md`](./memory-v9-loop.md)                                                                                                                                                                                            | SHIPPED (M1–M10, merged 2026-07-24) — fleshed out the Memory pane: fixed half-wired gaps (search/task_completed/confidence/retrospective) + shipped the deferred enhancements. Embeddings deferred. |
| Gitea/Forgejo support loop  | [`gitea-support-loop.md`](./gitea-support-loop.md)                                                                                                                                                                                    | SHIPPED (G1–G14, merged 2026-07-25) — self-hosted Gitea/Forgejo alongside GitHub, both configurable at once, resolved per-workspace from the origin remote. Peer-reviewed. |
| GitHub pane v0.9+ loop       | [`github-pane-v9-loop.md`](./github-pane-v9-loop.md)                                                                                                                                                                                   | Scoped loop (GP1–GP7) — the v0.8 GitHub-pane deferrals: inline review comments, notifications polling, device-flow auth, Windows hook shim, SSH draft-PR publish, releases/actions view, Issue↔Flight two-way mirroring (design-gated). |
| SSH & remote workspaces loop | [`ssh-remote-loop.md`](./ssh-remote-loop.md)                                                                                                                                                                                           | Scoped loop (S1–S11) — remote hardening: process-tree kill on timeout, keyPath hygiene, remote-git polish, ServerConfig wire hygiene, Windows-OpenSSH / `realpath` parity, file-cap; live Codex-over-SSH smoke (env-gated). |
| SSH workspace parity       | [`sidecar-over-ssh-verification.md`](./sidecar-over-ssh-verification.md)                                                                                                                                                             | Test and manual verification contract for subscription providers on remote workspaces.                 |
| MCP provider transport     | [`mcp-provider-transport.md`](./mcp-provider-transport.md)                                                                                                                                                                           | SHIPPED (N3) — PacketADE-as-MCP-server: reads + opt-in append-only writes. Doc records the cut/deferred tools. |
| Build and release ops      | [`multi-platform-build.md`](./multi-platform-build.md), [`updater-setup.md`](./updater-setup.md), [`local-quality-gates.md`](./local-quality-gates.md), [`beta-distribution-trust-runbook.md`](./beta-distribution-trust-runbook.md) | Operational runbooks, not feature backlogs.                                                            |
| Historical plans           | [`archive/`](./archive/)                                                                                                                                                                                                             | Cold storage; do not treat as current unless an active doc links to a specific artifact as background. |

## Reference

Technical runbooks and how-tos. Not backlog items themselves (those live in [`/backlog.md`](../backlog.md)), but the docs the backlog points at.

- `local-quality-gates.md` — preflight / full-check pipeline, individual gate commands
- `multi-platform-build.md` — macOS / Linux / Windows prerequisites + build flow + cross-compile notes
- `beta-distribution-trust-runbook.md` — beta release trust gates, signing/updater credential checks, and release-candidate flow
- `sidecar-over-ssh-verification.md` — test and manual checklist for Sidecar-over-SSH provider parity
- `updater-setup.md` — runbook for wiring up the Tauri v2 auto-updater (currently not enabled)
- `bridgemind/swarm-orchestration-plan.md` — shipped human-in-the-loop escalation design record
- `bridgemind/packetade-mcp-server-plan.md` / `mcp-provider-transport.md` — shipped PacketADE MCP-provider design records
- `ssh-tech-debt.md` — redirect to `/backlog.md` (left for old links)
- `p1-p2-fix-loop-spec.md` / `session-resume-2026-07-19.md` — completed July hardening loop and verification record

> Dated `code-review-YYYY-MM-DD.md` files (e.g. `code-review-2026-05-31.md`, `code-review-2026-06-07.md`) are intentionally left unindexed point-in-time audit artifacts; actionable items from them land in `/backlog.md`.

## Active (Outstanding Items)

### Current decision gates

- Remote Agents remains blocked on its three Sprint-0 choices: auth provider, E2EE timing, and code location.
- Flight Deck Option B is implemented: upfront read-only
  `AgentConversation`-backed planning with an explicit apply step. The old
  autonomous Planner v1 remains historical, not a restoration candidate.
- Distribution remains blocked on Windows and macOS signing credentials.
- The mechanical G33/F53/G01/Unix-SSH/G09 hardening loop and deploy-backend cleanup are complete.
- The 30 low-rated Reliability audit findings are closed; `backlog.md` no longer carries them.

### Flight Planner (archived — backend amputated 2026-07-11)

The Flight Planner planning docs are now in [`archive/`](./archive/). The Rust
flight-planner backend's fate was resolved and executed: the shared executor
money path was extracted into `commands/flight_cost.rs`, then the
genuinely-dead planner command family, prompts, journal, and the sidecar's
in-process planner MCP surface were deleted (sidecar protocol bumped to v7).
See [`../backlog.md`](../backlog.md#flight-deck) for the current audit and
remaining decisions. Do not resume this work from the archived docs — they describe the
deleted v1 planner surface.

The live Flight Deck is the smaller worktree-attempt system
(`flightStore.ts` + `asyncFlightStore.ts` + `commands/flight_attempts.rs`), not
the archived autonomous Planner. A 2026-07-19 audit verified that separation and
fixed launch-persistence, pre-cleanup draft-PR publishing, and SSH terminal
cleanup races. Option B subsequently added a lightweight explicit planning step
on the normal `AgentConversation` contract; plans are user-applied and attempts
remain user-launched. Do not restore archived Planner v1.

- `archive/flight-planner-v1-acceptance-runbook.md` — manual sign-off runbook (v1, deleted backend)
- `archive/flight-planner-reliability-continuity-pack.md` — reliability + continuity contract for Flight Planner journals (deleted backend)
- `archive/flight-planner-plan.md` and `archive/flight-planner-spike-retro.md` — locked v1 design/reference (deleted backend)

### Workspace UX

- `zen-workspace/features-git-workspace.md` — Phase 3 review packet ties partial
- `zen-workspace/features-prompt-library.md` — command palette integration not started

### Remote Agents

- `remoteagents/README.md` — cloud-relayed PWA Remote Agents plan, architecture, security, protocol, implementation sprints, and six-agent runbook

### Monitor Windows

- `send-to-monitor-plan.md` — paused plan for "Send to Monitor", PacketADE's detached multi-monitor operations windows

### Superseded / Research

- `mobile/README.md` — prior mobile companion investigation, superseded for implementation by `remoteagents/README.md`
- `archive/v0.8-github-and-memory.md` — historical v0.8 plan (archived); current open items belong in `/backlog.md`

## Archive

`dev/archive/` contains completed planning docs preserved for historical reference. Many archived files intentionally keep the former PacketCode name because they describe research and decisions made before the rename:

- `archive/backlog.md`, `archive/cross-competitor-map.md`, `archive/positioning-notes.md`, `archive/priority-resolution.md`
- `archive/agents-tab-modernization-plan.md` — 314-finding review that seeded the Agents-tab Waves 1–4 (surface since folded into the tile composer)
- `archive/flight-planner-plan.md`, `archive/flight-planner-spike-retro.md`, `archive/flight-planner-v1-acceptance-runbook.md`, `archive/flight-planner-reliability-continuity-pack.md` — Flight Planner v1 design/reference/runbooks (backend amputated 2026-07-11, see `/backlog.md`)
- `archive/v0.8-github-and-memory.md` — locked v0.8 GitHub + Memory design/scope
- `archive/sprints-2026-06-15.md` — post-rename sprint plan; residual open items folded into `/backlog.md`
- `archive/moat/` — memory layer, insights, deploy, scaffold, analytics, cost unification specs
- `archive/bridgemind/` — gap analysis, workspace editor scale, positioning notes
- `archive/quadcode/` — gap analysis, terminal features, AI platform features
- `archive/zen-workspace/` — workspace model plan, gap analysis, research, project-workspaces feature spec
- `archive/vibetotext/` — sprint plan, features spec, README

> Dated `code-review-YYYY-MM-DD.md` files (e.g. `code-review-2026-05-31.md`, `code-review-2026-06-07.md`) are intentionally unindexed: they are point-in-time audit artifacts, not active planning docs. Outstanding items they surfaced are tracked in [`/backlog.md`](../backlog.md).

## Tracks (All Implemented)

All five product tracks have been implemented:

- **W** — Workspace Foundation (workspace-per-project) ✅
- **X** — Workspace UX (templates, editor, git, prompts) ✅
- **S** — Swarm Orchestration (roles, ownership, coordination) ✅
- **M** — MCP Provider (frontend + Rust MCP server transport) ✅ (N3 shipped)
- **T** — TUI Evolution (polling, search, leader key) ✅
