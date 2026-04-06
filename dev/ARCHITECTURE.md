# PacketCode Architecture Document

> Generated from source code on 2026-04-03. Every file listed was verified to exist.

---

## Table of Contents

1. [Frontend Views](#frontend-views)
2. [Frontend Stores](#frontend-stores)
3. [Frontend Components](#frontend-components)
4. [Hooks](#hooks)
5. [Libs](#libs)
6. [Types](#types)
7. [Agents](#agents)
8. [Modules](#modules)
9. [Backend Commands](#backend-commands)
10. [Backend Core](#backend-core)
11. [Backend Claude](#backend-claude)
12. [Backend TUI](#backend-tui)
13. [AppView Routing Table](#appview-routing-table)
14. [Registered Tauri Commands](#registered-tauri-commands)

---

## Frontend Views

`src/components/views/`

| File | Description |
|------|-------------|
| `WelcomeScreen.tsx` | Landing screen shown on app startup before any session is opened |
| `GitHubView.tsx` | GitHub integration panel: repos, issues, PRs, and diff viewing |
| `MemoryView.tsx` | AI memory layer UI with file map, session history, and patterns tabs |
| `ToolsView.tsx` | Settings hub: project info, agent profiles, modules, tags, issue settings, notifications |
| `InsightsView.tsx` | AI-powered insights chat interface |
| `IdeationView.tsx` | Ideation scanner that generates and displays project improvement ideas |
| `AnalyticsView.tsx` | Usage analytics dashboard: token counts, costs, model usage breakdown |
| `HistoryView.tsx` | Prompt history browser for past CLI sessions |
| `McpHubView.tsx` | MCP (Model Context Protocol) server management: add/edit/delete servers |
| `McpServerModal.tsx` | Modal dialog for creating or editing an individual MCP server config |
| `ScaffoldView.tsx` | Project template scaffolding wizard |
| `DeployView.tsx` | Deploy pipeline management: config list, terminal output, status |
| `DeployConfigModal.tsx` | Modal for creating/editing a deploy configuration |
| `DeployTerminal.tsx` | Embedded terminal output view for deploy runs |
| `CostDashboardView.tsx` | Cost tracking dashboard for AI session spending |
| `FlightsView.tsx` | Flights list view: top-level work organizer above issues |
| `FlightDeckView.tsx` | Flight Deck: detailed orchestration view for an active flight |
| `ReviewQueueView.tsx` | Pending approvals across all active flights |
| `VibeArchitectView.tsx` | AI spec-to-architecture tool (module view) |
| `PRModal.tsx` | Modal for creating GitHub pull requests |
| `SpecImportModal.tsx` | Modal for importing specs and parsing them into issue tickets |
| `DiffViewer.tsx` | Side-by-side or unified diff display component |

### Views Subdirectories

`src/components/views/flight-deck/`

| File | Description |
|------|-------------|
| `StatusStrip.tsx` | Reusable flight status count strip with badges |

`src/components/views/tools/`

| File | Description |
|------|-------------|
| `ProjectInfoCard.tsx` | Card showing project path and metadata in the Tools view |
| `AgentProfilesCard.tsx` | Card for managing agent profile configurations |
| `ModulesCard.tsx` | Card for enabling/disabling optional modules |
| `IssueSettingsCard.tsx` | Card for issue board configuration options |
| `TagListCard.tsx` | Card for managing issue/flight tag definitions |
| `NotificationSettingsCard.tsx` | Card for desktop notification preferences |

`src/components/views/ideation/`

| File | Description |
|------|-------------|
| `IdeaCard.tsx` | Card component rendering a single ideation result |
| `IdeaDetail.tsx` | Expanded detail view for a selected idea |

`src/components/views/memory/`

| File | Description |
|------|-------------|
| `FileMapTab.tsx` | Tab showing the codebase file map from memory scan |
| `SessionHistoryTab.tsx` | Tab listing summarized past session histories |
| `PatternsTab.tsx` | Tab displaying extracted code patterns |

---

## Frontend Stores

`src/stores/`

| File | Description |
|------|-------------|
| `appStore.ts` | Global app state: active view, theme, git branch, command palette, quick-start session |
| `layoutStore.ts` | Pane management: add/remove/resize panes, active pane, project path, file explorer toggle |
| `flightStore.ts` | Flight CRUD, status rollup, issue/session linking, milestone management |
| `orchestrationStore.ts` | Flight lifecycle orchestration: launch/pause/resume/cancel flights, task tracking, approval flow |
| `activityStore.ts` | Per-pane agent activity tracking: current tool, file, agent state (idle/thinking/tool_use/etc.) |
| `issueStore.ts` | Issue board state: CRUD, kanban columns, flight assignment, filtering |
| `agentStore.ts` | Agent config management: built-in agents (Claude Code, OpenCode, Codex), custom agent CRUD, detection |
| `tabStore.ts` | Session tab status tracking: idle/starting/thinking/running/waiting/done/error per session |
| `costStore.ts` | Cost entry recording and summary aggregation for AI sessions |
| `promptStore.ts` | Prompt template library: CRUD for reusable prompt templates |
| `profileStore.ts` | Agent profile management: active profile selection, default model, system prompt |
| `moduleStore.ts` | Module enable/disable state for optional features (Vibe Architect, Ideation, MCP Hub, Scaffold) |
| `statusLineStore.ts` | Status line data stores for Claude and Codex, keyed by working directory |
| `statusLineStoreUtils.ts` | Shared utilities for status line entry merging, normalization, and stale-entry filtering |
| `memoryStore.ts` | AI memory layer state: codebase scan results, session summaries, context injection |
| `githubStore.ts` | GitHub auth state and API data caching |
| `insightsStore.ts` | Insights chat message history and streaming state |
| `ideationStore.ts` | Ideation scan results and idea management |
| `historyStore.ts` | Prompt history entries loaded from backend |
| `analyticsStore.ts` | Usage analytics data: model usage, daily costs, token counts |
| `mcpStore.ts` | MCP server configuration state |
| `scaffoldStore.ts` | Project scaffolding wizard state and template selection |
| `deployStore.ts` | Deploy pipeline configurations and run state |
| `notificationStore.ts` | Desktop notification preferences: enabled, triggers, focus-only mode |

---

## Frontend Components

### Layout (`src/components/layout/`)

| File | Description |
|------|-------------|
| `TitleBar.tsx` | Custom window title bar with drag region and window controls |
| `Toolbar.tsx` | Main navigation toolbar with view buttons, session controls, and module shortcuts |
| `PaneContainer.tsx` | Split-pane container that renders terminal panes side by side |
| `SessionTabBar.tsx` | Tab bar above panes showing session names and status indicators |
| `StatusBar.tsx` | Bottom status bar with git branch, project path, and session info |
| `DropdownItem.tsx` | Reusable dropdown menu item component for toolbar menus |

### Session (`src/components/session/`)

| File | Description |
|------|-------------|
| `TerminalPane.tsx` | xterm.js terminal pane connected to a PTY backend session (composition shell) |
| `ActivityStrip.tsx` | Activity indicator strip with agent state icon and label |
| `TerminalHeader.tsx` | Pane header bar with status dot, CLI badge, restart/close buttons |
| `NewSessionModal.tsx` | Modal for creating a new CLI session with agent/model selection |
| `ClaudeStatusBar.tsx` | Status bar overlay showing Claude Code session metrics (tokens, cost, model) |
| `CodexStatusBar.tsx` | Status bar overlay showing Codex session metrics |
| `ApprovalPrompt.tsx` | Overlay prompt shown when an agent requests user approval |
| `DiffBlock.tsx` | Inline diff rendering block for session output |

### Issues (`src/components/issues/`)

| File | Description |
|------|-------------|
| `IssueBoard.tsx` | Kanban board view with drag-and-drop issue columns |
| `IssueCard.tsx` | Individual issue card rendered on the kanban board |
| `IssueDetailView.tsx` | Expanded detail panel for a selected issue |
| `NewIssueForm.tsx` | Form for creating a new issue |
| `IssueDependencyList.tsx` | Component listing issue dependencies and blockers |

### Explorer (`src/components/explorer/`)

| File | Description |
|------|-------------|
| `FileExplorer.tsx` | Dockable file tree sidebar for browsing project files |

### Common (`src/components/common/`)

| File | Description |
|------|-------------|
| `MarkdownRenderer.tsx` | Shared markdown rendering with remark-gfm support |
| `CommandPalette.tsx` | Ctrl+K command palette for quick navigation and actions |

### UI (`src/components/ui/`)

| File | Description |
|------|-------------|
| `Button.tsx` | Shared button component with theme variants |
| `Dropdown.tsx` | Generic dropdown menu component |
| `Modal.tsx` | Shared modal dialog wrapper |
| `Input.tsx` | Styled text input component |
| `ErrorBoundary.tsx` | React error boundary with fallback UI |

### Quality (`src/components/quality/`)

| File | Description |
|------|-------------|
| `CodeQualityModal.tsx` | Modal displaying code quality analysis results |
| `OverviewTab.tsx` | Quality overview tab with aggregate scores |
| `LanguagesTab.tsx` | Tab showing per-language quality breakdown |
| `ComplexityTab.tsx` | Tab showing code complexity metrics |
| `TestsTab.tsx` | Tab showing test coverage and test-related metrics |
| `DonutChart.tsx` | Donut chart visualization component for quality scores |
| `ScoreBar.tsx` | Horizontal score bar visualization component |
| `codeQualityUtils.ts` | Utility functions for quality score calculation and formatting |

---

## Hooks

`src/hooks/`

| File | Description |
|------|-------------|
| `useGitInfo.ts` | Polls git branch and status from the backend |
| `useStatusLine.ts` | Exports `useStatusLinePoller` and `useCodexStatusLinePoller` for polling CLI status data |
| `useStatusLinePollerBase.ts` | Shared base hook for periodic status line polling with interval logic |
| `useVoiceInput.ts` | Web Speech API hook for voice-to-text input |
| `usePtyStateDetector.ts` | Listens to PTY output events and detects agent state (approval, thinking, tool use) via regex patterns |

---

## Libs

`src/lib/`

| File | Description |
|------|-------------|
| `tauri.ts` | All Tauri `invoke()` wrappers — the single boundary between frontend and Rust backend |
| `colors.ts` | Label and priority color helper functions |
| `flight-colors.ts` | Flight status/priority color and label constants |
| `time.ts` | Shared time formatting utilities (relative time, durations) |
| `storage.ts` | localStorage load/save helpers with JSON serialization |
| `env.ts` | Environment detection (isDev, isProd) and dev-only logging |
| `errors.ts` | Error reporting utility with dev logging |
| `notifications.ts` | Desktop notification dispatch with debouncing and preference checks |

---

## Types

`src/types/`

| File | Description |
|------|-------------|
| `layout.ts` | PaneConfig interface for terminal pane configuration |
| `flight.ts` | Flight, FlightStatus, FlightPriority, Milestone, Task types |
| `agent.ts` | AgentConfig, AgentAdapter, AgentStateUpdate, AgentStatusPatterns interfaces |
| `statusline.ts` | StatusLineData and CodexStatusLineData interfaces |
| `github.ts` | GitHub repo, issue, PR, and diff types |
| `memory.ts` | Memory scan results, session summary, and pattern types |
| `insights.ts` | Insights chat message types |
| `ideation.ts` | Ideation idea and scan result types |
| `spec.ts` | Spec-to-tickets parsing types |
| `profiles.ts` | Agent profile configuration types |
| `modules.ts` | ModuleManifest interface for the module system |
| `mcp.ts` | MCP server configuration types |
| `scaffold.ts` | Project scaffolding template and option types |
| `deploy.ts` | Deploy configuration and run state types |
| `prompt.ts` | PromptTemplate interface |
| `cost.ts` | CostEntry and CostSummary types |

---

## Agents

`src/agents/`

| File | Description |
|------|-------------|
| `index.ts` | Re-exports all agent configs/adapters and provides `getAdapterForAgent()` factory |
| `types.ts` | Base adapter factory, pattern parser, ANSI strip helper shared across all adapters |
| `claude-code.ts` | Claude Code agent config and PTY output adapter |
| `codex.ts` | OpenAI Codex CLI agent config and PTY output adapter |
| `opencode.ts` | OpenCode agent config and PTY output adapter |
| `generic.ts` | Generic/custom agent config factory with basic exit detection |

---

## Modules

`src/modules/`

| File | Description |
|------|-------------|
| `registry.ts` | Module registry: lists all modules, provides lookup and sorted retrieval |
| `vibe-architect.ts` | Vibe Architect module manifest (AI category) |
| `ideation.ts` | Ideation module manifest (analysis category) |
| `mcp-hub.ts` | MCP Hub module manifest (integration category) |
| `scaffold.ts` | Scaffold module manifest (utility category) |

---

## Backend Commands

`src-tauri/src/commands/`

| File | Description |
|------|-------------|
| `mod.rs` | Module declarations and shared validation helpers (path validation, input size limits) |
| `pty.rs` | PTY session management: create, write, resize, kill, list, read transcript |
| `git.rs` | Git operations: branch, status, commit, push, pull, create branch, safety check |
| `github.rs` | GitHub API via reqwest: auth, repos, issues, PRs, diffs, investigation |
| `fs.rs` | Filesystem commands: directory listing, get current working directory |
| `memory.rs` | AI memory: codebase scan, session summarization, pattern extraction |
| `insights.rs` | Insights chat: ask questions with optional streaming |
| `ideation.rs` | Ideation scanner: generate improvement ideas from codebase analysis |
| `spec.rs` | Spec parser: convert specifications into structured issue tickets |
| `code_quality.rs` | Code quality analysis: language stats, complexity, test coverage scoring |
| `history.rs` | Prompt history: read past CLI session prompts from disk |
| `analytics.rs` | Usage analytics: read token/cost/session data from Claude status files |
| `mcp.rs` | MCP server config: read, write, delete server configurations |
| `scaffold.rs` | Project scaffolding: generate projects from templates, check tool availability |
| `deploy.rs` | Deploy pipeline: read and create deploy configurations |
| `orchestration.rs` | Flight orchestration engine: launch/pause/resume/cancel flights, tick loop, task tracking |
| `state.rs` | Unified persisted state: load/save full state and individual slices (flights, agents, settings, UI) |
| `agent.rs` | Agent detection: check if a CLI command is available on PATH |
| `shared.rs` | Platform helpers: Windows CREATE_NO_WINDOW flag, hide_window for std and tokio commands |

### Statusline Submodule (`src-tauri/src/commands/statusline/`)

| File | Description |
|------|-------------|
| `mod.rs` | Statusline module exports |
| `claude.rs` | Claude Code status line file reader/parser |
| `codex.rs` | Codex status line file reader/parser |
| `helpers.rs` | Shared helpers for status line file discovery and parsing |

---

## Backend Core

`src-tauri/src/core/`

| File | Description |
|------|-------------|
| `mod.rs` | Core module exports and re-exports (PtyManager, Flight, Orchestrator, etc.) |
| `pty.rs` | PTY session manager: spawn portable-pty processes, read/write, transcript logging |
| `flight.rs` | Flight data model: FlightStatus, FlightPriority, Milestone, Task structs and enums |
| `orchestrator.rs` | Orchestration engine: task scheduling, concurrency limits, flight state machine |
| `agent.rs` | Agent CLI detection: check PATH for agent binaries (with .cmd fallback on Windows) |
| `agent_config.rs` | AgentConfig struct: capabilities, tool-use patterns, model preferences |
| `git.rs` | Git operations: status, branch, commit, push, pull, branch creation, safety checks |
| `storage.rs` | Persisted state management: JSON file read/write for flights, agents, settings, UI state |
| `shared.rs` | Shared utilities: home_dir, hide_window, lock_mutex, SKIP_DIRS constant |

---

## Backend Claude

`src-tauri/src/claude/`

| File | Description |
|------|-------------|
| `mod.rs` | Claude module declaration (re-exports binary) |
| `binary.rs` | Claude CLI binary discovery: searches PATH and common install locations |

---

## Backend TUI

`src-tauri/src/tui/`

The TUI is a standalone Ratatui-based terminal application for FlightDeck orchestration.

| File | Description |
|------|-------------|
| `main.rs` | TUI entry point: terminal setup, event loop, persisted state loading |
| `app.rs` | TUI application state machine: views, key handling, session/flight management |
| `theme.rs` | Theme system: loads JSON theme files (Catppuccin, Gruvbox, Nord, Tokyo Night, etc.) |
| `command_palette.rs` | TUI command palette: fuzzy-search actions and navigation |

### TUI Views (`src-tauri/src/tui/views/`)

| File | Description |
|------|-------------|
| `mod.rs` | View module exports |
| `dashboard.rs` | Main dashboard view: flight list, status summary |
| `sessions.rs` | Session list and session detail view |
| `agents.rs` | Agent configuration browser view |
| `flight_detail.rs` | Detailed flight view with milestones and tasks |
| `flight_editor.rs` | Flight creation/editing form |
| `settings.rs` | TUI settings view |

### TUI Widgets (`src-tauri/src/tui/widgets/`)

| File | Description |
|------|-------------|
| `mod.rs` | Widget module exports |
| `markdown.rs` | Terminal markdown renderer widget |
| `diff.rs` | Diff display widget for terminal |
| `toast.rs` | Toast notification overlay widget |
| `help.rs` | Help overlay widget showing keybindings |

### TUI Themes (`src-tauri/src/tui/themes/`)

| File | Description |
|------|-------------|
| `default_dark.json` | Default dark color scheme |
| `catppuccin_mocha.json` | Catppuccin Mocha color scheme |
| `gruvbox_dark.json` | Gruvbox Dark color scheme |
| `nord.json` | Nord color scheme |
| `tokyonight.json` | Tokyo Night color scheme |

---

## AppView Routing Table

The `AppView` type is defined in `src/stores/appStore.ts`:

```typescript
type CoreView = "welcome" | "claude" | "codex" | "issues" | "flights" | "flight_deck"
              | "review_queue" | "history" | "tools" | "insights" | "github" | "memory"
              | "analytics" | "deploy" | "cost";
type AppView = CoreView | `mod:${string}`;
```

Routing is handled in `src/App.tsx` via the `OtherViewContent` switch and top-level conditionals:

| AppView Value | Component | Location |
|---------------|-----------|----------|
| `"welcome"` | `WelcomeScreen` | `src/components/views/WelcomeScreen.tsx` |
| `"claude"` | `PaneContainer` (with Claude CLI panes) | `src/components/layout/PaneContainer.tsx` |
| `"codex"` | `PaneContainer` (with Codex CLI panes) | `src/components/layout/PaneContainer.tsx` |
| `"issues"` | `IssueBoard` | `src/components/issues/IssueBoard.tsx` |
| `"flights"` | `FlightsView` | `src/components/views/FlightsView.tsx` |
| `"flight_deck"` | `FlightDeckView` | `src/components/views/FlightDeckView.tsx` |
| `"history"` | `HistoryView` | `src/components/views/HistoryView.tsx` |
| `"tools"` | `ToolsView` | `src/components/views/ToolsView.tsx` |
| `"insights"` | `InsightsView` | `src/components/views/InsightsView.tsx` |
| `"github"` | `GitHubView` | `src/components/views/GitHubView.tsx` |
| `"memory"` | `MemoryView` | `src/components/views/MemoryView.tsx` |
| `"analytics"` | `AnalyticsView` | `src/components/views/AnalyticsView.tsx` |
| `"deploy"` | `DeployView` | `src/components/views/DeployView.tsx` |
| `"cost"` | `CostDashboardView` | `src/components/views/CostDashboardView.tsx` |
| `"review_queue"` | `ReviewQueueView` | `src/components/views/ReviewQueueView.tsx` |
| `"mod:vibe-architect"` | `VibeArchitectView` | `src/components/views/VibeArchitectView.tsx` |
| `"mod:ideation"` | `IdeationView` | `src/components/views/IdeationView.tsx` |
| `"mod:mcp-hub"` | `McpHubView` | `src/components/views/McpHubView.tsx` |
| `"mod:scaffold"` | `ScaffoldView` | `src/components/views/ScaffoldView.tsx` |

Module views are resolved dynamically via `src/modules/registry.ts`. Each module manifest provides a `component` field pointing to its view component. Module views only render if the module is enabled in `moduleStore`.

---

## Registered Tauri Commands

All commands registered in `src-tauri/src/lib.rs` via `tauri::generate_handler![]`:

### PTY Sessions
- `create_pty_session` -- Spawn a new PTY session for a CLI agent
- `write_pty` -- Send input bytes to a PTY session
- `resize_pty` -- Resize a PTY terminal
- `kill_pty` -- Terminate a PTY session
- `kill_pty_and_wait` -- Terminate a PTY session and wait for process exit
- `list_pty_sessions` -- List all active PTY sessions
- `read_pty_transcript` -- Read the transcript log of a PTY session

### Git
- `get_git_branch` -- Get the current git branch name
- `get_git_status` -- Get git working tree status
- `git_commit` -- Create a git commit
- `git_push` -- Push to remote
- `git_pull` -- Pull from remote
- `git_create_branch` -- Create and checkout a new branch
- `git_safety_check` -- Check if working tree is clean and on expected branch

### Code Quality
- `analyze_code_quality` -- Run code quality analysis on the project

### Filesystem
- `list_directory` -- List files and directories at a given path
- `get_cwd` -- Get the current working directory

### Flight Orchestration
- `launch_flight` -- Start executing a flight's task graph
- `pause_flight` -- Pause an active flight
- `resume_flight` -- Resume a paused flight
- `cancel_flight` -- Cancel a flight
- `orchestration_tick` -- Advance the orchestration loop (called periodically by frontend)
- `get_orchestration_state` -- Get a snapshot of the orchestrator's runtime state
- `record_task_spawn` -- Register that a task's PTY session has been spawned
- `notify_task_complete` -- Mark a task as completed
- `notify_approval_needed` -- Signal that an agent is waiting for user approval
- `notify_approval_resolved` -- Signal that an approval prompt was resolved

### Persisted State
- `load_persisted_state` -- Load full persisted state from disk
- `save_persisted_state` -- Save full persisted state to disk
- `save_flights_slice` -- Save only the flights portion of state
- `save_agents_slice` -- Save only the agents portion of state
- `save_settings_slice` -- Save only the orchestrator settings portion of state
- `save_ui_slice` -- Save only the UI state portion
- `save_issues_slice` -- Save only the issues portion of state

### Agent Detection
- `detect_agent` -- Check if a CLI agent command is available on PATH

### Status Line
- `read_statusline_states` -- Read Claude Code status line data from disk
- `read_codex_statusline_states` -- Read Codex status line data from disk

### Spec Parsing
- `parse_spec_to_tickets` -- Parse a specification document into structured issue tickets

### Insights
- `ask_insights` -- Send a question to the insights AI (single response)
- `ask_insights_stream` -- Send a question to the insights AI (streaming)

### Ideation
- `generate_ideas` -- Generate improvement ideas from codebase analysis

### GitHub
- `github_set_token` -- Set the GitHub auth token (in-memory only)
- `github_clear_token` -- Clear the GitHub auth token
- `github_has_token` -- Check if a GitHub token is set
- `github_list_repos` -- List repositories for the authenticated user
- `github_list_issues` -- List issues for a repository
- `github_get_issue` -- Get a single issue by number
- `github_create_pr` -- Create a pull request
- `github_list_prs` -- List pull requests for a repository
- `github_get_pr_diff` -- Get the diff for a pull request
- `github_investigate_issue` -- AI-powered investigation of a GitHub issue

### Memory
- `scan_codebase_memory` -- Scan the codebase and build a file map
- `summarize_session` -- Summarize a session's transcript
- `extract_patterns` -- Extract recurring code patterns from the codebase

### History
- `read_prompt_history` -- Read prompt history entries from Claude session files

### Analytics
- `read_usage_analytics` -- Read usage analytics (tokens, costs, sessions) from disk

### MCP Servers
- `read_mcp_servers` -- Read all MCP server configurations
- `write_mcp_server` -- Create or update an MCP server configuration
- `delete_mcp_server` -- Delete an MCP server configuration

### Scaffolding
- `scaffold_project` -- Generate a new project from a template
- `check_scaffold_tools` -- Check availability of scaffolding tools (cargo, npm, etc.)

### Deploy
- `read_deploy_config` -- Read deploy pipeline configuration
- `create_deploy_config` -- Create a new deploy pipeline configuration
