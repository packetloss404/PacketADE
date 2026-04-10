# PacketCode

**A local-first desktop IDE for orchestrating AI software work.**

PacketCode is a Tauri v2 desktop app that brings AI coding agents, planning, issue tracking, memory, deployment tooling, and workspace management into a single native environment. It is built for running real development workflows across multiple agent CLIs without leaving the app.

## What It Does

- Run multiple agent sessions side-by-side in PTY-backed panes
- Manage work at several levels: sessions, issues, flights, review queues, and mission/workspace views
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

### Multi-Agent Sessions

- Multi-pane terminal workflow built on `xterm.js` and `portable-pty`
- Live status bars for supported agent CLIs
- Session inspect, transcript handling, and approval-oriented UX
- Quick-start flows from the toolbar, command palette, and flight/mission workflows

### Flights, Issues, and Supervision

- Flight planning and supervision for larger units of work
- Kanban issue tracking with priorities, labels, acceptance criteria, and flight linkage
- Review queue for items needing human attention
- Mission and workspace views for coordinating broader workstreams

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
      layout/                  # Title bar, toolbar, pane container, status bar
      session/                 # Terminal panes, session modals, status bars, inspect UI
      issues/                  # Kanban issue board and issue detail UI
      flights/                 # Flight planning and flight-related panels
      views/                   # First-class application views
      workspace/               # Workspace creation and coordination UI
      common/                  # Shared presentation components
      ui/                      # Shared UI primitives
    stores/                    # Zustand stores for app, layout, flights, issues, tools, etc.
    modules/                   # Module registration and module metadata
    lib/                       # Tauri bindings, shared utilities, model lists
    hooks/                     # UI and agent interaction hooks
    types/                     # Shared TypeScript types

  src-tauri/
    src/
      lib.rs                   # Tauri app bootstrap and command registration
      commands/                # Tauri commands exposed to the frontend
      claude/                  # Claude CLI integration helpers
      tui/                     # Standalone packetcode-tui binary

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
