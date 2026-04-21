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

Phase 3 ships the protocol skeleton plus an **echo** provider for end-to-end
validation. Real providers land later:

- Phase 4: `claude-oauth` (via `@anthropic-ai/claude-agent-sdk`)
- Phase 5: `openai-codex`

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

## Protocol summary

**stdin (requests, one per line):**

| type                 | purpose                                          |
| -------------------- | ------------------------------------------------ |
| `start_session`      | Begin a new session with a provider              |
| `send_message`       | Send a follow-up user message                    |
| `permission_response`| Approve/deny a tool call                         |
| `edit_response`      | Approve/deny a pending file edit                 |
| `cancel`             | Interrupt in-flight generation                   |
| `close_session`      | Tear down a session                              |

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
