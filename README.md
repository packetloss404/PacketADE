# PacketCode

**A local-first desktop IDE for orchestrating AI software work.**

PacketCode is a Tauri v2 desktop app that brings AI coding agents, planning, issue tracking, memory, deployment tooling, and workspace management into a single native environment. It is built for running real development workflows across multiple agent CLIs without leaving the app.

## What It Does

- Run multiple agent sessions side-by-side in PTY-backed panes inside a **Workspace** (your terminal-CLI command center)
- Plan and supervise larger units of work from the **Flight Deck** — a single-screen master-detail mission control
- Track issues on a kanban board and triage approvals from a review queue
- Keep project context close with memory summaries, history, GitHub integration, and AI-assisted tools
- Scaffold projects, manage MCP servers, inspect crashes, and run deploy workflows from the same UI
- Share orchestration logic between the desktop GUI and the standalone `packetcode-tui` binary

## Supported Agent CLIs

PacketCode currently includes session support for:

- Claude Code
- OpenAI Codex CLI
- Gemini CLI
- OpenCode

Each session can be launched with agent-specific arguments and model selections exposed through the UI.

## Main Features

### Workspaces — Terminal CLI Command Center

- Multi-pane terminal workflow built on `xterm.js` and `portable-pty` with a draggable mosaic tiling layout
- Live status bars for supported agent CLIs
- Per-pane model and effort overrides, bypass-permissions toggles, and broadcast-style prompts
- Workspaces can be launched directly from a flight, inheriting its objective and linked issues as context
- Pane layout presets (1×1, 1×2, 2×1, 2×2, 2×3, 3×2) live in the main toolbar when a workspace is active

### Flight Deck — Mission Control

- Single-screen master-detail layout: a status-grouped flight list on the left, the selected flight's mission control on the right
- **Attention** group automatically surfaces paused, failed, and approval-needed flights
- Live tiles for the selected flight: stat strip (cost, tokens, tasks, approvals, sessions, last update), milestones, live agents, approvals queue, and timeline
- Inline edit of title and objective; status and priority dropdowns; pause/resume/cancel lifecycle controls
- One-click **Launch Workspace** that wires the flight's agents, project path, and context into a fresh workspace
- Kanban issue tracking with priorities, labels, acceptance criteria, and flight linkage
- Standalone Review Queue view for triaging approvals across all flights

### AI Context and Tooling

- Memory scanning, session summaries, and learned-pattern extraction
- Insights chat for project-aware Q&A
- Ideation and code-quality tooling
- Spec import flows for turning rough requirements into actionable work

### GitHub and Git Workflow

- GitHub issue browsing and import
- PR creation support
- Git status, branch awareness, and safety checks surfaced through the app
- Tokens are kept in backend memory and are not persisted across restarts

### Project Operations

- MCP server management for project and global scopes
- Built-in scaffolding flows for new projects
- Deploy configuration and terminal-backed deploy runs
- Local crash report browsing and cleanup
- Analytics and cost tracking views

### Terminal UI

PacketCode also ships a Ratatui-based TUI:

- Binary: `packetcode-tui`
- Source: `src-tauri/src/tui/`
- Purpose: terminal-first access to the same orchestration engine used by the desktop app

## Tech Stack

| Layer    | Technology                   |
| -------- | ---------------------------- |
| Desktop  | Tauri v2                     |
| Frontend | React 19 + TypeScript + Vite |
| State    | Zustand                      |
| Styling  | Tailwind CSS                 |
| Terminal | xterm.js + portable-pty      |
| Backend  | Rust                         |
| Markdown | react-markdown + remark-gfm  |
| Icons    | lucide-react                 |
| Testing  | Vitest + Playwright          |

## Getting Started

### Prerequisites

- Node.js 18+
- `pnpm`
- Rust stable toolchain
- One or more supported agent CLIs installed and available on `PATH`

Examples:

- Claude Code for Claude sessions
- Codex CLI for Codex sessions
- Gemini CLI for Gemini sessions
- OpenCode for OpenCode sessions

### Install

```bash
git clone https://github.com/packetloss404/PacketCode.git
cd PacketCode
pnpm install
```

### Run The Desktop App

```bash
pnpm tauri dev
```

### Build

```bash
pnpm tauri build
```

Build artifacts are written under `src-tauri/target/release/bundle/`.

### Quality Checks

```bash
pnpm lint
pnpm test
pnpm build
pnpm e2e
```

### Rust Checks

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

### Run The TUI

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin packetcode-tui
```

### Windows Note

If Tauri builds cannot find the Rust toolchain, ensure the Rust binary path is on `PATH`.

Example:

```bash
set PATH=C:\Users\ianwalmsley\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin;%PATH%
```

## Project Layout

```text
PacketCode/
  src/
    App.tsx                    # Root app shell and view routing
    components/
      layout/                  # Title bar, toolbar, mosaic tiling, status bar
      session/                 # Terminal panes, session modals, status bars, inspect UI
      issues/                  # Kanban issue board and issue detail UI
      flights/                 # Flight Deck tiles (FlightList, FlightDetail, FlightHeaderTile, etc.)
      views/                   # First-class application views (FlightDeckView, WorkspaceView, …)
      workspace/               # Workspace creation, sidebar, and pane container UI
      common/                  # Shared presentation components
      ui/                      # Shared UI primitives
    stores/                    # Zustand stores for app, layout, flights, issues, workspaces, etc.
    modules/                   # Module registration and module metadata
    lib/                       # Tauri bindings, shared utilities, model lists, event helpers
    generated/                 # Generated TypeScript types (Rust ↔ TS DTO contract)
    hooks/                     # UI and agent interaction hooks
    types/                     # Shared TypeScript types

  src-tauri/
    src/
      lib.rs                   # Tauri app bootstrap and command registration
      commands/                # Tauri commands exposed to the frontend
      api/                     # DTO layer that decouples internal Rust types from the TS contract
      core/                    # Orchestration engine, storage, workspace, PTY core
      claude/                  # Claude CLI integration helpers
      tui/                     # Standalone packetcode-tui binary

  scripts/                     # Build and schema-check scripts
  e2e/                         # Playwright tests
  docs/                        # Documentation site assets
  public/                      # Static frontend assets
```

## Contributor Notes

- Core views are declared in `src/stores/appStore.ts`
- Tauri commands live in `src-tauri/src/commands/` and are bound in `src/lib/tauri.ts`
- App modules are registered through `src/modules/registry.ts`
- Session management is PTY-based rather than JSONL-session based
- Shared backend/frontend orchestration concepts are used by both the GUI and `packetcode-tui`

## License

PacketCode is licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
