# Dev Planning Docs

Last updated: 2026-04-09

This directory holds active product and architecture planning docs that are too detailed for the top-level `ROADMAP.md`.

`ROADMAP.md` remains the release-facing summary.

`dev/` is for:

- competitive research
- implementation planning
- backlog capture
- product positioning notes

## Documents

### BridgeMind Research

- `bridgemind/bridgemind-gap-analysis.md` — public competitive comparison focused on features BridgeMind appears to have that PacketCode does not
- `bridgemind/swarm-orchestration-plan.md` — plan for turning current flight/task orchestration into explicit multi-agent swarm behavior
- `bridgemind/packetcode-mcp-server-plan.md` — plan for evolving PacketCode from MCP config management to a true PacketCode MCP provider
- `bridgemind/workspace-editor-scale-plan.md` — plan for workspace templates, higher-density layouts, and a lightweight editor surface
- `bridgemind/positioning-notes.md` — **historical only** — see `dev/positioning-notes.md` for the current cross-competitor positioning stance

### QuadCode Research

- `quadcode/gap-analysis.md` — competitive comparison covering both the QuadCode terminal product and the broader quadcode.ai platform
- `quadcode/features-quadcode-terminal.md` — documented terminal-focused feature set from `getquadcode.com`
- `quadcode/features-quadcode-ai.md` — documented broader product/platform features from `quadcode.ai`

### Zen Workspace Research

- `zen-workspace/README.md` — index of the Zen Workspace research and planning docs
- `zen-workspace/research.md` — source summary and key findings from `riftzen-bit/zen-workspace-ide`
- `zen-workspace/features-git-workspace.md` — notes on Zen's git dashboard and diff editor
- `zen-workspace/features-prompt-library.md` — notes on Zen's prompt library workflow and PacketCode's partial overlap
- `zen-workspace/features-project-workspaces.md` — notes on Zen's project model and the PacketCode workspace opportunity
- `zen-workspace/workspace-project-model-plan.md` — implementation plan for making each PacketCode workspace own a separate project
- `zen-workspace/gap-analysis.md` — consolidated comparison and recommended build order

### Shared Planning

- `priority-resolution.md` — resolves apparent conflicts between BridgeMind and Zen workspace plans; states the five-track execution model
- `cross-competitor-map.md` — unified feature map across all three competitors; maps each gap to its plan doc and PacketCode's current state
- `positioning-notes.md` — cross-competitor local-first product stance; replaces `bridgemind/positioning-notes.md`
- `tui-shared-engine-plan.md` — plan for the `packetcode-tui` binary and the shared `packetcode_lib::core` engine
- `backlog.md` — deferred ideas that should not be lost, including voice work

### VibeToText Integration

- `vibetotext/README.md` — master plan for porting VibeToText dictation into PacketCode as a native Rust/Tauri engine, plus analytics migration to Tools page
- `vibetotext/features.md` — detailed feature spec: Rust backend (cpal, whisper-rs, rusqlite), frontend module, types, store, Tools page changes
- `vibetotext/sprint.md` — 6-sprint implementation plan with file lists and acceptance criteria per sprint

### Moat Feature Plans

These documents audit PacketCode's existing competitive advantages to identify what is solid and what has room for improvement.

- `moat/memory-layer-plan.md` — audit of the current memory layer (scan, summarize, extract)
- `moat/insights-plan.md` — audit of the Insights chat view and its relationship to the ideation scanner
- `moat/cost-dashboard-plan.md` — audit of cost tracking and the cost dashboard
- `moat/analytics-plan.md` — audit of usage analytics
- `moat/deploy-pipeline-plan.md` — audit of the deploy pipeline
- `moat/scaffold-plan.md` — audit of project scaffolding

### Implementation Specs

Each moat audit has a corresponding implementation spec with concrete code changes, data model updates, and delivery order.

- `moat/memory-layer-implementation.md` — session-end memory hooks, pattern refresh thresholds, flight-scoped memory
- `moat/insights-implementation.md` — memory context in Insights, send-to-terminal, flight-scoped sessions, Ideation bridge
- `moat/deploy-pipeline-implementation.md` — deploy execution via PTY, pre-deploy validation, log capture, flight integration
- `moat/scaffold-to-workspace-implementation.md` — scaffold result step "Create Workspace" button and workspace template picker
- `moat/cost-analytics-unification-implementation.md` — deprecate self-reported cost tracking, backend as single source of truth, per-flight attribution, cost alerts

## Current Direction

The immediate planning focus is organized into five tracks:

1. **W** — Workspace Foundation (workspace-per-project model)
2. **X** — Workspace UX (templates, git surface, prompt library)
3. **S** — Swarm Orchestration (roles, file ownership, coordination)
4. **M** — PacketCode MCP server
5. **T** — TUI Evolution (binary and shared engine)

See `priority-resolution.md` for the full dependency chain and execution order.

Voice/dictation is now actively planned — see `vibetotext/` for the full integration plan porting VibeToText into native Rust/Tauri.

Local-first remains a strategic product principle, not a gap to close.

Competitive research currently includes BridgeMind, QuadCode, and Zen Workspace data.
