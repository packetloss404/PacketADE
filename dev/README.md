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
- `bridgemind/positioning-notes.md` — product stance notes from the BridgeMind comparison, including the local-first decision

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

- `backlog.md` — deferred ideas that should not be lost, including voice work

## Current Direction

The immediate planning focus is:

1. swarm orchestration
2. file ownership and collision prevention
3. PacketCode MCP server capabilities
4. workspace UX improvements that support multi-agent execution

Voice remains in backlog for now.

Local-first remains a strategic product principle, not a gap to close.

Competitive research currently includes BridgeMind, QuadCode, and Zen Workspace data.
