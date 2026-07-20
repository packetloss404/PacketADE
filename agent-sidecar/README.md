# packetade-agent-sidecar

Node sidecar that hosts LLM provider integrations for PacketADE. The Rust
Tauri backend (the "supervisor") spawns this process and talks to it over
newline-delimited JSON on stdin/stdout.

## Why a sidecar?

The Anthropic subscription provider uses the Claude Agent SDK, the OpenAI
subscription provider wraps `codex exec`, and the OpenAI Agents SDK provider
uses the OpenAI API key path behind the same sidecar protocol. Keeping these
in an isolated Node child process lets the Rust
supervisor handle lifecycle, crash restart, and routing events into Tauri
event channels for the React UI without making the frontend care which
transport produced a turn.

## Install & build

```bash
cd agent-sidecar
pnpm install
pnpm build        # -> dist/index.js
pnpm dev          # tsc --watch
```

The supervisor launches the sidecar by running `node <path-to-dist/index.js>`.
It finds the entry point via the `PACKETADE_SIDECAR_PATH` environment variable
(set by the Rust side; falls back to a known bundled location in release
builds). No direct invocation from the CLI is expected in normal use.

For local protocol confidence from the repository root, run:

```bash
pnpm sidecar:check
```

That chain includes `sidecar:remote-project-smoke`, a regression smoke that
starts the echo provider with a POSIX remote-looking `projectPath`. It does not
open SSH; it verifies the sidecar protocol accepts paths that are meaningful on
a remote host and may not exist on the desktop running the test.

## Providers

The factory lives in `src/session-registry.ts`. Currently wired:

- **`echo`** — smoke-test provider. Deterministic, no network, used by
  `pnpm sidecar:smoke` to verify the protocol end-to-end.
- **`claude-oauth`** — Anthropic subscription auth via
  `@anthropic-ai/claude-agent-sdk` (`src/providers/anthropic.ts`). Added in
  Phase 4. Supports the full tool loop, streaming output, MCP server
  passthrough, and permission / edit approval requests. Auth comes from the
  Claude Code OAuth credential store — no API key env var needed.
- **`openai-codex`** — OpenAI ChatGPT subscription via the `codex` CLI
  (`src/providers/openai-codex.ts`). Current limitations:
  - No MCP server support. Deliberately not wired — Codex has its own MCP
    config format (`~/.codex/config.toml` under `[mcp_servers.*]`), and users
    configure it via `codex mcp add`. Plumbing the sidecar's `mcpServers`
    field through would mean translating between two incompatible config
    shapes and fighting the CLI's own precedence rules. Deferred past Tier 3;
    revisit if user demand indicates benefit. A one-time stderr warning
    fires if `mcpServers` is non-empty on `start_session`.
  - Tool-call detail is shallower than the SDK providers because Codex's
    `--json` output is less structured; unknown event types are logged to
    stderr and dropped.
  - `allowedTools` is not enforced — Codex has no equivalent flag, so the
    provider relies on sandbox policy (`workspace-write` default, `read-only`
    for plan mode) plus approval gating.
  - `sendMessage` spawns a fresh `codex exec resume <sessionId>` per turn
    (Codex's exec mode is one-shot). Overlapping turns are rejected rather
    than queued.
  - Auth is handled by the Codex CLI itself — run `codex login` before using
    this provider.
- **`openai-agents`** — OpenAI Agents SDK via `@openai/agents`
  (`src/providers/openai-agents.ts`). Auth uses the existing OpenAI API key
  from the PacketADE keyring; Rust passes it to the sidecar only on
  `start_session` and the sidecar does not persist it. V1 focuses on parity
  with the Agents pane event contract: streaming text, local project-path
  tools, permission prompts, pending edit review, cancellation, MCP stdio
  passthrough, and model switching. SDK tracing/export, handoff UI, hosted
  sandboxes, Agent Builder, and voice agents are intentionally deferred.

## Protocol summary

**Protocol version: 9**. The version is advertised
in the `ready` event's `protocolVersion` field at startup, and the Rust
supervisor's `EXPECTED_PROTOCOL_VERSION` constant must match (negotiation is
warn-only: a version mismatch logs but doesn't block the connection). v2
added `set_permission_mode`, `set_model`, and `retry`; v3 added typed
attachments, per-hunk edit acceptance payloads, richer tool/plan/token
events, and resume tokens on `done`; v4 added `cancel_pending_tools`, which
drains parked permission/edit prompts as denied without killing the session;
v5 added `inject_user_turn` (kept) plus an in-process Flight Planner MCP
handshake and planner-tool result round-trip (removed in v7); v6 added the
typed `rate_limited` event, now a generic provider-quota signal; v7 (2026-07-11,
the planner-amputation refactor) deleted the entire in-process Flight Planner
MCP surface — `planner_tool`, `planner_tool_result`, and `mcpKind:"planner"`
are gone; v8 added remote-owned MCP filesystem sourcing and `mcp_sources`; v9
added required `toolUseId` correlation on `edit_response`, so a response resolves
one pending edit rather than draining the session. Providers advertise support by implementing the matching handler
methods on `ProviderHandler`; the registry emits a clean "not supported"
error when a provider skips one.

**stdin (requests, one per line):**

| type                   | purpose                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `start_session`        | Begin a new session with a provider                           |
| `send_message`         | Send a follow-up user message                                 |
| `permission_response`  | Approve/deny a tool call                                      |
| `edit_response`        | Approve/deny one pending file edit by `toolUseId` (v9)        |
| `cancel`               | Interrupt in-flight generation                                |
| `close_session`        | Tear down a session                                           |
| `set_permission_mode`  | v2: switch permission/approval mode mid-session               |
| `set_model`            | v2: swap the model without restarting the session             |
| `retry`                | v2: re-run the last turn (UI "Retry" affordance)              |
| `cancel_pending_tools` | v4: deny parked tool/edit prompts without cancelling the turn |
| `inject_user_turn`     | v5: inject a user/wake-trigger turn into a long-lived session |

**stdout (events, one per line):**

| type                         | purpose                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| `ready`                      | Emitted once at startup (includes pid)                      |
| `chunk`                      | Streamed assistant text                                     |
| `thinking` / `thinking_stop` | Reasoning stream                                            |
| `tool_start` / `tool_result` | Tool call lifecycle                                         |
| `permission_request`         | Ask supervisor for approval                                 |
| `pending_edit`               | Ask supervisor for edit approval                            |
| `done`                       | Turn complete (includes token counts)                       |
| `error`                      | Session or protocol error                                   |
| `plan_block`                 | v3: structured plan/TodoWrite mirror                        |
| `tool_output_extended`       | v3: tool exit code, paths, stdout/stderr                    |
| `turn_summary`               | v3: running token totals between turns                      |
| `rate_limited`               | v6: provider hit a quota limit and may include retry timing |

See `src/protocol.ts` for the full TypeScript definitions — that file is the
source of truth for the wire format.

**Stdout is reserved for protocol frames.** All human-readable logging goes
to stderr, where the supervisor can capture it without corrupting the JSON
stream.

## Production bundling

When packaging PacketADE for release (`pnpm tauri build`), the sidecar is
shipped alongside the app rather than relying on a system `node` or a
system-installed sidecar source tree:

- **Node runtime** — a pinned build of Node 24.15.0 is downloaded by
  `scripts/fetch-node.js` and staged as a Tauri `externalBin` under
  `src-tauri/binaries/`. The Tauri bundler picks it up from there. The
  fetcher covers all five supported target triples
  (`x86_64-pc-windows-msvc`, `x86_64-apple-darwin`, `aarch64-apple-darwin`,
  `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`); see
  [`dev/multi-platform-build.md`](../dev/multi-platform-build.md) for the
  full per-platform prerequisites and `TAURI_TARGET` usage.
- **Sidecar payload** — the `agent-sidecar/` source, the compiled
  `dist/` output, and a pruned `node_modules/` containing only production
  dependencies are bundled as Tauri resources. The supervisor locates
  the entry script under the app's resource dir at runtime.
- **Pruning** — `scripts/prune-sidecar.js` (invoked via `pnpm sidecar:prune`)
  runs `pnpm -C agent-sidecar install --prod --ignore-scripts` to drop
  devDependencies (`typescript`, `@types/node`) from `node_modules`. This
  step runs as part of the `prebundle` chain that Tauri's
  `beforeBuildCommand` executes before the Vite build.

### After a production build

The prune step is **destructive** to the sidecar's dev tooling. After
running `pnpm tauri build` (or `pnpm sidecar:prune` directly), restore
devDependencies before doing further sidecar development:

```bash
pnpm sidecar:install
```

### Overriding paths in release

Two environment variables override the bundled locations at runtime —
useful for running a packaged build against a working-copy sidecar or a
custom Node binary:

- `PACKETADE_SIDECAR_PATH` — absolute path to the compiled sidecar entry
  script (normally `agent-sidecar/dist/index.js`).
- `PACKETADE_NODE_PATH` — absolute path to the `node` binary the
  supervisor should spawn (normally the bundled `externalBin`).

### Auto-updates

Auto-updates are documented in [`dev/updater-setup.md`](../dev/updater-setup.md)
(not yet enabled).
