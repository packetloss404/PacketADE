# Positioning Notes

## Implementation Status — 2026-04-15

Strategic positions validated against current codebase:
- ✅ Local-first core: all features work without hosted service
- ✅ TUI as first-class: transcripts, retrospectives, git refresh working
- ✅ Windows support: Tauri v2, full Windows build pipeline
- ✅ Memory layer: session-end auto-learning active
- ❌ PacketCode MCP: not started (config management only)
- ❌ Swarm orchestration: not started
- ❌ Workspace-per-project: not started
- ❌ Voice product: not pursuing (backlogged per strategy)

Last updated: 2026-04-09

## Working Thesis

PacketCode should compete as a serious local-first orchestration tool for AI software work, not as a cloud-first product suite.

This stance applies across all three tracked competitors: BridgeMind, QuadCode, and Zen Workspace.

## Competitive Context

### BridgeMind

BridgeMind is the strongest competitor on orchestration and MCP. Its public story leans into:

- product suite packaging across BridgeSpace, BridgeVoice, BridgeMCP, BridgeSwarm
- hosted context and account flows
- cloud-connected MCP positioning
- formal swarm roles with coordinator/builder/reviewer/scout

BridgeMind's weaknesses relative to PacketCode:

- no Windows support
- no TUI
- cloud-first model means core workflows require their infrastructure
- much broader product surface than PacketCode with corresponding complexity

### QuadCode

QuadCode operates in two pieces:

- **QuadCode Terminal** (getquadcode.com): multi-agent terminal, macOS/Linux only, no Windows
- **QuadCode AI Platform** (quadcode.ai): broad creative platform including design, video, audio

QuadCode's terminal product is the most direct competitor on the multi-agent terminal use case. Its platform product is a different direction.

QuadCode's weaknesses relative to PacketCode:

- no Windows support (terminal product)
- no local-first story
- no orchestration beyond parallel pane execution
- no issue tracking, flights, or deploy pipeline
- creative platform features represent an entirely different product scope

### Zen Workspace

Zen Workspace is a newer Electron app with:

- a polished git dashboard and Monaco diff editor
- a prompt library workflow
- project management UI
- file watcher with external-change reload

Zen Workspace's weaknesses relative to PacketCode:

- no swarm orchestration
- no flights, issues, or review queue
- Electron (not Tauri), so Windows support unclear
- no TUI
- no memory layer, insights, or AI-assisted analysis
- no deploy pipeline or GitHub integration beyond git itself

## PacketCode's Competitive Position

### Where PacketCode Is Strongest

These features have no direct equivalent in any of the three competitors:

- **Flights** — top-level work organizer linking issues and sessions with status rollup
- **Kanban issue board** — built-in issue tracker with drag-and-drop columns
- **Review queue** — human-in-the-loop approval workflow
- **Deploy pipeline** — integrated deploy configuration and execution
- **Project scaffolding** — template-based project generation
- **Memory layer** — persistent AI context across sessions
- **Insights and Ideation** — AI-powered codebase analysis and idea generation
- **Cost dashboard** — track AI token usage and costs
- **Analytics** — usage analytics across sessions
- **GitHub integration** — native GitHub API integration (not just MCP)
- **TUI** — standalone Ratatui binary sharing the same orchestration engine
- **Flight orchestration** — multi-agent orchestration engine shared between GUI and TUI
- **Windows support** — full Windows support via Tauri; QuadCode terminal is macOS/Linux only

### Where PacketCode Needs to Catch Up

These are genuine gaps confirmed across all three competitor analyses:

- **Swarm orchestration** with explicit roles, file ownership, and coordination feed
- **PacketCode MCP** as a provider, not just a config manager
- **Workspace-per-project** — each workspace owns its own project context and terminals
- **Git workspace UX** — embedded diff editor and staging surface
- **Lightweight editor pane** — in-app source editing without leaving the app

### Where PacketCode Should Not Try to Compete

- **Voice product** — BridgeVoice is a dedicated voice workflow; PacketCode should not partially chase it
- **Creative production** — QuadCode AI platform covers image, video, audio; not PacketCode's domain
- **Design system generation** — entirely new feature territory; not planned
- **Cloud account ecosystems** — BridgeMind's hosted model; PacketCode's strength is local-first

## Product Principles

### Local-First Is the Core Stance

- core workflows should remain usable without a hosted service
- local state is a feature, not a temporary limitation
- privacy and workspace control should stay visible product advantages
- integrations should enhance local workflows, not replace them

### What This Means for Track M (PacketCode MCP)

PacketCode MCP should be designed as a local-first service:

- local transport by default
- project-scoped exposure
- explicit enablement in settings
- clear per-tool permissions
- no mandatory cloud dependency

Do not follow BridgeMind's cloud-connected MCP model. PacketCode's MCP advantage is that it runs locally and exposes local project state without requiring an external service.

### What This Means for Swarm Orchestration (Track S)

Swarm orchestration should feel like a local control surface:

- file ownership and collision prevention keep agents from overwriting each other
- the coordination feed is a local visibility tool, not a networked collaboration system
- escalation rules route to local review queues, not cloud threads

### What This Means for TUI (Track T)

The TUI is the purest expression of local-first:

- it runs anywhere without a display server
- it works offline
- it shares the same engine as the GUI
- improvements to `packetcode_lib::core` benefit both frontends simultaneously

## What We Are Not Optimizing For

- becoming a bundle of loosely related paid products (BridgeMind's model)
- forcing account creation into the core local workflow
- mirroring QuadCode's creative production scope
- copying Zen Workspace's UI without the underlying architectural soundness
- competing on marketing surface area instead of actual workflow quality

## Windows Advantage — A Real Differentiator to Protect

Both QuadCode (terminal product) and Zen Workspace (Electron) lack full Windows support.

PacketCode has full Windows support via Tauri. This is a genuine competitive advantage for users who work on Windows and want a native AI orchestration tool.

This advantage should not be accidental. Windows support should:

- be tested on each release
- be mentioned in product messaging
- not be broken by platform-specific code paths that only work on macOS/Linux

## Immediate Product Read

PacketCode does not need to beat BridgeMind at being BridgeMind, QuadCode at being QuadCode, or Zen at being Zen.

PacketCode needs to become the best local-first control plane for multi-agent software execution.

The features that make PacketCode unique — flights, review queue, memory layer, TUI, Windows support, deploy pipeline — are the ones that matter most. The gaps identified in competitive research are real, but closing them should always serve the local-first core stance, not abandon it.

## Relationship to Other Planning Docs

This positioning stance is the context for all other `dev/` planning docs. Specifically:

- `priority-resolution.md` — execution order is influenced by this stance; tracks that maintain local-first are higher priority
- `cross-competitor-map.md` — the map is colored by this stance; features that push toward cloud or platform dependency are lower priority
- `tui-shared-engine-plan.md` — the TUI is the purest expression of local-first; this plan should reinforce that
- `backlog.md` — items that conflict with local-first (cloud accounts, hosted-only features) stay in backlog

## Historical Note

This document was originally created in `dev/bridgemind/positioning-notes.md` based on BridgeMind research alone. It has been elevated to `dev/positioning-notes.md` because the local-first stance applies equally to all three competitors tracked in `dev/`. The original BridgeMind-specific version is kept at `dev/bridgemind/positioning-notes.md` for historical reference only.
