# Cross-Competitor Feature Map

## Implementation Status — 2026-04-15

Recent changes since last update:
- ✅ Memory layer auto-learn: session-end hook active in useTerminalSession.ts
- ✅ TUI retrospectives: working in flight_detail.rs
- ✅ TUI session transcripts: render_transcript() in sessions.rs
- ✅ Agents tab redesigned: repo-grouped sidebar, inline input with autocomplete, SSH server selector
- ⚠️ AnalyticsView: removed from CoreView, migration to Tools incomplete
- ❌ CostDashboardView: missing from codebase
- ❌ InsightsView: backend ready, frontend missing
- ❌ ScaffoldView: missing from codebase
- ❌ Broadcast mode: deliberately removed in v0.4.0
- ✅ Tracks W, X, S, M: all implemented

Last updated: 2026-04-09

This document maps every significant feature claimed by BridgeMind, QuadCode, and Zen Workspace against PacketCode's current implementation state. It serves as a navigable index into the relevant `dev/` plan docs.

## How to Read This

- ✅ Implemented — PacketCode has this today
- ⚠️ Partial — PacketCode has something in this area but it is incomplete relative to the competitor claim
- ❌ Missing — PacketCode does not have this
- 📋 Plan doc exists — see the linked `dev/` document for the planned response

## Comparison Table

| Feature                                                 | BridgeMind                 | QuadCode                    | Zen Workspace  | PacketCode State | Plan Doc                                        |
| ------------------------------------------------------- | -------------------------- | --------------------------- | -------------- | ---------------- | ----------------------------------------------- |
| Multi-agent terminal grids                              | Bridgespace                | QuadCode Terminal (4 panes) | Zen Workspaces | ✅               | —                                               |
| Broadcast mode (one prompt → all panes)                 | —                          | ✅ getquadcode.com          | —              | ❌               | No plan — deprioritized                         |
| Per-session accent colors                               | —                          | ✅                          | —              | ✅               | `quadcode/gap-analysis.md`                      |
| Pane zoom-to-focus                                      | —                          | ✅                          | —              | ✅               | `quadcode/gap-analysis.md`                      |
| Named workspace presets                                 | ✅ Bridgespace             | —                           | —              | ❌               | `bridgemind/workspace-editor-scale-plan.md`     |
| Lightweight embedded editor                             | ✅ BridgeCode (pre-launch) | ✅                          | —              | ❌               | `bridgemind/workspace-editor-scale-plan.md`     |
| Monaco diff editor                                      | —                          | —                           | ✅             | ❌               | `zen-workspace/features-git-workspace.md`       |
| Git dashboard with staging UI                           | ✅ Bridgespace             | —                           | ✅             | ❌               | `zen-workspace/features-git-workspace.md`       |
| AI-generated commit messages                            | ✅                         | ✅                          | ✅             | ❌               | `zen-workspace/features-git-workspace.md`       |
| Prompt library (live, not just templates)               | —                          | —                           | ✅             | ⚠️               | `zen-workspace/features-prompt-library.md`      |
| Prompt templates (stored)                               | —                          | —                           | —              | ✅               | Already implemented in `promptStore.ts`         |
| Project list with pinned/recent                         | ✅                         | ✅                          | ✅             | ⚠️               | `zen-workspace/features-project-workspaces.md`  |
| Workspace owns project path                             | —                          | —                           | ⚠️             | ⚠️               | `zen-workspace/workspace-project-model-plan.md` |
| Global project context                                  | ✅                         | ✅                          | ✅             | ✅ (global only) | `zen-workspace/workspace-project-model-plan.md` |
| Multi-model support                                     | ✅ (BridgeMCP)             | ✅                          | —              | ✅               | `quadcode/gap-analysis.md`                      |
| Formal swarm roles (coordinator/builder/reviewer/scout) | ✅ BridgeSwarm             | —                           | —              | ❌               | `bridgemind/swarm-orchestration-plan.md`        |
| File ownership and collision prevention                 | ✅ BridgeSwarm             | —                           | —              | ❌               | `bridgemind/swarm-orchestration-plan.md`        |
| Inter-agent coordination surface                        | ✅ BridgeSwarm             | —                           | —              | ❌               | `bridgemind/swarm-orchestration-plan.md`        |
| Escalation and blocked-task routing                     | ✅ BridgeSwarm             | —                           | —              | ❌               | `bridgemind/swarm-orchestration-plan.md`        |
| MCP provider (exposes own state)                        | ✅ BridgeMCP               | —                           | —              | ❌               | `bridgemind/packetcode-mcp-server-plan.md`      |
| MCP config management                                   | —                          | —                           | —              | ✅               | Already implemented in `commands/mcp.rs`        |
| Voice dictation (desktop-wide)                          | ✅ BridgeVoice             | —                           | —              | ❌               | `backlog.md` (B-VOICE-001)                      |
| Voice input (in-app only)                               | —                          | —                           | —              | ✅               | `hooks/useVoiceInput.ts`                        |
| Specialized agent roles (Developer/Designer/etc)        | —                          | ✅ quadcode.ai              | —              | ⚠️               | `quadcode/gap-analysis.md`                      |
| Design system generation                                | —                          | ✅                          | —              | ❌               | `quadcode/gap-analysis.md`                      |
| AI image generation                                     | —                          | ✅                          | —              | ❌               | `quadcode/gap-analysis.md`                      |
| Video/motion production                                 | —                          | ✅                          | —              | ❌               | Not planned                                     |
| Audio production                                        | —                          | ✅                          | —              | ❌               | Not planned                                     |
| MCP integration catalog (Figma/Notion/Slack/etc)        | —                          | ✅                          | —              | ⚠️               | `quadcode/gap-analysis.md`                      |
| File watcher with external-change reload                | —                          | —                           | ✅             | ❌               | `zen-workspace/features-project-workspaces.md`  |
| Multi-project management UI                             | —                          | —                           | ✅             | ⚠️               | `zen-workspace/features-project-workspaces.md`  |
| Windows support                                         | —                          | ❌ (macOS/Linux only)       | —              | ✅               | Advantage not currently documented              |
| TUI binary                                              | —                          | —                           | —              | ✅               | `tui-shared-engine-plan.md`                     |
| Shared orchestration engine (GUI + TUI)                 | —                          | —                           | —              | ✅               | `tui-shared-engine-plan.md`                     |
| Flights (top-level work organizer)                      | —                          | —                           | —              | ✅               | No competitor equivalent                        |
| Kanban issue board                                      | —                          | —                           | —              | ✅               | No competitor equivalent                        |
| Deploy pipeline                                         | —                          | —                           | —              | ✅               | `moat/deploy-pipeline-plan.md`                  |
| Memory layer (persistent AI context)                    | —                          | —                           | —              | ✅               | `moat/memory-layer-plan.md`                     |
| Insights and Ideation (AI codebase analysis)            | —                          | —                           | —              | ✅               | `moat/insights-plan.md`                         |
| Cost dashboard (token usage tracking)                   | —                          | —                           | —              | ✅               | `moat/cost-dashboard-plan.md`                   |
| Analytics (usage tracking)                              | —                          | —                           | —              | ✅               | `moat/analytics-plan.md`                        |
| Project scaffolding                                     | —                          | —                           | —              | ✅               | `moat/scaffold-plan.md`                         |
| GitHub integration (native API)                         | —                          | —                           | —              | ✅               | No competitor equivalent                        |
| Review queue                                            | —                          | —                           | —              | ✅               | No competitor equivalent                        |
| Session inspect and transcript handling                 | —                          | —                           | —              | ✅               | No competitor equivalent                        |
| Agent profiles                                          | —                          | —                           | —              | ✅               | `profileStore.ts`                               |
| Keep-terminals-alive toggle                             | —                          | —                           | —              | ✅               | `workspaceStore.ts`                             |

## Competitor Summary

### BridgeMind — strongest on swarm and orchestration

- Has formal swarm model with roles, file ownership, escalation
- Has a real MCP provider
- Has a voice product
- Weak on: local-first positioning, Windows support, TUI

### QuadCode — strongest on multi-model and creative scope

- Has broad model support (GPT, Claude, Gemini, DeepSeek, Grok, GLM)
- Has creative production (image, video, audio)
- Has broad MCP integration catalog
- Weak on: no Windows support for terminal product, no local-first story, no orchestration beyond multi-pane

### Zen Workspace — strongest on git UX and project model

- Has a polished git dashboard and Monaco diff editor
- Has a prompt library workflow
- Has project list with pinned/recent
- Weak on: Electron/Tauri architecture unclear, no swarm model, no orchestration

## Features With No Plan Doc

These gaps were identified across all three competitor analyses but have no `dev/` plan doc yet:

| Gap                             | Competitor | Priority note                                     |
| ------------------------------- | ---------- | ------------------------------------------------- |
| Per-session accent colors       | QuadCode   | Small effort, worth doing                         |
| Pane zoom-to-focus              | QuadCode   | Small effort, worth doing                         |
| File watcher with reload        | Zen        | Needed for workspace-per-project to feel complete |
| Multi-project management UX     | Zen        | Partial overlap with existing project history     |
| Broader MCP integration catalog | QuadCode   | Medium effort, mostly config                      |
| Specialized agent role profiles | QuadCode   | Large effort, depends on swarm work               |
| Design system generation        | QuadCode   | Entirely new domain, low priority                 |
| Windows advantage documentation | —          | Not tracked in any doc currently                  |

See `backlog.md` for items that are explicitly not being pursued.

## How to Use This Doc

Use this as a lookup when deciding what to build next:

1. Find the feature you are interested in
2. Check PacketCode's current state
3. If there is a plan doc linked, read that doc
4. If there is no plan doc and it is marked as a priority, create one following the moat doc pattern in `dev/moat/`

This doc is the entry point to the rest of `dev/`. The individual competitor research folders contain the detailed evidence; this doc is the map.
