# Architecture

PacketBench is one native process with three separate agent transports bolted
onto a single event contract. This page explains the process model, where state
actually lives, and what happens between pressing Enter in the composer and text
appearing in the transcript.

Everything here is read off the source at v0.12.1. Where a doc and the code
disagree, the code wins and the disagreement is called out.

## The process model

A running PacketBench install is up to four kinds of process:

```
┌──────────────────────────────────────────────────────────────┐
│ packetbench (Rust, Tauri v2)                                 │
│                                                              │
│  ┌────────────────────────┐   IPC (invoke + events)          │
│  │ WebView: React 19 SPA  │◄──────────────┐                  │
│  └────────────────────────┘               │                  │
│                                           │                  │
│  commands/  core/  acp/  mcp_server/  ────┘                  │
│      │            │            │                             │
│      │            │            └── loopback HTTP :/mcp (rmcp) │
│      │            │                                          │
│      │            └── in-process LlmProvider (reqwest/SSE)    │
│      │                                                       │
│      ├── portable-pty children ── claude / codex / opencode / │
│      │                            packetcode / plain shells   │
│      ├── node agent-sidecar/dist/index.js  (NDJSON on stdio)  │
│      └── packetcode acp                    (NDJSON JSON-RPC)  │
└──────────────────────────────────────────────────────────────┘
```

- **The Rust core** is the Tauri app: `src-tauri/src/lib.rs` builds the
  application, manages shared state, and registers ~240 `#[tauri::command]`
  entry points in one `guarded_invoke_handler!` block.
- **The WebView** is a plain Vite/React SPA. It has no server; `frontendDist`
  is `../dist` and the dev server is `http://localhost:1420`
  (`src-tauri/tauri.conf.json:6`).
- **PTY children** are real terminals via a vendored, patched `portable-pty`
  (`src-tauri/Cargo.toml` pins `portable-pty = { path = "vendor/portable-pty" }`
  because upstream's `close_random_fds` allocates and therefore aborts in the
  child after `fork()` inside a WebKit-threaded host).
- **The Node sidecar** is a long-lived child speaking newline-delimited JSON.
- **The ACP engine** is a separately-installed `packetcode` binary, never
  bundled.

### Startup ordering is load-bearing

`run()` in `src-tauri/src/lib.rs:156` does several things *before* the Tauri
builder, in an order that is documented in the source as mandatory:

| Step | Function | Why the order matters |
| --- | --- | --- |
| 1 | `core::shell_path::fix_path_for_gui_launch()` | Calls `std::env::set_var`, which is only sound single-threaded. Must precede anything that spawns a thread. |
| 2 | `init_tracing()` | Starts a background log-writer thread — so it cannot come first. |
| 3 | `core::migration::migrate_data_dir()` | Renames the legacy data dir. Must precede any data-dir read. |
| 4 | `core::migration::migrate_mission_to_flight()` | Canonicalises leftover `missionId` keys. |
| 5 | `commands::crashes::install_panic_hook()` | So the next step's surprises are reported. |
| 6 | `core::reprice::reprice_historical_costs()` | Rewrites dollar figures computed at the old, wrong model rates. |
| 7 | `core::pty::reap_orphaned_pty_children()` | Kills PTY children stranded by a previous abnormal exit. |
| 8 | `core::orchestrator::recover_flights_on_startup()` | Demotes interrupted attempts to `Failed`; returns the list to sweep. |

> **Warning:** Step 1 is not a style preference. The source comment at
> `src-tauri/src/lib.rs:156` records the failure mode: mutating `environ` once a
> second thread exists is UB, and it corrupts the environment such that a later
> PTY `fork()`+`exec()` aborts in the child with "crashed on child side of fork
> pre-exec".

Reprice is worth understanding because it is not cosmetic. The historical cost
figures feed the budget guardrails, so a 3x-overstated Opus history would lock a
user out of their own budget. The pass is idempotent per record and marks
completion with `PersistedState.cost_reprice_v1_at`
(`src-tauri/src/core/storage.rs:202`).

### Managed state

Everything in `.manage(...)` at `src-tauri/src/lib.rs:210` is a process-lifetime
singleton reachable from any command via `tauri::State`:

| State | Owns |
| --- | --- |
| `ApiAgentState` | In-process session configs, message histories, active-turn handles, pending permission/edit channels |
| `SidecarManager` | The Node child, its stdin writer, per-session ownership, remote (SSH) sidecar routes |
| `AcpState` | The ACP engine child and the conversation-id ↔ engine-session-id map. Holds no process until an ACP conversation starts |
| PTY manager | Live PTY sessions |
| `WhisperState`, dictation state | Local Whisper model + capture |
| `McpServerState` | The optional loopback MCP server |
| `MonitorWindowRegistry` | Read-only Monitor windows |
| `AuxRoutingState` | Backend mirror of the auxiliary-AI routing settings |

### The Monitor window is a capability boundary

`guarded_invoke_handler!` (`src-tauri/src/lib.rs:121`) wraps the generated
handler and consults
`commands::monitor_windows::command_allowed_for_window(label, command)` before
dispatching. A read-only Monitor window gets its invoke rejected with "This
read-only Monitor cannot invoke that application command." rather than being
trusted because it is in-process. A repository fence pins the other half of that
boundary — see [Testing & gates](dev-testing.html).

## The three transports

The provider picker has nine chat rows. They resolve to exactly three backends,
and every one of them emits the identical `api-agent:*` Tauri event stream, so
the frontend cannot tell which served a turn.

| Transport | Rows | Entry point |
| --- | --- | --- |
| In-process `LlmProvider` | `api-claude`, `api-openai`, `api-minimax`, `api-openrouter`, `api-ollama`, `api-custom` | `src-tauri/src/core/llm_provider.rs` |
| Node sidecar | `api-claude-oauth` (Claude Agent SDK), `api-openai-agents` | `src-tauri/src/commands/agent_sidecar/` |
| ACP | `api-packetcode` | `src-tauri/src/acp/` |

### Why three and not one

The in-process path exists because most providers are just an HTTPS SSE stream,
and PacketBench wants to own the agentic loop: its own tool definitions, its own
permission gate, its own MCP bridge, its own cost ledger. `LlmProvider` is
deliberately tiny — one method:

```rust
async fn stream_chat(
    &self,
    api_key: &str,
    request: LlmRequest,
    tx: mpsc::Sender<StreamChunk>,
) -> Result<(), String>;
```

The sidecar exists because two vendor **agent SDKs** — Anthropic's Claude Agent
SDK and OpenAI's Agents SDK — are JavaScript-only and own their own loop. You
cannot reimplement them in Rust; you host them.

ACP exists because the `packetcode` engine is a separate product with its own
provider credentials and its own session store. PacketBench drives it over Agent
Client Protocol v1 rather than absorbing it.

> **Note:** `get_provider` takes a *provider* id, never an agent-config id.
> `api-claude` maps to `"anthropic"`, not `"claude"`. Deriving one from the
> other by stripping the `api-` prefix produces ids the match arm rejects —
> which is correct for seven of eight executors and silently wrong for the
> default. Two Rust tests
> (`src-tauri/src/core/llm_provider.rs:76` onward) and a repository fence pin
> this. See [Invariants & tripwires](agent-invariants.html).

### Provider id vocabularies

There are three different id spaces and confusing them is the most common
routing bug in this codebase:

| Space | Examples | Lives in |
| --- | --- | --- |
| `AgentCli` (frontend, persisted) | `api-claude`, `api-claude-oauth`, `api-packetcode` | `src/types/agent-conversation.ts` |
| Sidecar / wire provider | `claude-oauth`, `openai-agents`, `echo` | `SIDECAR_PROVIDERS`, `src-tauri/src/commands/agent_sidecar/mod.rs:43` |
| In-process provider | `anthropic`, `openai`, `minimax`, `minimax-api`, `openrouter`, `ollama`, `custom` | `IN_PROCESS_PROVIDERS`, `src-tauri/src/core/llm_provider.rs:36` |

A fourth, narrower space is the usage-ledger `source` string, produced by
`provider_to_source` at `src-tauri/src/commands/api_agent.rs:824`. Note its
fallback arm returns `"api-claude"` for anything unrecognised — which is why the
ACP transport has an explicit arm rather than being allowed to fall through and
silently bill itself to Claude.

## How a turn actually flows

Take the in-process path first, because it is the one PacketBench fully owns.

```
Composer (React)
   │ sendApiAgentMessage / startApiAgentSession   [src/lib/tauri.ts]
   ▼
start_api_agent_session                [commands/api_agent.rs:993]
   │  provider_stats::record_launch
   ├─ is_acp_provider?  ──► acp::routing::start_session ──► engine
   ├─ is_sidecar_provider? ─► SidecarManager::forward_start* ──► node
   ▼ (else)
run_agent_turn loop                    [commands/api_agent.rs:2090]
   │  for iteration in 0..MAX_TOOL_ITERATIONS (150)
   │    ├ build LlmRequest (max_tokens 16384, thinking budget 8000,
   │    │                   cache_key = session_id)
   │    ├ spawn provider.stream_chat(tx)
   │    ├ select! { cancel_rx | rx.recv() }
   │    │    TextDelta      ──emit──► api-agent:chunk:<id>
   │    │    ToolUseStart   ──emit──► api-agent:tool-start:<id>
   │    │    …
   │    ├ if no tool calls  ──emit──► api-agent:done:<id>   (break)
   │    └ else execute tools ─► tool_runtime ─► append results ─► next iter
   ▼
Tauri event bus
   ▼
installApiAgentListeners               [src/stores/apiAgentListeners.ts:215]
   │  rAF stream coalescer  ──► agentTaskStore.conversations[i].messages
   ▼
requestConversationSave ──debounce 500ms──► save_conversation
   ▼
~/.packetbench/conversations/<id>.json
```

Several details in that path are worth naming:

**Turn ownership is exclusive and queued.** `ApiAgentState::begin_turn`
(`src-tauri/src/commands/api_agent.rs:159`) subscribes to a `watch` channel
*while holding the ownership lock*, so a queued follow-up cannot race between
the check and the await and get stranded. `finish_turn` compares turn ids before
removing, so an older task can never clear a newer turn's cancellation handle.

**The loop is bounded but generous.** `MAX_TOOL_ITERATIONS = 150`
(`src-tauri/src/commands/api_agent.rs:30`). The comment is explicit that this is
set high so a real task completes in one turn rather than forcing the user to
press Continue; it is a runaway backstop, not a step budget.

**Attachments apply only to iteration 0.** Tool-result iterations do not
re-attach images (`src-tauri/src/commands/api_agent.rs:2116`).

**The prompt cache key is the session id**, stable for the session's life, so
every iteration lands on the same OpenAI prompt-cache partition
(`src-tauri/src/commands/api_agent.rs:2140`).

**Streaming is coalesced on the frontend, not the backend.** Rust emits one
Tauri event per token delta. `createStreamCoalescer`
(`src/stores/apiAgentListeners.ts:227`) buffers them and lands at most one store
write and one save request per animation frame, replacing only that
conversation's array entry. `done`, `error` and `thinking-stop` call
`flushNow()` first so a settling turn cannot lose its tail chunks.

### The sidecar path

`start_api_agent_session` short-circuits at
`src-tauri/src/commands/api_agent.rs:1116`. The Rust side loads the API key from
the OS keyring, hands it to the sidecar transiently in `start_session.apiKey`,
and forwards. From then on the sidecar owns the agentic loop; Rust is a
translator turning `SidecarEvent`s into `api-agent:*` Tauri events
(`src-tauri/src/commands/agent_sidecar/handler.rs:26`).

Ownership is lifecycle state, not per-turn state. A per-turn `error` from the
sidecar deliberately does **not** drop session ownership — the comment at
`src-tauri/src/commands/agent_sidecar/handler.rs:773` records that dropping it
would reroute the next send into the in-process runtime ("No active session")
and permanently brick the conversation while leaking the sidecar-side session.

### The ACP path

`src-tauri/src/acp/` is layered so the protocol code knows nothing about
PacketBench:

- `acp/mod.rs` — the bridge. Resolves the engine, gates on a minimum version via
  `packetcode doctor --json`, spawns `packetcode acp`, speaks ACP v1 (NDJSON
  JSON-RPC 2.0 over stdio). `MINIMUM_ENGINE_VERSION = "0.1.0"`.
- `acp/events.rs` — the *only* place ACP payloads become `api-agent:*`
  emissions. Pure functions returning the emissions a payload implies, which is
  why they are directly unit-testable.
- `acp/routing.rs` — conversation-level decisions and the id map.
- `acp/mcp.rs` — maps PacketBench's MCP trust decision onto ACP's three-way
  `mcpServers` contract.

**Session identity:** PacketBench mints the conversation id and it *is* the
session id everywhere in the app. The engine mints its own on `session/new`, and
that id never leaves `crate::acp` except on the wire
(`src-tauri/src/acp/routing.rs:9`).

ACP timeouts are derived, not guessed. `session/new` is budgeted at three times
the engine's own 30-second MCP startup ceiling, because a client budget equal to
that ceiling always loses the race in the worst possible way: the engine
finishes moments later and registers a live session PacketBench has already
given up on (`src-tauri/src/acp/mod.rs:50`).

> **Note:** ACP is local-only. `start_api_agent_session` refuses an ACP session
> with an `ssh_config` and emits `api-agent:error` explaining why
> (`src-tauri/src/commands/api_agent.rs:1044`).

## Where state lives

There are five distinct persistence surfaces and knowing which is which prevents
a lot of confusion.

| Surface | Location | Written by | Shape |
| --- | --- | --- | --- |
| Unified app state | `~/.packetbench/state.v1.json` | `commands::state::save_*_slice`, `core::storage` | One `PersistedState` struct |
| Conversations | `~/.packetbench/conversations/<id>.json` | `save_conversation` | Frontend-defined JSON, opaque to Rust |
| Usage ledger | `~/.packetbench/usage.jsonl` | `commands::usage` | Append-only `UsageEntry` rows |
| Browser localStorage | `packetbench:*` keys | Zustand stores | Per-store JSON |
| OS keyring | service `packetbench` | `api_keys`, `github`, `ssh_keys` | Secrets only |

### state.v1.json

`PersistedState` (`src-tauri/src/core/storage.rs:164`) carries flights, agents,
settings, UI, issues, workspaces, retrospectives, memory events, memory
patterns, servers, CLI accounts and their per-project defaults, legacy flight
approvals, and the reprice marker.

Writes go through a two-tier lock. `ASYNC_STATE_LOCK`
(`src-tauri/src/core/storage.rs:120`) is a fair-FIFO async mutex held across the
*entire* load → mutate → save sequence, so a stale full-state save cannot
overwrite a slice save that landed in between. `STATE_LOCK` is the inner
synchronous guard. The ordering is mandatory: acquire the async gate first.

> **Important:** The two synchronous writers (`save_state`, `update_state`) run
> only at startup, before the runtime serves IPC. Do not call them from a
> command.

### Conversations are frontend-shaped

`commands/conversations.rs` treats `data` as an opaque pre-serialized string and
does nothing but filesystem management plus path-escape guards
(`validate_id` rejects separators, `.`, `..`, and any `..` substring). The schema
is entirely the frontend's: `PersistedAgentConversation` in
`src/stores/agentConversationPersistence.ts:17`, which is deliberately *wider*
than the runtime `AgentConversation` because `plan` / `planApproved` are the plan
substore's only persistence mechanism and must keep round-tripping.

Only `mode === "api"` conversations are persisted
(`src/stores/agentConversationPersistence.ts:53`).

### localStorage

Every persistent Zustand store namespaces under `packetbench:`. Import
`storageKey()` from `src/lib/brand.ts`; never spell the prefix inline. The
`LEGACY_STORAGE_PREFIX` (`packetade:`) exists solely for the one-shot migration.

### Brand constants

`src-tauri/src/core/brand.rs` and `src/lib/brand.ts` are the single source for
app name, data dir, log dir, keyring service, user agent, temp-dir prefix, URI
scheme and the Monitor query key. The `LEGACY_*` values point at the
*immediately prior* name only (`packetade` / `.packetade`), because the earlier
`packetcode` migration has already run.

## Frontend structure

### Boot sequence

`initializeApp()` in `src/lib/bootstrap.ts:96` is the whole of startup:

1. Kick `hydrateConversations()` concurrently — but do not publish
   `initialized` until it resolves, because `sessionGlue` needs both halves.
2. `loadPersistedState()` → hydrate workspace, memory, server, CLI-account and
   issue stores synchronously (they gate the welcome screen and PTY launches).
3. Run the one-time `SshTarget` → `serverStore` migration.
4. Fetch the app-managed `known_hosts` path so SSH pins host keys instead of
   falling back to TOFU.
5. Apply theme and time zone before the first post-bootstrap paint.
6. Resolve the project path: backend settings → localStorage → CWD, each
   candidate validated with `pathIsDir` and rejected if it looks like a build
   directory (`looksLikeBuildDir` — adopting `src-tauri/target` is what
   historically poisoned the persisted path).
7. `await conversationsReady`, restore the last view, then `setInitialized(true)`.
8. Hydrate the heavy stores (flights, agents, orchestration settings) in the
   background.
9. Start the bounded-autonomy runtime, the `flight:cost-updated` listener, and
   the cost-guardrail monitor.

> **Note:** Step 7's ordering is deliberate and documented in the source: the
> view is restored *after* conversations (so heavy views never mount against
> half a graph) and *before* `setInitialized` (so there is no Welcome flash, and
> the persistence effect does not immediately write the value back).

### Store topology

Zustand, `create<StoreInterface>()`, one store per concern. The ones you will
touch most:

| Store | Responsibility |
| --- | --- |
| `agentTaskStore` | API-agent conversations, the `AgentCli` union, `RETIRED_API_AGENTS` |
| `apiAgentListeners` | Per-conversation subscription to all fifteen `api-agent:*` events |
| `layoutStore` | Panes, mosaics, project path |
| `flightStore` / `asyncFlightStore` | Flight CRUD / worktree attempt lifecycle |
| `issueStore` | Kanban board; `assignToFlight` is the authoritative flight link |
| `sessionGlue` | The *only* permitted bridge between `agentTaskStore` and `workspaceStore` |
| `memoryStore` / `projectMemoryStore` | See [Memory internals](dev-memory.html) |

> **Warning:** `agentTaskStore` and `workspaceStore` may not import each other.
> This is enforced by `no-restricted-imports` in `eslint.config.js`, and
> `sessionGlue` exists specifically to be the seam. A cycle here is what the
> rule was written to stop.

### Chunking

`vite.config.ts` hand-partitions vendor chunks (`vendor-xterm`,
`vendor-markdown`, `vendor-mosaic`, `vendor-icons`, `vendor-react`,
`vendor-state`, `vendor-tauri`) and pins Vite's dynamic-import preload helper
into a dedicated dependency-free `vendor-helpers` chunk. Without that pin,
rollup can park the helper inside a heavy lazy chunk, and the entry then
statically imports that whole chunk just to get the helper — dragging
`vendor-markdown` onto the cold-start path.

Views in `src/App.tsx:40` are all `React.lazy` for the same reason.

## Generated TypeScript bindings

`src-tauri/src/api/mod.rs` defines `ts-rs`-annotated DTOs mirroring the core
types. `src-tauri/tests/api_schema.rs` holds one `#[ignore]`d test that writes
`packetbench_lib::api::generated_typescript_schema()` out to
`src/generated/tauri-schema.ts`.

Regenerate with `pnpm generate:tauri-schema`; verify staleness with
`pnpm check:tauri-schema`. The check regenerates, diffs, and then restores the
original file so it never leaves the tree dirty.

## Modules

Only two features are "modules" in the registry sense —
`src/modules/registry.ts` lists exactly `qualityModule` (category `analysis`)
and `dictationModule` (category `integration`). Modules can be disabled, which
is why `resolveStartupView` takes an `isEnabled` predicate: restoring into a
disabled module's view falls back to Welcome.

## PacketBench as an MCP server

`src-tauri/src/mcp_server/` exposes PacketBench's own state to *other* agents
over Streamable HTTP (the current MCP transport; the 2024 HTTP+SSE transport is
deprecated), mounted at `/mcp` via the official `rmcp` crate, loopback only,
with bearer + Origin auth. Reads never mutate. The two writes (`append_handoff`,
`escalate`) are gated behind `allow_writes`, default off. It reads the same
`state.v1.json` the Tauri core owns, which is why it lives in Rust rather than
the sidecar.

See [MCP hub](mcp.html) for the user-facing side.

## Next

- [Agent event contract](dev-agent-contract.html) — the fifteen events, their
  payloads, and what the protocol version means.
- [Build & release](dev-build.html) — how this all gets bundled.
- [Memory internals](dev-memory.html) — the one subsystem with a genuinely
  subtle invariant.
