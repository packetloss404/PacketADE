# PacketCode -- Project Status

**Date:** 2026-04-06

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
| Persistence (backend) | JSON file at `~/.packetcode/state.v2.json` |
| Persistence (frontend) | localStorage for UI preferences only (flights/agents/issues migrated to backend) |
| Frontend testing | vitest + jsdom + @testing-library/react |
| Backend testing | cargo test (built-in) |

---

## Architecture Overview

### Frontend Views (15 core + dynamic module views)

Routed via `AppView` union type in `appStore.ts`:

**Core views:** `welcome`, `claude`, `codex`, `workspace`, `issues`, `flights`, `flight_deck`, `review_queue`, `history`, `tools`, `insights`, `github`, `memory`, `analytics`, `deploy`, `cost`

**Module views** (dynamic `mod:{id}` pattern): `vibe-architect` (AI), `ideation` (analysis), `mcp-hub` (integration), `scaffold` (utility)

### Backend Commands (Rust, registered in lib.rs)

| Module | Commands |
|--------|----------|
| `pty.rs` | create_pty_session, write_pty, resize_pty, kill_pty, kill_pty_and_wait, list_pty_sessions, read_pty_transcript |
| `git.rs` | get_git_branch, get_git_status, git_commit, git_push, git_pull, git_create_branch, git_safety_check |
| `orchestration.rs` | launch_flight, pause_flight, resume_flight, cancel_flight, orchestration_tick, get_orchestration_state, record_task_spawn, notify_task_complete, notify_approval_needed, notify_approval_resolved |
| `state.rs` | load_persisted_state, save_persisted_state, save_flights_slice, save_agents_slice, save_settings_slice, save_ui_slice, save_issues_slice, save_workspaces_slice |
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

`flight.rs`, `orchestrator.rs`, `agent_config.rs`, `agent.rs`, `git.rs`, `pty.rs`, `storage.rs`, `shared.rs`, `workspace.rs` -- domain logic separate from Tauri command handlers.

### Zustand Stores (27 files in `src/stores/`)

`appStore`, `layoutStore`, `flightStore`, `orchestrationStore`, `issueStore`, `agentStore`, `tabStore`, `profileStore`, `memoryStore`, `insightsStore`, `githubStore`, `historyStore`, `analyticsStore`, `costStore`, `deployStore`, `mcpStore`, `scaffoldStore`, `ideationStore`, `moduleStore`, `notificationStore`, `promptStore`, `statusLineStore`, `statusLineStoreUtils`, `activityStore`, `routingStore`, `workspaceStore`, `projectHistoryStore`

---

## Sprint History

| Sprint | Focus | Status |
|--------|-------|--------|
| Sprint 0 | Security Foundations -- keyring, path traversal, CSP, async I/O | Complete |
| Sprint 1 | Control Plane Hardening -- eliminate split-brain orchestration state | Complete |
| Sprint 2 | Review Loops & Persistence -- approval workflow, audit trail, state migration v1→v2 | Complete |
| Sprint 3 | UX Polish & Test Infrastructure -- vitest/cargo test setup, TerminalPane decomposition, FlightDeck upgrade | Complete |
| Sprint 4 | Mission Workspace, Chat UI, Decomposition, Distribution | In progress (Workspaces feature shipped out-of-plan) |

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
- Persisted state via `~/.packetcode/state.v2.json` (flights, agents, settings, UI state)
- Separate TUI binary (`packetcode-tui`) using ratatui
- **FlightDeck live session indicators** -- active flights show colored dots per session state (idle/thinking/tool_use/approval_needed)
- **FlightDeck inline actions** -- pause/resume/cancel buttons on flight cards
- **FlightDeck auto-refresh** -- 5-second heartbeat polling with "last updated" indicator
- **Keyboard shortcuts for approval** -- y/n/Escape in approval overlay
- **FlightsView empty state** -- onboarding card when no flights exist
- **Tab tooltip enrichment** -- agent state, current tool, and duration on hover
- **Frontend test infrastructure** -- vitest + jsdom + @testing-library/react with Tauri mocks
- **TerminalPane partial decomposition** -- ActivityStrip.tsx and TerminalHeader.tsx extracted
- **Workspaces feature** -- isolated multi-agent grid workspaces. Symmetric CSS Grid (1×1, 1×2, 2×2, 2×3) of any combination of Terminal/Claude/Codex/Gemini/OpenCode CLIs. Each workspace owns its own PTY sessions, persists across restarts via `save_workspaces_slice`, supports broadcasting one prompt to all agents at once. Persistent right sidebar with collapsible WORKSPACES + PROJECTS sections, project history tracking, "Keep terminals alive" toggle, and Open Folder action. Two new built-in agents (Gemini CLI, Terminal). PTY allowlist expanded for shells (bash, sh, zsh, powershell, cmd) and new agents. Ctrl+Shift+W shortcut. Files: `src/components/workspace/`, `src/components/views/WorkspaceView.tsx`, `src/stores/workspaceStore.ts`, `src/stores/projectHistoryStore.ts`, `src/lib/gridLayout.ts`, `src/types/workspace.ts`, `src-tauri/src/core/workspace.rs`

### Partial

- **Module/plugin system:** 4 hardcoded modules with enable/disable, but no external plugin loading or community manifest format
- **TerminalPane decomposition:** ActivityStrip and TerminalHeader extracted; ApprovalOverlay and useTerminalSession hook still inline (601 lines remaining). Target is ~60-line composition shell
- **Test coverage:** Infrastructure is in place but coverage is still low. 122 frontend tests across 10 test files; 50 Rust tests across ~8 modules. No E2E tests

### Not Started

- Code signing and distribution (Windows SmartScreen, macOS Gatekeeper)
- E2E tests (no Playwright/WebDriver setup)
- Inline file preview from terminal output
- Session persistence and reconnection across app restarts
- Multi-model A/B comparison (dual-fire mode)
- Crash reporting (no Rust panic hook or crash viewer)
- Auto-update mechanism (no tauri-plugin-updater)

---

## Test Coverage

### Frontend

| Category | Files | Tests |
|----------|-------|-------|
| Store tests (flight, issue, tab, orchestration, persistence migration) | 5 | 82 tests |
| Component tests (ActivityIcon, StatusStrip, ReviewQueue) | 3 | 23 tests |
| Utility tests (storage, contract) | 2 | 17 tests |
| **Total** | **10** | **122 tests** |

Gate: `pnpm test` exits 0.

### Backend (Rust)

| Module | Tests (pre-Sprint 3) | Tests (post-Sprint 3) |
|--------|----------------------|-----------------------|
| statusline | 7 | 7 |
| code_quality | 6 | 6 |
| orchestrator | 2 | 2 |
| pty | 0 | see totals |
| git | 0 | see totals |
| fs | 0 | see totals |
| storage | 0 | see totals |
| flight | 0 | see totals |
| **Total** | **15** | **50 tests** |

Gate: `cargo test` in `src-tauri/` exits 0.

---

## Known Architectural Debt

### 1. TerminalPane Still Oversized

TerminalPane.tsx is 601 lines after Sprint 3 partial decomposition (down from 676). Two more extractions are needed (ApprovalOverlay, useTerminalSession hook) to reach the ~60-line composition shell target. This is the top priority for Sprint 4.

### 2. Low Test Coverage

Test infrastructure is now in place (vitest for frontend, expanded cargo test for backend), but overall coverage remains low. The 24 Zustand stores have only 3 tested. React components have only 3 test files. Rust command modules beyond statusline/code_quality/orchestrator/pty/git/fs/storage/flight still have zero tests.

### 3. Store Proliferation

24 Zustand store files with no clear boundary between "domain state" and "UI state." Several stores (e.g., `flightStore` + `orchestrationStore`, `statusLineStore` + `statusLineStoreUtils`) have overlapping concerns.

### 4. No E2E Testing

While unit/component tests now exist, there is no end-to-end test framework (Playwright, WebDriver, or Tauri's built-in test harness). Critical user flows (session creation, flight launch, approval cycle) are only tested manually.

---

*This document reflects the codebase as of 2026-04-06 (post-Workspaces feature) and is grounded in actual file contents, not planned or aspirational features.*
