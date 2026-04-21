# packetade-agent-sidecar

Node sidecar that hosts LLM provider integrations for PacketADE. The Rust
Tauri backend (the "supervisor") spawns this process and talks to it over
newline-delimited JSON on stdin/stdout.

## Why a sidecar?

The Claude Agent SDK and OpenAI Codex SDK are both TypeScript libraries.
Rather than reimplementing them in Rust or shelling out to CLIs, we run them
in an isolated Node child process and stream structured events back to the
supervisor. The supervisor handles lifecycle, crash restart, and routing
events into Tauri event channels for the React UI.

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
  (`src/providers/openai-codex.ts`). Added in Phase 5. Known v1 limitations:
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

## Protocol summary

**Protocol version: 2** (bumped by Tier 3 slice B). The version is advertised
in the `ready` event's `protocolVersion` field at startup, and the Rust
supervisor's `EXPECTED_PROTOCOL_VERSION` constant must match. v2 added three
new request types — `set_permission_mode`, `set_model`, and `retry` — for
Claude-Code parity (command forwarding from the UI's `/model`, `/plan`, and
retry affordances). Providers advertise support by implementing the matching
handler methods on `ProviderHandler`; the registry emits a clean
"not supported" error when a provider skips one.

**stdin (requests, one per line):**

| type                 | purpose                                          |
| -------------------- | ------------------------------------------------ |
| `start_session`      | Begin a new session with a provider              |
| `send_message`       | Send a follow-up user message                    |
| `permission_response`| Approve/deny a tool call                         |
| `edit_response`      | Approve/deny a pending file edit                 |
| `cancel`             | Interrupt in-flight generation                   |
| `close_session`      | Tear down a session                              |
| `set_permission_mode`| v2: switch permission/approval mode mid-session  |
| `set_model`          | v2: swap the model without restarting the session |
| `retry`              | v2: re-run the last turn (UI "Retry" affordance) |

**stdout (events, one per line):**

| type                 | purpose                                          |
| -------------------- | ------------------------------------------------ |
| `ready`              | Emitted once at startup (includes pid)           |
| `chunk`              | Streamed assistant text                          |
| `thinking` / `thinking_stop` | Reasoning stream                         |
| `tool_start` / `tool_result` | Tool call lifecycle                      |
| `permission_request` | Ask supervisor for approval                      |
| `pending_edit`       | Ask supervisor for edit approval                 |
| `done`               | Turn complete (includes token counts)            |
| `error`              | Session or protocol error                        |

See `src/protocol.ts` for the full TypeScript definitions — that file is the
source of truth for the wire format.

**Stdout is reserved for protocol frames.** All human-readable logging goes
to stderr, where the supervisor can capture it without corrupting the JSON
stream.

## Production bundling

When packaging PacketADE for release (`pnpm tauri build`), the sidecar is
shipped alongside the app rather than relying on a system `node` or a
system-installed sidecar source tree:

- **Node runtime** — a pinned build of Node 20.17.0 is downloaded by
  `scripts/fetch-node.js` and staged as a Tauri `externalBin` under
  `src-tauri/binaries/`. The Tauri bundler picks it up from there.
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
