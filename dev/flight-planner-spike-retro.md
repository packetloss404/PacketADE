# Flight Planner — Spike Retrospective

Date: 2026-05-14
Status: **GO** for E1–E8 + E10 implementation. No architecture changes
required. One pre-existing bug surfaced that ships as part of E1.

Companion to [`flight-planner-plan.md`](./flight-planner-plan.md).

## What we spiked

Before committing to the locked design's load-bearing assumptions, we
ran two parallel proof-of-concept investigations:

1. **In-process MCP transport in the shipped `@anthropic-ai/claude-agent-sdk`**
   — does the SDK version we currently bundle support registering a
   live `McpServer` instance into a Claude `query()`, or do we need to
   fall back to a spawned-child-process MCP server per planner session?
2. **Long-lived session user-turn injection** — can the existing
   `forward_send` machinery be reused for wake triggers, or do we need
   a new wire-level mechanism?

## Results

### Spike #1 — in-process MCP: **PASSED**

SDK version `0.2.116` supports `McpSdkServerConfigWithInstance` directly.
End-to-end smoke proved a tool call round-trips: SDK → in-sidecar
handler → result → assistant response → clean termination. ~37K
cache-read tokens, ~270 output tokens, well under timeout.

**Findings folded into the spec:**

1. Tool names take the form `mcp__<serverKey>__<toolName>` where
   `serverKey` is the `mcpServers` record key (NOT the name passed to
   `createSdkMcpServer`). Spec pins `serverKey: "planner"` so allowed-tools
   list reads `mcp__planner__create_milestone` etc.
2. `McpServer` instances cannot cross the wire — the live JS object
   lives entirely in the sidecar process. The Rust side does NOT route
   `mcpServers` config containing planner tools. Instead, the
   `StartSessionRequest` carries a new `mcpKind: "planner"` flag and
   the sidecar constructs the in-process planner server locally before
   merging it into `query()`'s `mcpServers` map.
3. No fallback design needed. Stdio MCP remains available via the same
   `mcpServers` slot if we ever want hot-reload of planner code without
   restarting the sidecar.

### Spike #2 — wake-trigger injection: **PASSED with a critical bug fix in scope**

All three load-bearing claims verified by code inspection:

- (a) `forward_send` can be called on a running session after the
  first response. `anthropic.ts:754-773`, `agent_sidecar.rs:472-489`,
  `session-registry.ts:99-113`.
- (b) New user messages append to the same conversation with full prior
  context. Single `query()` per session shares one prompt iterable
  across all turns. `anthropic.ts:525`.
- (c) Responses stream back over existing `api-agent:chunk:<sid>` /
  `api-agent:done:<sid>` Tauri events.

**Critical finding — pre-existing bug:** `anthropic.ts:547-573`
`pumpMessages` breaks out of `for await (... of this.q)` on the first
`result` message. The SDK's own type docs (`sdk.d.ts:1452-1453`)
explicitly require consumers to **keep iterating after `result`**, and
`Query` is declared as `AsyncGenerator<SDKMessage, void>` — continuous
across all turns.

**Consequence:** any second-turn `sendMessage` correctly pushes onto
`prompt`, the SDK emits a new turn — but nothing is consuming `this.q`,
so no events reach the wire. The session appears to hang.

**This already affects production** — the AgentsView multi-turn chat
for `api-claude-oauth` rides the same path. The fact that it sometimes
works is incidental (`Query` may terminate on `result` in some SDK
branches but per spec it doesn't).

**Fix (in scope for E1, ~6 lines):** remove the `break` on `anthropic.ts:555`;
let `for await` iterate until the prompt iterable naturally completes
on `close_session`. `handleMessage` already emits `done` per result
(line 736). Pattern matches what `openai-agents.ts` already does.

**Side benefits:** the existing `PushableAsyncIterable` correctly
serializes bursty pushes (8 wake triggers in 1s enqueue cleanly), and
the SDK processes the prompt iterable strictly serially, so the
locked plan's 2-3s wake-consumer debounce is the right mitigation.

## Decision

**Proceed with E1–E8 + E10 as planned in [`flight-planner-plan.md`](./flight-planner-plan.md).**

The two updates below land in the spec doc alongside this retro. No
deeper revisions needed.

### Spec amendments

1. **Pump-break bug fix** is now an explicit E1 deliverable (in addition
   to the originally-scoped struct/registry/protocol/wake-bus work). The
   fix unblocks both the planner *and* the existing multi-turn chat.
2. **MCP transport detail**: planner tools constructed in-sidecar; wire
   protocol carries `mcpKind: "planner"` trigger flag, not the
   `McpServer` instance.
3. **Tool naming convention**: pin `mcpServers["planner"] = …` so all
   tool names are `mcp__planner__<tool>`. `allowedTools` list reads
   accordingly.

### Files touched by spikes (uncommitted, can keep or discard)

- `agent-sidecar/test/spike-mcp-inproc.mjs` — recommend **keep** as a
  living smoke test under `pnpm test:sidecar` (rename to
  `mcp-inproc-smoke.mjs` to match convention).
- No file from spike #2 (verification was read-only).
