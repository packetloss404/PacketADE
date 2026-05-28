# PacketADE

**A local-first desktop ADE (Agent Development Environment) for orchestrating AI software work.**

PacketADE is a Tauri v2 desktop app that brings AI coding agents, planning, issue tracking, memory, deployment tooling, and workspace management into a single native environment. It is built for running real development workflows across multiple agent CLIs without leaving the app.

## Documentation Map

- [`ROADMAP.md`](./ROADMAP.md) — current product direction and release path.
- [`backlog.md`](./backlog.md) — master ledger for outstanding work.
- [`dev/README.md`](./dev/README.md) — planning index, active implementation briefs, runbooks, and archive.
- [`dev/remoteagents/README.md`](./dev/remoteagents/README.md) — canonical Remote Agents plan.
- [`CHANGELOG.md`](./CHANGELOG.md) — shipped history only.
- [`AGENTS.md`](./AGENTS.md) / [`CLAUDE.md`](./CLAUDE.md) — agent-facing repository instructions.

## What It Does

- Chat with eight coding-agent providers from a **single Agents pane** that normalizes Claude Code subscription, Codex subscription, OpenAI Agents SDK, four API-key providers, and local Ollama into one event contract
- Run multiple agent sessions side-by-side in PTY-backed panes inside a **Workspace** (your terminal-CLI command center)
- Plan and supervise larger units of work from the **Flight Deck** — a single-screen master-detail mission control
- Track issues on a kanban board and send them directly to workspace sessions
- Connect to remote servers via SSH and run agent sessions over the wire
- Keep project context close with auto-learning memory, history, and GitHub integration
- Manage MCP servers, inspect crashes, and run deploy workflows from the same UI

> Looking for a terminal-native orchestration experience? See [**FlightDeck**](https://github.com/packetloss404/flightdeck) — the TUI-first sibling project, split out of this repo and evolving independently.

## Supported Agents

PacketADE runs two kinds of agents side-by-side.

**PTY-backed CLI sessions** — launched in a workspace pane and driven by the CLI's own UI:

- Claude Code
- OpenAI Codex CLI
- Gemini CLI
- OpenCode

**API agents in the Agents pane** — structured conversations with streaming, tool calls, and permission gating, picked from a grouped dropdown:

| Row | Internal id | Auth |
|---|---|---|
| Anthropic (Subscription) | `api-claude-oauth` | Claude Code OAuth (`claude login`) — uses your Pro/Max subscription |
| Claude (API) | `api-claude` | Anthropic API key in OS keyring |
| OpenAI (ChatGPT Plus/Pro) | `api-openai-codex` | Codex CLI OAuth (`codex login`) — uses your ChatGPT subscription |
| OpenAI (API) | `api-openai` | `OPENAI_API_KEY` in OS keyring |
| OpenAI Agents SDK (API) | `api-openai-agents` | `OPENAI_API_KEY` in OS keyring |
| MiniMax | `api-minimax` | API key in OS keyring |
| OpenRouter | `api-openrouter` | API key in OS keyring |
| Ollama | `api-ollama` | none — local daemon at `localhost:11434` |

Auth status is probed live and shown as a badge next to each row (`ready` / `login_required` / `missing_key` / `service_down`). An fs watcher flips the badge automatically after a `claude login` / `codex login` completes, and expired-but-refreshable tokens stay `ready` (the SDK / CLI refreshes them transparently). Most API-key providers run in-process in Rust; subscription providers and the OpenAI Agents SDK provider run in the Node sidecar. Each session can be launched with agent-specific arguments and model selections exposed through the UI.

## Main Features

### Agents Pane — Unified Chat for Every Provider

The Agents pane is the front door. One composer, two backends (in-process Rust + Node sidecar), one event contract — pick any of the eight providers from a grouped dropdown and the chat UI is identical.

- **Live SessionHealthBar** in the chat header: model · context % gauge · cumulative tokens · session $ · git branch
- **Drag-drop and clipboard-paste images** into the launcher (5 MB cap, removable thumbnail chips); image blocks land in the SDK content array on send
- **Mid-turn steering**: `Tab` queues a follow-up that delivers after the current turn; `Alt+.` / `Alt+,` nudge the model toward thorough / fast within the same provider; `Shift+Tab` cycles a single mode chip (`default | plan | manual | yolo`)
- **Slash commands**: `/plan /permissions /model /compact /review /usage /history /clear /new /help` plus saved prompt templates as native `/<slug>` commands and project skills
- **Header context badges**: provider auth (live `provider-auth:changed`), linked Mission with click-to-jump, MCP `N/M` server toggle dropdown, memory-context tooltip previewing the actual injected patterns
- **Persistent Plan / Todo panel** docked above the chat scroll, parsing Anthropic SDK `TodoWrite` (structured `plan_block` events) plus the markdown `task_list` tool with a fallback parser
- **Per-hunk diff acceptance** in `PendingEditPrompt`: pick which hunks to accept, the merged content lands via `edit_response.mergedContent` (sidecar Anthropic + every in-process provider)
- **Batch approvals**: when 2+ writes or permissions stack up, "Apply all / Reject all / Cancel pending" rollups appear; "Cancel pending" drains parked prompts as denied without killing the agent loop
- **Reviewer subagent**: `/review` spawns a fresh read-only conversation seeded with a unified diff of pending writes; returns 🛑 Blockers / ⚠️ Concerns / 💡 Nits with file:line citations
- **Plan-first mode**: launching with the Plan posture seeds a Spec → Plan → Code FSM — the model proposes 3-7 success-criterion bullets and stops, the SpecPanel renders them as editable rows, "Lock & request plan" asks for a structured TodoWrite, "Approve & execute" lifts plan-mode and runs
- **Durable agent profiles** (Default, Scout, Reviewer built-ins, plus user-created): bundle system prompt + allowed tools + memory + permission posture; pick from the launcher dropdown or edit in `Settings → Agent Profiles`
- **AGENTS.md / CLAUDE.md auto-injection** from project root into the system prompt at session start
- **Auto-failover on rate-limit**: 429 / quota / overload errors trigger a same-provider fallback (Opus → Sonnet → Haiku, o3 → gpt-5 → o4-mini, MiniMax → highspeed) before surfacing the failure
- **Worktree-per-conversation** (opt-in toggle, local projects): provisions `.pkt-worktrees/<convId>` on a fresh `pkt/<convId>` branch so the conversation's tool calls don't touch the main checkout
- **Backgroundable agent tray** in the toolbar showing a live count of streaming agents with click-to-jump and stop
- **Live spend HUD chip** in the toolbar combining today's persisted total + in-memory session $ across every open API conversation; click jumps to the Cost Dashboard
- **Hover-`+` Codex-App-style diff comments**: per-line `+` button in the diff view opens an inline composer; queued comments fold into the next user turn as a `File comments:` preamble
- **Composer-mode segmented control** (Local / Worktree / Cloud) at "send" time picks where the conversation runs; local + worktree wired today, cloud reserved for future delegation
- **Right-rail tabbed mode** with Plan / Diff / Inspector tabs in a single 340 px column — lighter alternative to the full mosaic split for smaller screens; persisted toggle
- **Smart-approval prefix proposals**: permission prompts compute a sensible allowlist rule (e.g. `Bash(git push:*)`) and let you accept it with one click — closes the "approval fatigue" footgun
- **Cross-tool unified Project Rules editor** in `Settings → Project Rules` reads + writes both `AGENTS.md` and `CLAUDE.md` on save so a single rule set works for both Claude Code and Codex
- **Persistent goals bridged to Missions** via `/goal` — promote a conversation's checklist into a goal that survives the conversation closing; Pause / Resume / Complete from the PlanPanel; goal count surfaces in MissionsView
- **Plan-with-Claude → Execute-with-Codex** one-click handoff: PlanPanel "Hand off to Codex →" button spawns a fresh Codex conversation seeded with the distilled spec + plan; "← back to plan" link in the child's chat header
- **Old-model pinning** per profile via the `pinnedModel` field — locks a known-good model so future provider auto-upgrades don't silently switch away
- **Auto-resume across restarts**: hydrated conversations capture the provider's resume token and lazily re-establish the session on next send
- **Onboarding overlay** on first visit explaining the four affordances; one-time, persisted in localStorage

### Sidecar Protocol

The Anthropic Subscription and OpenAI ChatGPT subscription providers run in a Node sidecar that emits a normalized `api-agent:*` event vocabulary the frontend listens to (the same shape the in-process Rust providers emit). PROTOCOL_VERSION is currently **6**, with these v3+ additions:

- Events: `chunk`, `thinking`, `thinking_stop`, `tool_start`, `tool_result`, `permission_request` (with optional `batchId`/`batchSize`), `pending_edit`, `done` (with optional `resumeToken`), `error`, `plan_block`, `tool_output_extended` (Bash exit code + stdout/stderr; Write/Edit modified paths), `turn_summary` (running tokens between turns)
- Requests: `start_session` (with image attachments + resume), `send_message`, `permission_response`, `edit_response` (with optional `mergedContent` for per-hunk acceptance), `cancel`, `close_session`, `set_permission_mode`, `set_model`, `retry`, `cancel_pending_tools`

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

### Dictation — Voice-to-Text

- Local Whisper transcription (no audio leaves the machine); model size, audio device, and custom dictionary configurable from `Tools → Dictation`
- OS-level global shortcuts via `tauri-plugin-global-shortcut` so the hotkeys work even when PacketADE is not the focused application:
  - `Ctrl+Shift+V` (hold) — push-to-talk; records while held, transcribes on release
  - `Ctrl+Shift+R` — toggle recording on/off
  - `Ctrl+Shift+D` — open the Dictation view
  - `Escape` — cancel an active recording
- **Focus-aware insertion**: tracks the most recently focused text input across the app and inserts the transcript at its cursor on completion — works in agent chats, flight title/objective, issue forms, prompt library, anywhere you type. Terminals are excluded.
- **Clipboard fallback** when dictation was triggered from another app and no PacketADE input was tracked
- Live `REC` indicator in the status strip, 32-bar waveform, history search, and an analytics dashboard (WPM, sentiment trend, top words, daily streak, time saved estimate)

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

- MCP client config management plus the local MCP-provider settings surface in Tools
- Deploy configuration and terminal-backed deploy runs
- Local crash report browsing and cleanup
- Agent profile management and AI routing configuration
- Prompt template library
- Local Whisper dictation with OS-global hotkeys and focus-aware transcript insertion (see [Dictation](#dictation--voice-to-text))

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
git clone git@github.com:packetloss404/PacketADE.git
cd PacketADE
pnpm install
```

### Agent Sidecar

PacketADE ships with a Node.js sidecar that powers the Anthropic (Subscription) and OpenAI (ChatGPT Plus/Pro) providers.

- `pnpm install` at the repo root also installs the sidecar's dependencies automatically via a `postinstall` hook (idempotent; adds a few seconds to the first install).
- Before using the Anthropic (Subscription) or OpenAI (ChatGPT Plus/Pro) providers for the first time, compile the sidecar once:

  ```bash
  pnpm sidecar:build
  ```

- For a full-fidelity local build that compiles both the sidecar and the Vite app in order, use:

  ```bash
  pnpm build:all
  ```

- To point the app at a custom sidecar entry point (e.g. when running from a different working copy), set `PACKETADE_SIDECAR_PATH` to the absolute path of the compiled entry file before launching PacketADE.

`pnpm build:all` still works for a full local build. For **production bundling**, `pnpm tauri build` now auto-runs the `prebundle` chain (`fetch-node` → `sidecar:install` → `sidecar:build` → `sidecar:prune`) via Tauri's `beforeBuildCommand`, so no manual sidecar or Node setup is needed. A pinned Node 24.15.0 runtime is fetched as a Tauri `externalBin`, and the sidecar ships with a pruned production `node_modules`. Reference sizes from a Windows build: NSIS installer ~74 MB, MSI installer ~114 MB (both are produced because `bundle.targets` is `"all"`), standalone `packetade.exe` ~30 MB. The prune step removes the sidecar's devDependencies; run `pnpm sidecar:install` afterward to restore them for further sidecar development.

#### Sidecar status

The sidecar work is complete across the original four v2 tiers and the v3 / v4 protocol additions that power the unified Agents pane:

- **v2 Tier 1 — Bundling:** pinned Node 24.15.0 runtime fetched as a Tauri `externalBin`, sidecar resources bundled with pruned production `node_modules`, `prebundle` chain wired into `tauri build`.
- **v2 Tier 2 — Lifecycle & auth:** sidecar version handshake on startup, toolbar status chip reflecting live sidecar state, credential expiry parsing for Anthropic Subscription / OpenAI ChatGPT tokens, and a filesystem watcher that re-reads auth when cred files change on disk.
- **v2 Tier 3 — Protocol & UX:** `pending_edit` diff preview for Anthropic Subscription turns, command forwarding (`set_permission_mode`, `set_model`, `retry`) through a versioned protocol. Codex MCP remains intentionally deferred — the upstream Codex SDK does not yet expose MCP hooks.
- **v2 Tier 4 — Observability & updates:** sidecar lifetime stats (uptime, restart count, last-exit reason), per-provider launch counters surfaced to the UI, and a documented Tauri auto-updater setup.
- **Refresh-token aware expiry:** `provider_auth` now treats expired access tokens as `ready` when a refresh token is present, avoiding spurious "please log in" prompts for subscription users whose SDK / CLI would have refreshed on next use anyway.
- **v3 — Protocol additions for the Agents pane:** typed image attachments on `start_session` / `send_message`; `mergedContent` on `edit_response` (per-hunk acceptance); `batchId`/`batchSize` on `permission_request`; `resumeToken` on `done`; new `plan_block` event mirroring `TodoWrite`; `tool_output_extended` event with Bash exit code + stdout/stderr + Write/Edit modified paths; `turn_summary` event for live mid-stream token totals.
- **v4 — `cancel_pending_tools`:** drains parked permission/edit prompts as denied without aborting the SDK query, so the model receives synthetic "User cancelled this tool" results and the loop continues.
- **Codex absorption:** Codex `todo_list` items map to the existing `plan_block` event; `reasoning_tokens` + `cached_input_tokens` flow into `turn_summary` so CostDashboard reports GPT-5.5 spend correctly; `turn_summary.address` carries the MultiAgentV2 sub-agent path (`/root/agent_a` etc.) so child token totals attribute to a per-address bucket on the conversation instead of the root.
- **OpenAI Agents SDK provider:** `api-openai-agents` runs in the sidecar with the same OpenAI API key as `api-openai`, preserving the existing Agents pane event contract while leaving the stable Rust OpenAI API provider and Codex subscription provider untouched.
- **Standalone exe sidecar fix:** the Tauri shell plugin on Windows resolves `app.shell().sidecar("node")` to `<exe_dir>/node-<target-triple>.exe`, and the call is gated by an explicit `shell:allow-execute` capability entry. `build.rs` now copies `binaries/node-<triple>.<ext>` into the cargo output directory at compile time, and `capabilities/default.json` grants the `node` sidecar entry — so running `target/<profile>/packetade.exe` directly (without installing the MSI/NSIS) no longer reports the sidecar as down.
- See [`agent-sidecar/README.md`](./agent-sidecar/README.md) for sidecar internals and [`dev/updater-setup.md`](./dev/updater-setup.md) for signing / release channel configuration.

### Multi-platform builds

PacketADE is developed on Windows but is designed to ship on macOS and Linux as well. For per-platform prerequisites, supported target triples, and cross-compilation notes, see [`dev/multi-platform-build.md`](./dev/multi-platform-build.md). Builds and releases are produced locally — there is no GitHub Actions CI in this repo.

### Beta Distribution Status

Current beta builds are distributed through GitHub Releases and installed manually. Windows Authenticode signing, macOS Developer ID signing/notarization, and the Tauri v2 auto-updater are planned release-trust gates but are not enabled in the repo today. Until those credentials and updater manifests exist, beta users may see SmartScreen or Gatekeeper warnings on fresh downloads.

Local release gates are still explicit: run `pnpm lint`, `pnpm build`, `cargo check --manifest-path src-tauri/Cargo.toml`, and `pnpm tauri build` before publishing an installer. The updater setup runbook lives in [`dev/updater-setup.md`](./dev/updater-setup.md).

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
      views/                   # First-class application views (MissionsView, WorkspaceView, AgentsView, …)
      editor/                  # Lightweight editor/diff support
      workspace/               # Workspace creation, sidebar, and pane container UI
      servers/                 # SSH server form modal
      common/                  # Shared presentation components
      ui/                      # Shared UI primitives
    stores/                    # Zustand stores for app, layout, flights, issues, workspaces, etc.
    modules/                   # Module registration: ideation, scaffold, dictation
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
      session/                 # Session DTOs and shared session helpers

  agent-sidecar/               # Node sidecar for subscription providers
  scripts/                     # Build, sidecar, schema-check, and bundling scripts
  e2e/                         # Playwright tests
  docs/                        # Documentation site assets
  public/                      # Static frontend assets
```

## Contributor Notes

- Core views are declared in `src/stores/appStore.ts`
- Tauri commands live in `src-tauri/src/commands/` and are bound in `src/lib/tauri.ts`
- App modules are registered through `src/modules/registry.ts`; current modules are Ideation Scanner, Scaffold, and Dictation
- Session management is PTY-based rather than JSONL-session based
- Backend orchestration concepts (Flights, PTY sessions, agent configs) are mirrored by FlightDeck, PacketADE's sibling TUI project in a separate repo
- GitHub PAT is stored in the OS keyring via the `keyring` crate
- SSH passwords are prompted at connect time and held in memory only

## License

PacketADE is licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
