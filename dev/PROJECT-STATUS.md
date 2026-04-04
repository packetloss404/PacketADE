# PacketCode -- Project Status

**Date:** 2026-04-03

---

## What PacketCode Is

PacketCode is a Tauri v2 desktop IDE that wraps Claude Code and OpenAI Codex CLI into a unified multi-pane development environment. It provides PTY-based terminal sessions, a Kanban issue tracker, a flight-based work organizer with orchestrated task scheduling, GitHub integration, AI memory/insights layers, agent profiles, MCP server management, project scaffolding, and a deploy pipeline -- all in a single native application. The project is at version 0.1.0.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop framework | Tauri v2 (Rust backend + webview frontend) |
| Frontend | React 19 + TypeScript + Vite 6 |
| State management | Zustand 5 (24 store files) |
| Styling | Tailwind CSS 3 with custom dark/light theme tokens |
| Terminal | xterm.js 6 + portable-pty 0.8 |
| Icons | lucide-react |
| Markdown | react-markdown + remark-gfm |
| HTTP (Rust) | reqwest 0.12 with rustls-tls |
| TUI binary | ratatui 0.29 + crossterm 0.28 (separate `packetcode-tui` binary) |
| Logging | tracing + tracing-subscriber + tracing-appender (daily rolling file) |
| Persistence (backend) | JSON file at `~/.packetcode/state.v1.json` |
| Persistence (frontend) | localStorage under `packetcode:*` keys |

---

## Architecture Overview

### Frontend Views (14 core + dynamic module views)

Routed via `AppView` union type in `appStore.ts`:

**Core views:** `welcome`, `claude`, `codex`, `issues`, `flights`, `flight_deck`, `history`, `tools`, `insights`, `github`, `memory`, `analytics`, `deploy`, `cost`

**Module views** (dynamic `mod:{id}` pattern): `vibe-architect` (AI), `ideation` (analysis), `mcp-hub` (integration), `scaffold` (utility)

### Backend Commands (Rust, registered in lib.rs)

| Module | Commands |
|--------|----------|
| `pty.rs` | create_pty_session, write_pty, resize_pty, kill_pty, kill_pty_and_wait, list_pty_sessions, read_pty_transcript |
| `git.rs` | get_git_branch, get_git_status, git_commit, git_push, git_pull, git_create_branch, git_safety_check |
| `orchestration.rs` | launch_flight, pause_flight, resume_flight, cancel_flight, orchestration_tick, get_orchestration_state, record_task_spawn, notify_task_complete, notify_approval_needed, notify_approval_resolved |
| `state.rs` | load_persisted_state, save_persisted_state, save_flights_slice, save_agents_slice, save_settings_slice, save_ui_slice |
| `github.rs` | github_set_token, github_clear_token, github_has_token, github_list_repos, github_list_issues, github_get_issue, github_create_pr, github_list_prs, github_get_pr_diff, github_investigate_issue |
| `memory.rs` | scan_codebase_memory, summarize_session, extract_patterns |
| `insights.rs` | ask_insights, ask_insights_stream |
| `statusline/` | read_statusline_states, read_codex_statusline_states |
| `fs.rs` | list_directory, get_cwd |
| `code_quality.rs` | analyze_code_quality |
| `spec.rs` | parse_spec_to_tickets |
| `ideation.rs` | generate_ideas |
| `history.rs` | read_prompt_history |
| `analytics.rs` | read_usage_analytics |
| `mcp.rs` | read_mcp_servers, write_mcp_server, delete_mcp_server |
| `scaffold.rs` | scaffold_project, check_scaffold_tools |
| `deploy.rs` | read_deploy_config, create_deploy_config |
| `agent.rs` | detect_agent |

### Core Rust Modules (`src-tauri/src/core/`)

`flight.rs`, `orchestrator.rs`, `agent_config.rs`, `agent.rs`, `git.rs`, `pty.rs`, `storage.rs`, `shared.rs` -- domain logic separate from Tauri command handlers.

### Zustand Stores (24 files in `src/stores/`)

`appStore`, `layoutStore`, `flightStore`, `orchestrationStore`, `issueStore`, `agentStore`, `tabStore`, `profileStore`, `memoryStore`, `insightsStore`, `githubStore`, `historyStore`, `analyticsStore`, `costStore`, `deployStore`, `mcpStore`, `scaffoldStore`, `ideationStore`, `moduleStore`, `notificationStore`, `promptStore`, `statusLineStore`, `statusLineStoreUtils`, `activityStore`

---

## Current State

### Working

- PTY-based terminal sessions for Claude Code and Codex CLI (multi-pane, split, resize)
- File explorer (docked sidebar with directory listing)
- Kanban issue board with flight linkage
- Flights work organizer (CRUD, status rollup, milestone/task hierarchy)
- Flight orchestration engine in Rust (launch, pause, resume, cancel, tick-based scheduling)
- Git operations: branch, status, commit, push, pull, create branch, safety check
- GitHub integration: repos, issues, PRs, PR diff viewer, issue investigation
- AI memory layer (codebase scan, session summarize, pattern extraction)
- Insights chat with streaming responses
- Status line polling for both Claude and Codex
- Command palette (Ctrl+K)
- Dark/Light theme toggle
- Code quality analysis modal
- Spec-to-tickets parser
- Ideation scanner
- MCP server management (read/write/delete config)
- Project scaffolding
- Deploy pipeline config
- Cost tracking dashboard
- Prompt history + usage analytics views
- Agent profiles with model selection and system prompts
- Keyboard shortcuts (Ctrl+B explorer, Ctrl+\ split, Ctrl+1-4 pane switch, Ctrl+Shift+1-6 view switch)
- Persisted state via `~/.packetcode/state.v1.json` (flights, agents, settings, UI state)
- Separate TUI binary (`packetcode-tui`) using ratatui

### Partial

- **Module/plugin system:** 4 hardcoded modules with enable/disable, but no external plugin loading or community manifest format
- **Persistence:** Split between Rust JSON file (flights/agents/settings) and frontend localStorage (pane count, project path, issue data). No unified persistence strategy
- **FlightDeck orchestration frontend:** `orchestrationStore.ts` mirrors Rust orchestrator state -- dual state management with sync via `orchestration_tick` and `get_orchestration_state` commands

### Not Started

- Code signing and distribution (Windows SmartScreen, macOS Gatekeeper -- Phase 9)
- Frontend tests (zero test files; no vitest configured)
- E2E tests (no Playwright/WebDriver setup)
- Secure storage (GitHub token is plaintext; no OS keychain integration)
- Inline file preview from terminal output
- Session persistence and reconnection across app restarts
- Multi-model A/B comparison (dual-fire mode)
- Crash reporting (no Rust panic hook or crash viewer)
- Auto-update mechanism (no tauri-plugin-updater)

---

## Known Architectural Debt

### 1. Split-Brain Orchestration State

The frontend `orchestrationStore.ts` maintains its own `runningTasks`, `activeFlightIds`, `pausedAtMilestone`, and scheduling logic (Map/Set-based). The Rust backend `core/orchestrator.rs` maintains a parallel `Orchestrator` struct with its own `RunningTask` tracking. Synchronization happens via periodic `orchestration_tick` calls and `get_orchestration_state` snapshots, but there is no single source of truth. If the frontend and backend diverge (missed tick, stale cache), flight status can become inconsistent.

### 2. Dual Persistence Systems

- **Rust side:** `~/.packetcode/state.v1.json` stores flights, agents, orchestrator settings, and UI state. Loaded/saved via `storage.rs` with a file-level mutex.
- **Frontend side:** localStorage under `packetcode:*` keys stores pane count, project path, issue board data, module enable/disable state, and other UI preferences.
- There is no migration or reconciliation mechanism between the two. Issue data lives only in localStorage (via `issueStore`) while flights live in the JSON file, despite issues being linked to flights.

### 3. Zero Frontend Tests

No test framework is configured. No `vitest`, no `@testing-library/react`, no test script in `package.json`. The 24 Zustand stores and all React components have zero test coverage.

### 4. Rust Test Coverage

Only 4 files contain `#[cfg(test)]` blocks: `core/orchestrator.rs`, `commands/code_quality.rs`, `commands/statusline/mod.rs`, `commands/statusline/codex.rs`. The remaining 15+ command modules and 8 core modules have no tests.

### 5. No Secure Secret Storage

GitHub tokens are stored in plaintext (backend memory, not persisted -- but no keychain integration either). No `zeroize` crate usage for sensitive data in memory.

### 6. Store Proliferation

24 Zustand store files with no clear boundary between "domain state" and "UI state." Several stores (e.g., `flightStore` + `orchestrationStore`, `statusLineStore` + `statusLineStoreUtils`) have overlapping concerns.

---

*This document reflects the codebase as of 2026-04-03 and is grounded in actual file contents, not planned or aspirational features.*
