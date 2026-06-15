# Dev Planning Docs

Last updated: 2026-06-15

This directory holds **active** planning docs with outstanding work items plus the engineering reference docs that used to live in `docs/`. Completed docs have been moved to `dev/archive/`.

## Planning Ownership

Use these as the trust anchors before reading older plan files:

| Area                       | Canonical owner                                                                                                                                                                                                                      | Notes                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Live task register         | [`../backlog.md`](../backlog.md)                                                                                                                                                                                                     | Single source for outstanding work. Extract open items here before freezing old specs.                 |
| Release priorities         | [`../ROADMAP.md`](../ROADMAP.md)                                                                                                                                                                                                     | Short current summary; detailed plans stay in this folder.                                             |
| Remote/mobile agent access | [`remoteagents/README.md`](./remoteagents/README.md)                                                                                                                                                                                 | Supersedes the older `mobile/` investigation for phone/PWA work.                                       |
| Multi-monitor operations   | [`send-to-monitor-plan.md`](./send-to-monitor-plan.md)                                                                                                                                                                               | Paused planning doc for detached Monitor windows; no implementation until current feature/bug checks.  |
| SSH workspace parity       | [`sidecar-over-ssh-verification.md`](./sidecar-over-ssh-verification.md)                                                                                                                                                             | Test and manual verification contract for subscription providers on remote workspaces.                 |
| MCP provider transport     | [`mcp-provider-transport.md`](./mcp-provider-transport.md)                                                                                                                                                                           | Implementation owner for the deferred local MCP server.                                                |
| Build and release ops      | [`multi-platform-build.md`](./multi-platform-build.md), [`updater-setup.md`](./updater-setup.md), [`local-quality-gates.md`](./local-quality-gates.md), [`beta-distribution-trust-runbook.md`](./beta-distribution-trust-runbook.md) | Operational runbooks, not feature backlogs.                                                            |
| Historical plans           | [`archive/`](./archive/)                                                                                                                                                                                                             | Cold storage; do not treat as current unless an active doc links to a specific artifact as background. |

## Reference

Technical runbooks and how-tos. Not backlog items themselves (those live in [`/backlog.md`](../backlog.md)), but the docs the backlog points at.

- `local-quality-gates.md` — preflight / full-check pipeline, individual gate commands
- `multi-platform-build.md` — macOS / Linux / Windows prerequisites + build flow + cross-compile notes
- `beta-distribution-trust-runbook.md` — beta release trust gates, signing/updater credential checks, and release-candidate flow
- `sidecar-over-ssh-verification.md` — test and manual checklist for Sidecar-over-SSH provider parity
- `updater-setup.md` — runbook for wiring up the Tauri v2 auto-updater (currently not enabled)
- `ssh-tech-debt.md` — redirect to `/backlog.md` (left for old links)

> Dated `code-review-YYYY-MM-DD.md` files (e.g. `code-review-2026-05-31.md`, `code-review-2026-06-07.md`) are intentionally left unindexed point-in-time audit artifacts; actionable items from them land in `/backlog.md`.

## Active (Outstanding Items)

### Moat

- `moat/cost-dashboard-plan.md` — cost alerts not yet implemented

### Swarm Orchestration

- `bridgemind/swarm-orchestration-plan.md` — Phase 4 escalation (auto-reassignment) partial
- `bridgemind/packetade-mcp-server-plan.md` — PacketADE MCP provider Phase 1 frontend done, transport layer deferred

### MCP Provider

- `mcp-provider-transport.md` — Phases 2-3 deferred (local MCP server transport)

### Flight Planner

- `flight-planner-v1-acceptance-runbook.md` — live manual sign-off for Flight Planner v1
- `flight-planner-reliability-continuity-pack.md` — reliability + continuity test/verification contract for Flight Planner journals
- `flight-planner-plan.md` and `flight-planner-spike-retro.md` — locked v1 design/reference; remaining work should be tracked in `/backlog.md`

### Workspace UX

- `zen-workspace/features-git-workspace.md` — Phase 3 review packet ties partial
- `zen-workspace/features-prompt-library.md` — command palette integration not started

### Remote Agents

- `remoteagents/README.md` — cloud-relayed PWA Remote Agents plan, architecture, security, protocol, implementation sprints, and six-agent runbook

### Monitor Windows

- `send-to-monitor-plan.md` — paused plan for "Send to Monitor", PacketADE's detached multi-monitor operations windows

### Superseded / Research

- `mobile/README.md` — prior mobile companion investigation, superseded for implementation by `remoteagents/README.md`
- `v0.8-github-and-memory.md` — historical v0.8 plan; current open items belong in `/backlog.md`

## Archive

`dev/archive/` contains completed planning docs preserved for historical reference. Many archived files intentionally keep the former PacketCode name because they describe research and decisions made before the rename:

- `archive/backlog.md`, `archive/cross-competitor-map.md`, `archive/positioning-notes.md`, `archive/priority-resolution.md`
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
- **M** — MCP Provider (frontend types/store/settings) ✅ (transport deferred)
- **T** — TUI Evolution (polling, search, leader key) ✅
