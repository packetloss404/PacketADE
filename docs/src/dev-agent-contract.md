# Agent event contract

Three completely different agent backends serve PacketBench conversations, and
the frontend cannot tell which one produced a given turn. That is not an
accident of layering — it is a contract, enforced by having all three emit
byte-identical Tauri events. This page documents that contract precisely enough
to add a fourth transport.

## The shape

Every event is named:

```
api-agent:{kind}:{sessionId}
```

`sessionId` is always **PacketBench's** conversation id. The sidecar has its own
notion of a session and the ACP engine mints its own id on `session/new`, but
neither ever appears in an event name — the ACP module states it flatly at
`src-tauri/src/acp/routing.rs:9`: *"PacketBench mints the conversation id and it
is the session id everywhere in the app."*

Two global, unkeyed events sit alongside these:

| Event | Emitted by | Meaning |
| --- | --- | --- |
| `provider-auth:changed` | `src-tauri/src/commands/auth_watcher.rs` | A watched credential file changed — refresh auth badges |
| `sidecar-status:changed` | `SIDECAR_STATUS_EVENT`, `src-tauri/src/commands/agent_sidecar/mod.rs:195` | Sidecar lifecycle transition (ready / restarting / down / not_started) |

### Name helpers, not string literals

Three files spell the names, and they must agree:

| Side | File |
| --- | --- |
| In-process runtime | `src-tauri/src/commands/api_agent.rs:215` |
| Sidecar + ACP (shared) | `src-tauri/src/commands/agent_sidecar/events.rs:13` |
| Frontend | `src/lib/events.ts:28` |

`events.rs` is `pub(crate)` rather than private specifically so the ACP
transport can reuse the same helpers verbatim
(`src-tauri/src/commands/agent_sidecar/mod.rs:19`). Do not build an event name
by interpolation at a call site.

## The fifteen kinds

| Kind | Payload | In-process | Sidecar | ACP |
| --- | --- | :-: | :-: | :-: |
| `chunk` | raw `String` (not an object) | ● | ● | ● |
| `thinking` | `{ text }` | ● | ● | ● |
| `thinking-stop` | `null` | ● | ● | ● |
| `tool-start` | `{ id, name, input? }` | ● | ● | ● |
| `tool-result` | `{ id, name, content, is_error, input }` | ● | ● | ● |
| `permission-request` | `{ id, name, arguments, batch_id?, batch_size? }` | ● | ● | ● |
| `pending-edit` | `{ id, path, content, before? }` | ● | ● | ○ |
| `edit-baseline` | `{ id, path, before? }` | ● | ● | ○ |
| `plan-block` | `{ items: PlanItem[] }` | ○ | ● | ● |
| `tool-output-extended` | `{ id, exit_code?, modified_paths?, stdout?, stderr? }` | ○ | ● | ○ |
| `turn-summary` | `{ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, reasoning_tokens?, address? }` | ○ | ● | ○ |
| `mcp-sources` | `{ sources[], readErrors[] }` | ○ | ● (remote only) | ○ |
| `done` | `{ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cancelled, resume_token? }` | ● | ● | ● |
| `error` | `{ message }` | ● | ● | ● |

● = emitted, ○ = never emitted by that transport.

> **Important:** "Byte-identical contract" means the *names and field names*
> match. It does not mean every transport emits every kind. A consumer must
> treat every event as optional and every optional field as absent. Nine kinds
> are the guaranteed core (`chunk`, `thinking`, `thinking-stop`, `tool-start`,
> `tool-result`, `permission-request`, `plan-block`, `done`, `error`) — and even
> `plan-block` only arrives from Claude rows in practice
> (`src/lib/agentCapabilities.ts:285`).

### Payload divergences worth knowing

The sidecar payload structs are a **superset** of the in-process ones. Compare
`src-tauri/src/commands/api_agent.rs:265` with
`src-tauri/src/commands/agent_sidecar/events.rs:64`:

- `tool-start` carries `input` from the sidecar; the in-process runtime has no
  such field and delivers the raw tool input on `tool-result` instead. The
  frontend stashes whichever arrives first
  (`src/stores/apiAgentListeners.ts:259`).
- `permission-request` carries `batch_id` / `batch_size` from the sidecar so the
  UI can render "approve all N" with the right denominator; the in-process
  struct has neither.
- `done` carries `resume_token` from the sidecar; the in-process `DonePayload`
  does not.

All optional fields are `#[serde(skip_serializing_if = "Option::is_none")]`, so
they are simply absent rather than `null`.

### `chunk` is a bare string

Every other kind serialises a struct. `chunk` emits the delta text directly:

```rust
let _ = app_handle.emit(&chunk_event(session_id), &text);
```

Frontend consumers therefore `listen<string>`, not `listen<{text: string}>` —
see `src/stores/apiAgentListeners.ts:254` and the note at
`src/components/views/github/AICatchUpButton.tsx:78`.

### `plan-block` items are camelCase on the wire

`PlanItemPayload` renames `active_form` to `activeForm`
(`src-tauri/src/commands/agent_sidecar/events.rs:150`), and there is a unit test
pinning exactly that, asserting `value["activeForm"]` is present and
`value.get("active_form")` is not
(`src-tauri/src/commands/agent_sidecar/events.rs:229`). The rest of the contract
is snake_case; this one field is not.

### ACP deliberately withholds `turn-summary`

The engine's usage totals are session-**cumulative**. Stamping them onto each
turn would make the ledger recount the whole session every turn, so the ACP
transport emits no per-turn summary at all. The pane queries
`acp_session_usage` instead, on mount and on each turn ending — never on a
timer. The reasoning is written out at
`src/components/agents/hooks/useEngineSessionUsage.ts:5`.

### ACP emits nothing during a `session/load` replay

When adopting a session the engine already holds, ACP replays the stored
transcript as `session/update` notifications — including `user_message_chunk`
updates. The contract has no user-turn event, so the translation layer could
only drop those. Admitting the rest would produce a transcript with every
assistant turn present, every user turn missing, and (because `chunk` payloads
stream into whatever assistant message is open) the whole history welded into
one bubble. So `translate` returns *no* emissions while replaying
(`src-tauri/src/acp/events.rs:448`). The adopting conversation carries a plain
statement that the history lives in the engine instead.

## Consumers

`installApiAgentListeners` (`src/stores/apiAgentListeners.ts:215`) is the one
place that subscribes to all fifteen for a conversation and returns a single
teardown closure. It is not the only consumer, though — several one-shot
features pre-allocate a session id and subscribe to just
`chunk` / `done` / `error`:

| Consumer | File |
| --- | --- |
| Code Quality AI explain / summarise | `src/components/quality/QualityAIExplanation.tsx:93`, `QualityAISummary.tsx:97` |
| GitHub AI catch-up | `src/components/views/github/AICatchUpButton.tsx:81` |
| PR description / review | `PRDescriptionButton.tsx:102`, `PRReviewPanel.tsx:89` |
| Flight attempt terminal detection | `src/stores/asyncAttemptTerminalListeners.ts:66` |
| Reviewer gate | `src/stores/reviewerGateRuntime.ts:161` |

That is the point of the contract: any feature that wants a streamed model
answer allocates an id, subscribes to three events, and gets the same behaviour
regardless of which provider row the user has configured.

### Streaming is coalesced, and the flush order matters

`createStreamCoalescer` buffers `chunk` and `thinking` deltas and applies at
most one store write per animation frame. `done`, `error` and `thinking-stop`
all call `coalescer.flushNow()` **before** flipping `isStreaming` off — without
that, the pending frame finds no streaming message and the turn's tail chunks
are lost (`src/stores/apiAgentListeners.ts:326`).

## The sidecar protocol

The sidecar is a separate Node package (`agent-sidecar/`, version 0.5.0) hosting
two vendor agent SDKs that have no Rust equivalent: `@anthropic-ai/claude-agent-sdk`
and `@openai/agents`.

### Wire format

Newline-delimited JSON over stdio. `stdout` is reserved for protocol frames;
all human-readable logging goes to `stderr` so the supervisor's line parser
stays clean (`agent-sidecar/src/index.ts:15`).

Request and event types live in `agent-sidecar/src/protocol.ts`. The dispatcher
in `agent-sidecar/src/index.ts:25` parses one line at a time and keeps a promise
queue so request *parsing* stays ordered, while `SessionRegistry` preserves
per-session work ordering and lets unrelated sessions progress concurrently.

### Requests (host → sidecar)

`start_session`, `send_message`, `permission_response`, `edit_response`,
`cancel`, `close_session`, `set_permission_mode`, `set_model`, `retry`,
`cancel_pending_tools`, `inject_user_turn`.

### Events (sidecar → host)

`ready`, `chunk`, `thinking`, `thinking_stop`, `tool_start`, `tool_result`,
`permission_request`, `pending_edit`, `edit_baseline`, `plan_block`,
`tool_output_extended`, `turn_summary`, `rate_limited`, `mcp_sources`, `done`,
`error`.

Note the naming difference: the sidecar uses `snake_case` event *types*
(`thinking_stop`), and the Rust supervisor translates them into kebab-case Tauri
event *names* (`api-agent:thinking-stop:<id>`).

### What each protocol version added

`PROTOCOL_VERSION` is currently **11** (`agent-sidecar/src/protocol.ts:67`).

| Version | Added |
| --- | --- |
| v2 | `set_permission_mode`, `set_model`, `retry` requests |
| v3 | typed `attachments` on start/send; `mergedContent` on `edit_response`; `batchId`/`batchSize` on `permission_request`; `resumeToken` on `done`; the `plan_block`, `tool_output_extended` and `turn_summary` events |
| v4 | `cancel_pending_tools` — drain parked prompts as denied without killing the agent loop |
| v5 | `inject_user_turn` (plus a planner MCP surface, removed in v7) |
| v6 | the typed `rate_limited` event |
| v7 | removed the planner MCP surface (`planner_tool`, `planner_tool_result`, `mcpKind`) |
| v8 | `sourceMcpFromFs` on `start_session` + the `mcp_sources` event |
| v9 | required `toolUseId` on `edit_response` |
| v10 | `cancelled` on the terminal `done` event |
| v11 | `mcpTrustSnapshot` on `start_session` |

### Version negotiation is asymmetric — and this is where the docs are wrong

`CLAUDE.md` says the supervisor "reconciles versions on the `ready` event and
warns (non-fatal) on mismatch." **That has not been true since v11.** The code
has two constants:

```rust
pub(super) const EXPECTED_PROTOCOL_VERSION: u32 = 11;
pub(super) const MINIMUM_PROTOCOL_VERSION: u32 = 11;
```

(`src-tauri/src/commands/agent_sidecar/mod.rs:112` and `:122`.)

- A version **above** `EXPECTED` is a warning. Every version through v10 added
  *requests*; send one to an older sidecar and it replies "Unknown request
  type" — loud, immediate and safe.
- A version **below** `MINIMUM` is refused. The sidecar is marked
  `SidecarState::Incompatible` and every `start_session` is rejected with an
  actionable message.

The reason is spelled out at `src-tauri/src/commands/agent_sidecar/mod.rs:104`:
v11 added a *field* on an existing request, and an older sidecar does not reject
an unknown JSON field — it ignores it and then runs every forwarded MCP server
with no filtering at all. The user sees a working session. The degradation is
silent and it is a security downgrade, so it is a floor, not a warning.

> **Warning:** A `ready` event with **no** `protocolVersion` at all also fails
> the floor. `protocol_meets_floor(None)` returns false
> (`src-tauri/src/commands/agent_sidecar/mod.rs:184`): "we could not tell" is
> the same answer as "no" when the thing we could not tell is whether MCP trust
> is enforced. Four Rust tests pin this behaviour, including one whose only job
> is to remind you that raising `MINIMUM` is a deliberate, separate decision
> from bumping `EXPECTED`.

### Raising the version

1. Change `PROTOCOL_VERSION` in `agent-sidecar/src/protocol.ts:67` and add a
   dated comment block explaining what changed.
2. Change `EXPECTED_PROTOCOL_VERSION` in
   `src-tauri/src/commands/agent_sidecar/mod.rs:112` and mirror the comment.
3. Raise `MINIMUM_PROTOCOL_VERSION` **only** if the change is security-relevant
   and an older peer would degrade silently. Ordinary feature additions stay
   warn-only so mixed-version pairings keep working.
4. Update the sidecar smoke tests (`pnpm sidecar:check`).
5. Update the table above and the one in `CLAUDE.md`.

### `mcpTrustSnapshot` — why v11 exists

`McpTrustSnapshot` (`agent-sidecar/src/protocol.ts:104`) freezes, per server, at
session start: `allowReads`, `allowWrites`, `allowNetwork`, `allowedRoots`,
`allowedToolNames`, `denialFloors`, and a `revision`. The sidecar filters
transports and tools against it. Editing Settings mid-session therefore cannot
broaden a running session's authority — you have to reconnect.

An **omitted** field is migrated by the sidecar to conservative read-only
defaults. An **explicit empty array** grants no MCP servers. Those are different
things; do not collapse them.

## Session ownership and routing

`start_api_agent_session` (`src-tauri/src/commands/api_agent.rs:993`) is the one
branch point:

```rust
if crate::acp::routing::is_acp_provider(&provider) { … return }
if is_sidecar_provider(&provider)                 { … return }
// else: in-process LlmProvider runtime
```

Every *post*-start command — `send`, `cancel`, `change_model`, `set_plan_mode`,
`set_permission_mode`, `respond_permission`, `set_approve_writes`,
`respond_edit`, `cancel_pending_tools`, `retry_last_turn`, `close_session` —
asks the owners instead of re-deriving from the provider id:

```rust
if crate::acp::routing::owns_session(&acp, &session_id) { … }
// SidecarManager::owns_session(…) for the sidecar half
```

> **Warning:** Ownership is **lifecycle** state, not turn state. A per-turn
> `error` from the sidecar deliberately does not drop it. The comment at
> `src-tauri/src/commands/agent_sidecar/handler.rs:773` records why: dropping
> ownership on an error reroutes the next `send` into the in-process runtime
> ("No active session"), permanently bricking the conversation while leaking the
> sidecar-side session. Ownership is cleared only by `forward_close` and by the
> supervisor's crash fan-out.

### Crash fan-out

When the sidecar child dies, the supervisor emits `api-agent:error:*` on every
currently-owned **local** session
(`src-tauri/src/commands/agent_sidecar/supervisor.rs:1241`) with the message
"Sidecar restarted — please resend your message to continue this conversation."
Restart is rate-limited: `MAX_RESTARTS_IN_WINDOW = 3` within
`RESTART_WINDOW = 60s` (`src-tauri/src/commands/agent_sidecar/mod.rs:189`).

## Entry-point resolution

The supervisor resolves the sidecar script and the Node binary independently, in
priority order (`src-tauri/src/commands/agent_sidecar/supervisor.rs:1476` and
`:1522`):

1. `PACKETBENCH_SIDECAR_PATH` / `PACKETBENCH_NODE_PATH` environment overrides
2. Dev: `CARGO_MANIFEST_DIR/../agent-sidecar/dist/index.js` plus system `node`
3. Release: `app_handle.path().resource_dir()/agent-sidecar/dist/index.js` plus
   the bundled Node via `app.shell().sidecar("node")`

> **Note:** In a **release** build the env overrides are ignored unless
> `PACKETBENCH_DEV_SIDECAR=1` is also set, and the refusal is logged. When an
> override is honoured in a release build, a warning is logged so it shows up in
> a bug report.

## Adding a provider

Which of the three transports you extend depends on what you are adding.

**A new HTTPS/SSE provider** — the in-process path:

1. Implement `LlmProvider` in a new `src-tauri/src/core/llm_<name>.rs` (or reuse
   `llm_openai_compat.rs` if the wire format is OpenAI's).
2. Add the id to `IN_PROCESS_PROVIDERS` and a match arm to `get_provider`
   (`src-tauri/src/core/llm_provider.rs:36`). The `every_advertised_in_process_provider_resolves`
   test fails if you do one without the other.
3. Add an arm to `provider_to_source` (`api_agent.rs:824`) so its spend is
   attributed correctly instead of falling through to `api-claude`.
4. Add the row to `src/lib/api-models.ts` and the `AgentCli` union.
5. Add the keyring key and the auth-badge probe mapping.

**A new agent SDK** — the sidecar path: add a handler under
`agent-sidecar/src/providers/`, register it in the `PROVIDERS` factory map
(`agent-sidecar/src/session-registry.ts:39`), and add the id to
`SIDECAR_PROVIDERS`.

**A new engine speaking its own protocol** — a fourth transport. The bar is:
translate into `api-agent:*` in one dedicated module of pure functions (as
`acp/events.rs` does), route ownership through an `owns_session` predicate, and
emit the same nine core kinds. If you cannot honestly emit `done` with token
counts, emit it with zeros and provide a query path — that is exactly what ACP
does.

## Retired ids stay readable

`api-openai-codex` was removed in July 2026. Persisted conversations on that id
stay readable, cannot start a turn, and say so in the transcript — see
`RETIRED_API_AGENTS` in `src/stores/agentTaskStore.ts`. The backend half is a
test asserting `!is_sidecar_provider("openai-codex")`
(`src-tauri/src/commands/agent_sidecar/mod.rs:330`), so a stale conversation is
never forwarded to a sidecar with no factory for it.

`api-claude-oauth` is likewise a historical id that no longer means OAuth: it is
the Claude Agent SDK on the Anthropic API key. It is unchanged because persisted
conversations store it verbatim and resume with it. See
[Agents & conversations](agents.html).

## Related

- [Architecture](dev-architecture.html) — where the transports sit in the process model
- [MCP hub](mcp.html) — the trust model `mcpTrustSnapshot` freezes
- [Invariants & tripwires](agent-invariants.html) — rules that look safe to break
