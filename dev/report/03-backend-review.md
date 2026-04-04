# FlightDeck Review - Backend Review

## Overall Backend Verdict

The Rust backend has the right long-term shape: shared core domain, Tauri command layer, and a TUI that already consumes backend logic directly. The main issue is not architecture ambition; it is incomplete hardening around PTY control, persistence, and the contract between core state and desktop behavior.

## Tauri Command Layer

### Good

- Commands are mostly thin wrappers.
- Git commands use `Command::new(...).args(...)` instead of shell strings.
- PTY state is initialized once and bridged into Tauri events cleanly.

### Risks

- `create_pty_session` currently accepts arbitrary renderer-supplied command/args and broad path input.
- `read_pty_transcript` trusts raw `session_id` input too much.
- filesystem listing intentionally exposes `.env` and `.env.local`, which is a bad default for a desktop control plane.

Relevant files:

- `src-tauri/src/lib.rs`
- `src-tauri/src/commands/pty.rs`
- `src-tauri/src/commands/git.rs`
- `src-tauri/src/commands/fs.rs`

## Rust Core

### `src-tauri/src/core/orchestrator.rs`

Strengths:

- clear milestone progression model
- defensive recovery of interrupted runs
- readable scheduling logic

Concerns:

- restart recovery can leave flights looking active but not actually schedulable
- lifecycle semantics diverge from the desktop implementation
- `task.agent_args` exists in the model but is not actually applied during spawn construction

### `src-tauri/src/core/storage.rs`

Strengths:

- unified persisted-state file is the right direction
- migration/fallback thinking is present

Concerns:

- non-atomic multi-file writes can leave the main state and legacy files out of sync
- versioning exists but is not acting like a mature migration boundary yet

### `src-tauri/src/core/git.rs`

Strengths:

- centralized git execution
- absolute path validation before running git

Concerns:

- commit flow can auto-stage the entire repo
- push/pull are thin pass-throughs with limited safety policy
- error handling is mostly raw stdout/stderr, not structured ADE guidance

## PTY Runtime

### `src-tauri/src/core/pty.rs`

What works:

- framework-agnostic PTY manager
- transcript capture and tail-read API
- bounded PTY writes

What needs attention:

- transcript files grow without bound
- transcript path construction is too trusting of `session_id`
- Windows `.cmd` resolution can break non-wrapper executables
- global mutex plus append-only logging deserves more operational scrutiny

## Statusline Backend

### `src-tauri/src/commands/statusline/**/*.rs`

Strengths:

- good focused tests compared with most of the repo
- staleness filtering is sensible
- Codex parsing does useful caching/tail logic

Concerns:

- manual ISO parsing is brittle
- fixed 16 KB tail windows can miss relevant long-running-session data
- recursive scans of session directories will age poorly if a machine accumulates many logs

## TUI Assessment

The TUI proves the value of the shared-core approach, but it also exposes an important maintainability problem.

### Strong

- directly uses core orchestration and storage
- good live-ops orientation
- has extra operational ideas like doom-loop detection

### Weak

- `src-tauri/src/tui/app.rs` is a god object
- selection/filter behavior has rough edges
- some persisted UI state is written but not truly restored

## Backend Recommendations

1. make Rust core the canonical orchestration engine for both desktop and TUI
2. harden PTY transcript identity/path handling and add retention/rotation
3. tighten command execution trust boundaries and document them clearly
4. replace manual timestamp parsing and improve statusline file scan policy
5. reduce TUI controller size by extracting view/runtime services
