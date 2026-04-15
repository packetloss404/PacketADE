# Track Priority Resolution

## Implementation Status — 2026-04-15

| Track | Status | Notes |
|-------|--------|-------|
| W — Workspace Foundation | ❌ Not started | PaneConfig.projectPath exists but no runtime wiring |
| X — Workspace UX | ❌ Not started | No templates, no editor, no git dashboard |
| S — Swarm Orchestration | ❌ Not started | Task handoff primitive exists |
| M — PacketCode MCP | ❌ Not started | mcp.rs is config management only |
| T — TUI Evolution | ⚠️ Partial | Transcripts, retrospectives, git refresh done; Phase 2-3 not started |

Last updated: 2026-04-09

## Context

`dev/` contains three separate competitive research tracks:

- `dev/bridgemind/` — BridgeMind competitive research and swarm orchestration planning
- `dev/quadcode/` — QuadCode terminal and platform research
- `dev/zen-workspace/` — Zen Workspace research and workspace-per-project planning

These were created independently and initially appeared to conflict on build order. This document resolves that appearance and states a clean execution model.

## The Apparent Conflict

The BridgeMind gap analysis recommends this priority order:

1. swarm orchestration with explicit roles
2. file ownership and collision prevention
3. PacketCode MCP server capabilities
4. workspace templates and a lightweight editor surface

The Zen Workspace gap analysis recommends:

1. workspace project model
2. git workspace surface
3. prompt library UX

On the surface these look contradictory. They are not.

## Resolution: Five Independent Tracks

These are four separate product tracks that operate at different layers. They can be sequenced, parallelized, or interleaved based on team capacity.

| Track                        | Layer                                                                 | Doc                                                                          |
| ---------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **W** — Workspace Foundation | Per-workspace project context, pane binding, project path propagation | `zen-workspace/workspace-project-model-plan.md`                              |
| **X** — Workspace UX         | Templates, git surface, prompt library, pane labels                   | `zen-workspace/gap-analysis.md`, `bridgemind/workspace-editor-scale-plan.md` |
| **S** — Swarm Orchestration  | Roles, file ownership, coordination feed, escalation                  | `bridgemind/swarm-orchestration-plan.md`                                     |
| **M** — PacketCode MCP       | MCP provider exposing PacketCode state to external clients            | `bridgemind/packetcode-mcp-server-plan.md`                                   |
| **T** — TUI Evolution        | `packetcode-tui` binary and shared `packetcode_lib::core` engine      | `tui-shared-engine-plan.md`                                                  |

## Dependency Chain

```
Track W (Phase 1) → Track X (phases 1–4)
Track S → independent of W and X
Track M → independent of W, X, and S
Track T → runs parallel to all; shares core engine with GUI
```

## Recommended Execution Order

1. **Start W Phase 1** first — it changes the foundational architecture that other work depends on
2. **Start S and M in parallel** with W Phase 1 — no dependency on workspace model
3. **Begin X Phase 1** after W Phase 1 lands — workspace templates build on the project picker
4. **T runs continuous** throughout — TUI parity and shared engine improvements alongside any track

## Why W Should Go First

Workspace-per-project is a foundational change to how the app resolves context. If W is not done first:

- A workspace git panel would not know which project to query
- A workspace-scoped prompt library would resolve against the wrong project
- Swarm orchestration tasks launched from a workspace would inherit the wrong project path

Starting with W prevents retrofitting these systems later.

## Why S and M Can Run in Parallel With W

Swarm orchestration (S) operates at the flight/task layer. It does not depend on workspace project binding:

- flights exist independently of workspaces
- tasks and their roles are orthogonal to which project a workspace points at
- the coordination feed and escalation model do not require workspace project context

PacketCode MCP (M) is also independent:

- it exposes flights, tasks, memory, and reviews as MCP resources
- those resources exist at the project level but the MCP provider itself does not need workspace UI changes
- M can be designed and built before or after W lands

## Why T Runs Continuous

The TUI and shared engine affect every other track:

- any new backend command added for W, S, M, or X needs to be accessible from the TUI
- the shared `packetcode_lib::core` engine is the integration point
- TUI planning should happen in parallel so that track teams can coordinate on engine changes

## Summary

There is no conflict. The four tracks (W, X, S, M) are independent workstreams. T is a supporting track that runs alongside all of them.

Execute in this order:

1. W Phase 1 (project picker in workspace creation)
2. S and M in parallel with remaining W phases
3. X begins after W Phase 1 lands
4. T throughout all phases
