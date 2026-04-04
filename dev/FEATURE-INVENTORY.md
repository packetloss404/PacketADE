# PacketCode Feature Inventory

**Date:** 2026-04-03
**Method:** Direct codebase inspection of source files, stores, views, and Rust backend modules

---

## Core IDE Features

| Feature | Status | Evidence | Notes |
|---------|--------|----------|-------|
| Multi-pane terminal (PTY) | Working | `src-tauri/src/core/pty.rs`, `src/stores/layoutStore.ts` | PTY-based sessions with xterm.js; create/write/resize/kill all wired up |
| Claude Code integration | Working | `src/agents/claude-code.ts`, `appStore.ts` (view: `"claude"`) | Launches via PTY with `.cmd` wrapper on Windows |
| Codex CLI integration | Working | `src/agents/codex.ts`, `appStore.ts` (view: `"codex"`) | Same PTY architecture as Claude |
| OpenCode agent | Working | `src/agents/opencode.ts`, `src/stores/agentStore.ts` | Third agent adapter with install detection |
| Generic agent support | Working | `src/agents/generic.ts`, `getAdapterForAgent()` in `src/agents/index.ts` | Fallback adapter for custom agent configs |
| Session tab bar | Working | `src/components/layout/SessionTabBar`, `src/stores/tabStore.ts` | Manages multiple concurrent sessions |
| File explorer | Working | `src/components/explorer/FileExplorer.tsx`, `src-tauri/src/commands/fs.rs` | Floating panel, lazy directory listing from Rust backend |
| Issue tracker (Kanban) | Working | `src/components/issues/`, `src/stores/issueStore.ts` | Full CRUD, status columns, linked to flights |
| Command palette | Working | `src/components/common/CommandPalette.tsx`, `appStore.ts` | Keyboard-triggered, search + action dispatch across all views/modules |
| Theme toggle (dark/light) | Working | `appStore.ts` (`theme`, `setTheme`), `Toolbar.tsx` (Sun/Moon icons) | Toolbar button toggles dark/light |
| Welcome screen | Working | `src/components/views/WelcomeScreen.tsx` | Default view on app launch |
| Project path selector | Working | `Toolbar.tsx` + `@tauri-apps/plugin-dialog`, `layoutStore.ts` | Native dialog for choosing project root |
| Agent profiles | Working | `src/stores/profileStore.ts`, `AgentProfilesCard.tsx` | Model selection, system prompt injection, profile switching |
| Code quality analysis | Working | `src/components/quality/CodeQualityModal.tsx`, `src-tauri/src/commands/code_quality.rs` | Modal with overview/languages/complexity/tests tabs |
| History view | Working | `src/components/views/HistoryView.tsx`, `src/stores/historyStore.ts` | Prompt history and active sessions tabs |
| Spec-to-tickets import | Working | `src/components/views/SpecImportModal.tsx`, `src-tauri/src/commands/spec.rs` | AI parses spec text to ticket candidates |
| Notification preferences | Partial | `src/stores/notificationStore.ts`, `NotificationSettingsCard.tsx` | Preferences stored; OS-level dispatch not verified |

## AI Features

| Feature | Status | Evidence | Notes |
|---------|--------|----------|-------|
| Streaming insights (chat) | Working | `src/stores/insightsStore.ts`, `InsightsView.tsx`, `src-tauri/src/commands/insights.rs` | Multi-session chat with streaming via Tauri events |
| Voice input | Working | `src/hooks/useVoiceInput.ts`, used in `InsightsView.tsx` | Web Speech API; browser-dependent; wired into Insights |
| Memory layer | Working | `src/stores/memoryStore.ts`, `MemoryView.tsx` (FileMap, SessionHistory, Patterns), `src-tauri/src/commands/memory.rs` | Context injected into sessions via `getContextForSession()` |
| Ideation scanner | Working | `src/stores/ideationStore.ts`, `IdeationView.tsx`, `src-tauri/src/commands/ideation.rs` | AI idea generation with type filtering |
| Vibe Architect | Working | `VibeArchitectView.tsx`, `src/modules/vibe-architect` | Embeds external specs-gen app; includes spec import |
| Cost dashboard | Working | `src/stores/costStore.ts`, `CostDashboardView.tsx` | 7-day chart, summary stats; frontend-only cost tracking |
| Analytics view | Working | `src/stores/analyticsStore.ts`, `AnalyticsView.tsx` | Usage analytics with model usage and daily cost |

## Orchestration & Flights

| Feature | Status | Evidence | Notes |
|---------|--------|----------|-------|
| Flights (work organizer) | Working | `src/stores/flightStore.ts`, `FlightsView.tsx`, `src/types/flight.ts` | Full CRUD; milestones with tasks; status rollup; bidirectional backend sync |
| FlightDeck overview | Working | `FlightDeckView.tsx` | Status strip, attention cards, click-through to flight detail |
| Orchestration engine (Rust) | Working | `src-tauri/src/core/orchestrator.rs` | Dependency resolution, task queuing, milestone gating, parallel session limits |
| Orchestration store (TS) | Working | `src/stores/orchestrationStore.ts` | Launch/pause/resume/cancel; tick loop; hydrate from backend |
| Backend persistence | Working | `src-tauri/src/core/storage.rs` | `state.v1.json` with flights, agents, settings, UI state |
| Task scheduling loop | Partial | `orchestrationStore.ts` (`startLoop`/`stopLoop`/`tick`) | Control flow exists; end-to-end autonomous task execution needs validation |
| Agent config management | Working | `src/stores/agentStore.ts`, `src-tauri/src/core/agent_config.rs` | Built-in + custom agents; install detection; backend sync |

## DevOps & Integration

| Feature | Status | Evidence | Notes |
|---------|--------|----------|-------|
| Git operations | Working | `src-tauri/src/core/git.rs`, `src-tauri/src/commands/git.rs` | Branch create, status, commit (no stage-all), push (protected branch guard), pull (ff-only) |
| Git safety checks | Working | `src-tauri/src/core/git.rs` (`GitSafetyReport`) | Upstream tracking, clean worktree, behind-upstream, protected branch warning |
| GitHub integration | Working | `src/stores/githubStore.ts`, `GitHubView.tsx`, `src-tauri/src/commands/github.rs` | Auth, repo listing, issue fetching, investigation, PR creation |
| PR review (create + diff) | Working | `PRModal.tsx`, `DiffViewer.tsx` | PR creation modal; unified diff viewer |
| MCP Hub | Working | `src/stores/mcpStore.ts`, `McpHubView.tsx`, `src-tauri/src/commands/mcp.rs` | CRUD for MCP server configs; global vs project scope |
| Scaffold (project templates) | Working | `src/stores/scaffoldStore.ts`, `ScaffoldView.tsx`, `src-tauri/src/commands/scaffold.rs` | Template selection, directory picker, execution |
| Deploy view | Working | `src/stores/deployStore.ts`, `DeployView.tsx`, `DeployTerminal.tsx`, `src-tauri/src/commands/deploy.rs` | Deploy config management + terminal output |
| Module system | Working | `src/modules/registry.ts`, `src/stores/moduleStore.ts` | 4 modules (vibe-architect, ideation, mcp-hub, scaffold); enable/disable |

## Planned / Not Started

| Feature | Status | Evidence | Notes |
|---------|--------|----------|-------|
| Code signing | Not Started | No signing config in `tauri.conf.json` | Blocks public distribution |
| Automated testing | Not Started | No test files in project source | Zero tests; no runner configured |
| Inline file preview | Not Started | No preview component exists | Explorer has no preview/editor |
| Session persistence (across restarts) | Not Started | PTY sessions ephemeral | UI state persisted but not session content |
| Multi-model A/B testing | Not Started | Profiles support model choice but no A/B UI | No comparison mode |
| Plugin system (third-party) | Not Started | Module registry internal only | No external plugin loading |
| Mission Workspace | Not Started | `dev/nextgen/` spec only | No unified planning+execution view |
| Sessions Inspect | Not Started | No inspect/replay UI | No session detail panel |
| Persistence migration | Not Started | No SQLite/migration system | Frontend/backend persistence split |
| Test harness | Not Started | No test infrastructure | No vitest, no Playwright |

---

## Summary

| Category | Working | Partial | Not Started |
|----------|---------|---------|-------------|
| Core IDE Features | 15 | 1 | 0 |
| AI Features | 7 | 0 | 0 |
| Orchestration & Flights | 6 | 1 | 0 |
| DevOps & Integration | 8 | 0 | 0 |
| Planned / Not Started | 0 | 0 | 10 |
| **Total** | **36** | **2** | **10** |

### Key Observations

1. **The codebase is substantially more complete than DEFERRED_WORK.md suggests.** That document lists 7 features as implemented, but the actual count of working features is 36.

2. **The orchestration engine is real.** Both the Rust backend (`orchestrator.rs` with dependency resolution, milestone gating) and the TypeScript store (`orchestrationStore.ts` with full lifecycle management) are substantive implementations, not stubs.

3. **Git safety is genuinely robust.** Protected branch guards, stage-all disabled, clean-worktree checks before push/pull, upstream tracking validation, and a structured `GitSafetyReport` -- this is production-grade defensive code.

4. **Zero test coverage is a real risk.** No test files exist in the project source. For an app with 36 working features and a Rust + TypeScript dual stack, this is the single biggest gap.

5. **Session persistence remains the key UX gap.** PTY sessions are fully ephemeral. Backend persistence covers flights, agents, and settings, but not session content or history across app restarts.

6. **The "partial" items are genuinely partial, not broken.** Task scheduling loop has the control flow but end-to-end autonomous task execution needs more validation. Notification preferences are stored but OS-level dispatch is unverified.
