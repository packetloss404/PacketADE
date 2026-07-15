# MCP Provider Transport — Implementation Plan

## Implementation Status — 2026-07-15

| Item | Status | Notes |
|------|--------|-------|
| Phase 1: Frontend types + store + settings UI | ✅ Done | `mcpProviderStore.ts`, `McpProviderCard.tsx` |
| Phase 2: Local MCP server (Rust) — lifecycle + transport + auth | ✅ **Shipped** (N3 Slice 0) | `rmcp` 2.2 Streamable HTTP, `mcp_server/{mod,transport}.rs` |
| Phase 2: Read-only resources (7) + read tools (5) + audit | ✅ **Shipped** (N3 Slice 1) | `mcp_server/reads.rs` |
| Phase 2: Safe workflow tools (writes) | ⏸️ Deferred (see below) | `append_handoff` / `request_review` / `mark_blocked` — needs event-routed write design |
| Phase 3: Ownership-aware tools | ⏸️ Deferred (see below) | Assumes deleted orchestrator substrate — re-validate first |

### What shipped (N3, 2026-07-15) — read-only server

Decision (user): **v1 is read-only** — no external agent may mutate PacketADE.
Auth: **bearer token + Origin check + `127.0.0.1` bind**.

- **Transport correction:** the original plan below specced "HTTP/SSE", but that
  2024 two-endpoint transport is **deprecated**. Shipped as **Streamable HTTP**
  (single `/mcp` endpoint) via the official **`rmcp` 2.2** crate + `axum`,
  hosted in the **Rust core** (where `storage::load_state()` owns the state) —
  NOT the sidecar.
- Lifecycle: `mcp_server_{start,stop,status,recent_activity}` Tauri commands.
- Resources (7) and read tools (5) per the tables below (read-only rows only).
- Audit: bounded in-memory ring + `mcp-server-activity` event → card viewer.
- `list_runnable_tasks` gates on flight status (`Active` only).

### Deferred with cause

- **Safe writes** (`append_handoff`/`request_review`/`mark_blocked`): the
  frontend saves state wholesale from Zustand, so a direct Rust file write from
  the MCP server would be clobbered and invisible to the UI. Writes must be
  **event-routed** (Rust emits → frontend applies → saves). Design deliberately
  when un-deferring.
- **Phase 3 ownership** (`claim_task`/`reserve_paths`/`release_paths`/
  `escalate_task`): designed against the orchestrator/coordination substrate
  that the flight-planner amputation deleted. Re-validate against the live
  attempt/path-ownership model before building.

## Context

PacketADE currently manages MCP client configs (connecting TO other MCP servers) and has a frontend MCP-provider settings surface, but it does not expose itself AS an MCP server yet. Phase 1 (frontend types, store, settings UI) was implemented in the Track M work. Phases 2-3 add the actual Rust transport layer so external tools can query PacketADE's state.

**Deferred because:** No current demand — PacketADE is the primary ADE, not a backing service for other tools. The MCP ecosystem is still evolving. Foundation is laid; the Rust server can be built against existing interfaces when needed.

**Trigger to implement:** When external agents (Claude Code CLI, Codex CLI, Cursor, etc.) need to read PacketADE flights, tasks, or memory from outside the app.

## Phase 2: Local MCP Server + Resources + Safe Tools

### Transport

> **Superseded — see "What shipped" above.** This section specced HTTP/SSE;
> the deprecated 2024 transport. Shipped as **Streamable HTTP** on
> `127.0.0.1:<port>` (default 3100) via `rmcp` 2.2.

Localhost, configurable port. Chosen over stdio because:
- External agents connect to a running PacketADE instance
- Multiple clients can connect simultaneously
- Port already configurable in `McpProviderCard.tsx`

### Rust implementation

New module: `src-tauri/src/mcp_server/`
- `mod.rs` — server lifecycle (start/stop)
- `transport.rs` — HTTP listener, JSON-RPC handler
- `resources.rs` — resource URI routing and handlers
- `tools.rs` — tool call routing and handlers

Server reads from `PersistedState` (same source as TUI) to access flights, memory, workspaces.

### Resources (read-only)

| URI | Description |
|-----|-------------|
| `packetade://project` | Active project metadata (path, git branch) |
| `packetade://flights` | List of flights with status |
| `packetade://flights/{id}` | Full flight detail with milestones/tasks |
| `packetade://flights/{id}/tasks` | Tasks for a flight |
| `packetade://memory/patterns` | Learned patterns from memory layer |
| `packetade://workspaces` | Active workspaces |
| `packetade://reviews` | Pending review packets |

### Safe workflow tools

| Tool | Description | Risk |
|------|-------------|------|
| `get_active_flight` | Returns the active flight | Read-only |
| `list_runnable_tasks` | Tasks in queued/pending status | Read-only |
| `read_task_details` | Full task info with handoff log | Read-only |
| `append_handoff` | Add a handoff note to a task | Safe write |
| `request_review` | Create a review packet | Safe write |
| `mark_blocked` | Mark a task as blocked with reason | Safe write |
| `read_memory_context` | Get memory patterns for a project | Read-only |
| `list_workspaces` | List active workspaces | Read-only |

### Security

- Bind to `127.0.0.1` only (no external access)
- Per-tool permissions (configured in `McpProviderCard`)
- Audit trail: log all tool calls with timestamp and caller

### Frontend additions

- Connection status indicator in `McpProviderCard` (server running/stopped, connected clients count)
- Audit log viewer (last N tool calls)
- Start/stop server button

## Phase 3: Ownership-Aware Tools

Depends on Phase 2 transport + Track S file ownership model (already implemented).

| Tool | Description |
|------|-------------|
| `claim_task` | Assign a task to an agent, set ownedPaths |
| `reserve_paths` | Reserve file paths for a task |
| `release_paths` | Release file ownership |
| `escalate_task` | Escalate a blocked task with context |

### Files to create (when implementing)

| File | Phase | Purpose |
|------|-------|---------|
| `src-tauri/src/mcp_server/mod.rs` | 2 | Server lifecycle |
| `src-tauri/src/mcp_server/transport.rs` | 2 | HTTP/JSON-RPC handler |
| `src-tauri/src/mcp_server/resources.rs` | 2 | Resource handlers |
| `src-tauri/src/mcp_server/tools.rs` | 2 | Tool handlers |
| `src-tauri/src/mcp_server/ownership.rs` | 3 | Ownership tool handlers |

### Files to modify (when implementing)

- `src-tauri/src/lib.rs` — register MCP server start/stop commands
- `src-tauri/Cargo.toml` — may need `axum` or similar HTTP framework
- `src/stores/mcpProviderStore.ts` — add server status, audit log state
- `src/components/views/tools/McpProviderCard.tsx` — add start/stop, status, audit viewer

## Existing foundation

These files already exist and define the interfaces:
- `src/types/mcp-provider.ts` — `McpResource`, `McpTool`, `McpProviderConfig`
- `src/stores/mcpProviderStore.ts` — resource refresh, tool definitions, config persistence
- `src/components/views/tools/McpProviderCard.tsx` — enable/port/scope/tool toggles
