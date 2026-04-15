# Dev Planning Docs

Last updated: 2026-04-15

This directory holds **active** planning docs with outstanding work items. Completed docs have been moved to `dev/archive/`.

## Active (Outstanding Items)

### Moat
- `moat/cost-dashboard-plan.md` — cost alerts not yet implemented
  
### Swarm Orchestration
- `bridgemind/swarm-orchestration-plan.md` — Phase 4 escalation (auto-reassignment) partial
- `bridgemind/packetcode-mcp-server-plan.md` — Phase 1 frontend done; transport layer deferred

### MCP Provider
- `mcp-provider-transport.md` — Phases 2-3 deferred (local MCP server transport)

### Workspace UX
- `zen-workspace/features-git-workspace.md` — Phase 3 review packet ties partial
- `zen-workspace/features-prompt-library.md` — command palette integration not started
- `zen-workspace/features-project-workspaces.md` — fully done but kept for reference

### TUI
- `tui-shared-engine-plan.md` — Phase 2 pane layouts, Phase 3 structured logging/event stream not started

## Archive

`dev/archive/` contains completed planning docs preserved for historical reference:

- `archive/backlog.md`, `archive/cross-competitor-map.md`, `archive/positioning-notes.md`, `archive/priority-resolution.md`
- `archive/moat/` — memory layer, insights, deploy, scaffold, analytics, cost unification specs
- `archive/bridgemind/` — gap analysis, workspace editor scale, positioning notes
- `archive/quadcode/` — gap analysis, terminal features, AI platform features
- `archive/zen-workspace/` — workspace model plan, gap analysis, research
- `archive/vibetotext/` — sprint plan, features spec, README

## Tracks (All Implemented)

All five product tracks have been implemented:
- **W** — Workspace Foundation (workspace-per-project) ✅
- **X** — Workspace UX (templates, editor, git, prompts) ✅
- **S** — Swarm Orchestration (roles, ownership, coordination) ✅
- **M** — MCP Provider (frontend types/store/settings) ✅ (transport deferred)
- **T** — TUI Evolution (polling, search, leader key) ✅
