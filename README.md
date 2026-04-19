# PacketADE

**A local-first desktop ADE (Agent Development Environment) for orchestrating AI software work.**

PacketADE is a Tauri v2 desktop app that brings AI coding agents, planning, issue tracking, memory, deployment tooling, and workspace management into a single native environment. It is built for running real development workflows across multiple agent CLIs without leaving the app.

## What It Does

- Run multiple agent sessions side-by-side in PTY-backed panes inside a **Workspace** (your terminal-CLI command center)
- Plan and supervise larger units of work from the **Flight Deck** — a single-screen master-detail mission control
- Track issues on a kanban board and send them directly to workspace sessions
- Connect to remote servers via SSH and run agent sessions over the wire
- Keep project context close with auto-learning memory, history, and GitHub integration
- Manage MCP servers, inspect crashes, and run deploy workflows from the same UI

> Looking for a terminal-native orchestration experience? See [**FlightDeck**](https://github.com/packetloss404/flightdeck) — the TUI-first sibling project, split out of this repo and evolving independently.

## Supported Agent CLIs

PacketADE currently includes session support for:

- Claude Code
- OpenAI Codex CLI
- Gemini CLI
- OpenCode

Each session can be launched with agent-specific arguments and model selections exposed through the UI.

## Main Features

### Workspaces — Terminal CLI Command Center

- Multi-pane terminal workflow built on `xterm.js` and `portable-pty` with a draggable mosaic tiling layout
- Live status bars for supported agent CLIs
- Per-pane model and effort overrides, bypass-permissions toggles
- Agent profile system for reusable agent configurations
- Pane layout presets (1×1, 1×2, 2×1, 2×2, 2×3, 3×2) live in the main toolbar when a workspace is active

### Flight Deck — Mission Control

- Single-screen master-detail layout: a status-grouped flight list on the left, the selected flight's mission control on the right
- **Attention** group automatically surfaces paused, failed, and approval-needed flights
- Live tiles for the selected flight: stat strip (cost, tokens, tasks, approvals, sessions, last update), milestones, live agents, approvals queue, and timeline
- Inline edit of title and objective; status and priority dropdowns; pause/resume/cancel lifecycle controls
- Kanban issue tracking with priorities, labels, acceptance criteria, and flight linkage
- Standalone Review Queue view for triaging approvals across all flights

### SSH Remote Workspaces

- Add and manage remote servers with SSH agent, key, or password authentication
- Auto-detect and install agent CLIs on remote servers (Claude Code, OpenCode)
- Create workspaces that run agent sessions over SSH on remote machines
- Password authentication via in-app prompt (never saved to disk)

### Issues — Work on This Issue

- Kanban board with drag-and-drop columns (To Do, In Progress, QA, Done, Blocked, Needs Human)
- Click "Work on this issue" to send the issue prompt to an existing workspace session
- Or create a new workspace named after the project with the issue pre-loaded
- Acceptance criteria, dependency graphs, flight assignment, labels, and priorities

### Memory — Auto-Learning System

- Automatically learns from completed sessions: reads PTY transcripts, summarizes via Claude, extracts reusable patterns
- Learned patterns with confidence scores and categories (architecture, convention, preference, pitfall)
- Live context injection into workspace sessions (patterns + lessons + recent summaries)
- Per-project scoping with bounded context to avoid token overflow

### Ideation Scanner

- AI-powered codebase analysis that generates improvement ideas across categories (code quality, security, performance, documentation, UI/UX)
- Per-workspace scoping — each workspace gets its own scan results
- Convert ideas directly to issues on the kanban board

### GitHub Integration

- GitHub PAT authentication stored in OS keyring
- Repository listing and selection
- Issue browsing with search, labels, and import-to-board
- Pull request browsing with diff viewer
- AI investigation of issues via Claude

### Project Operations

- MCP server management (global and project scope) in the Tools page
- Deploy configuration and terminal-backed deploy runs
- Local crash report browsing and cleanup
- Agent profile management and AI routing configuration
- Prompt template library

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

### Windows Note

If Tauri builds cannot find the Rust toolchain, ensure the Rust binary path is on `PATH`.

Example:

```bash
set PATH=C:\Users\ianwalmsley\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin;%PATH%
```

## Project Layout

```text
PacketADE/
  src/
    App.tsx                    # Root app shell and view routing
    components/
      layout/                  # Title bar, toolbar, mosaic tiling, status bar
      session/                 # Terminal panes, session modals, status bars, inspect UI
      issues/                  # Kanban issue board and issue detail UI
      flights/                 # Flight Deck tiles (FlightList, FlightDetail, FlightHeaderTile, etc.)
      views/                   # First-class application views (FlightDeckView, WorkspaceView, …)
      workspace/               # Workspace creation, sidebar, and pane container UI
      servers/                 # SSH server form modal
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
- Backend orchestration concepts (Flights, PTY sessions, agent configs) are mirrored by FlightDeck, PacketADE's sibling TUI project in a separate repo
- GitHub PAT is stored in the OS keyring via the `keyring` crate
- SSH passwords are prompted at connect time and held in memory only

## License

PacketADE is licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
