# packetade-agent-sidecar

Node sidecar that hosts LLM provider integrations for PacketADE. The Rust
Tauri backend (the "supervisor") spawns this process and talks to it over
newline-delimited JSON on stdin/stdout.

## Why a sidecar?

The API-key-backed Claude Agent SDK and OpenAI Agents SDK providers share the
same sidecar protocol. The former `codex exec` chat provider was removed in
July 2026; Codex CLI remains a separate PTY-backed Workspace client. Keeping
the surviving SDK providers in an isolated Node child process lets the Rust
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
- **`claude-oauth`** — Anthropic **API-key** auth via
  `@anthropic-ai/claude-agent-sdk` (`src/providers/anthropic.ts`). Added in
  Phase 4. Supports the full tool loop, streaming output, MCP server
  passthrough, and permission / edit approval requests.

  The registry key is historical: it says `oauth`, but since 2026-07 this
  provider authenticates with an **Anthropic API key**, loaded by Rust from
  the OS keyring (`api-key-anthropic`) and sent transiently in
  `start_session.apiKey`. The provider sets it as `ANTHROPIC_API_KEY` in the
  SDK's `Options.env` — the mechanism the Agent SDK Quickstart documents —
  and blanks `CLAUDE_CODE_OAUTH_TOKEN` so an ambient subscription token
  cannot win. A missing key fails the session immediately with a Settings
  pointer; it never silently falls back to whatever credential the machine
  has. The key was kept as-is because persisted conversations store
  `claude-oauth` in `AgentConversation.provider` and resume with it verbatim.

  Rationale: Anthropic's legal-and-compliance page states that "Anthropic does
  not permit third-party developers to offer Claude.ai login or to route
  requests through Free, Pro, or Max plan credentials on behalf of their
  users", and the Agent SDK overview directs developers to "use the API key
  authentication methods described in the Quickstart instead". The SDK is the
  sanctioned path; only the credential was wrong.

  **Removed 2026-07: `openai-codex`.** That provider drove `codex exec` as a
  subprocess on a ChatGPT Plus/Pro subscription login. Without a subscription
  it bought nothing over `openai-agents` — same API, same key — and it could
  not service a per-tool approval round-trip. `src/providers/openai-codex.ts`,
  `src/codex-mcp.ts`, and `src/mcp-trust-proxy.ts` were deleted with it. The
  registry now rejects the id as an unknown provider, which
  `registry-smoke.mjs` asserts.

- **`openai-agents`** — OpenAI Agents SDK via `@openai/agents`
  (`src/providers/openai-agents.ts`). Auth uses the existing OpenAI API key
  from the PacketADE keyring; Rust passes it to the sidecar only on
  `start_session` and the sidecar does not persist it. V1 focuses on parity
  with the Agents pane event contract: streaming text, local project-path
  tools, permission prompts, pending edit review, cancellation, MCP stdio
  passthrough, and model switching. SDK tracing/export, handoff UI, hosted
  sandboxes, Agent Builder, and voice agents are intentionally deferred.

## Protocol summary

**Protocol version: 11**. The version is advertised
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
