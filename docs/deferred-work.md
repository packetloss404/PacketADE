# Deferred work — Agents tab

Backlog of things intentionally **not** done during the Waves 1–4 modernization +
the Codex/PTY/harness fixes, with enough detail to resume each cold. Ordered
roughly by value. The full 314-finding review that seeded the waves lives in
[`agents-tab-modernization-plan.md`](./agents-tab-modernization-plan.md).

---

## 1. Codex — interactive per-command approvals (plan / manual modes)
**Status:** Not supported. `modeToCodexFlags` maps every mode to `-a never`; the
sandbox (`read-only` for plan, `workspace-write` otherwise) is the safety
boundary instead of per-command prompts.

**Why deferred:** `codex exec` blocks reading stdin, so we close stdin after
spawning (see the "Reading additional input from stdin" fix). That removes the
channel the old `respondPermission` used to send approval responses back, so
`-a on-request` would stall the turn.

**Resume:** `agent-sidecar/src/providers/openai-codex.ts` (`modeToCodexFlags`,
`respondPermission`). Check whether codex 0.142+ exposes an approval channel that
doesn't need an open stdin (a control fd, or `codex proto` / app-server mode). If
so, run Codex through that persistent mode instead of one-shot `exec` and wire
`permission_request` ↔ the response channel. Otherwise this stays as-is.

## 2. MCP servers at launch (composer)
**Status:** MCP can only be picked mid-conversation; no launcher picker.

**Why deferred:** needs UI + plumbing through the launch path. The data param
already exists (`enabledMcpServerIds` on `createApiConversation`, now in its
options object after Wave 4).

**Resume:** add an MCP multi-select to `src/components/agents/AgentInputArea.tsx`
(reuse `mcpStore` + the `Popover` primitive), pass `enabledMcpServerIds` through
the `createApiConversation` options object, and confirm the Rust/sidecar honor it
at `start_api_agent_session`.

## 3. Per-run cost cap
**Status:** Cost is read-only; nothing stops a runaway autonomous run.

**Why deferred:** needs a live cost-tracking hook in the agent loop that cancels
on threshold.

**Resume:** add a `costCapUsd` field to the launch options; in
`src-tauri/src/commands/api_agent.rs` (`run_agent_loop`) or the `turn_summary`
handler, accumulate cost per turn and cancel the session when exceeded. UI: a cap
input in the composer's Advanced accordion. (Note: with `MAX_TOOL_ITERATIONS` now
150 and the autonomy harness, runs are longer — this is more relevant now.)

## 4. Cross-provider reasoning-effort / thinking-budget control
**Status:** No control. Only a read-only heuristic speed pill and a hidden
`Alt+.` model-swap hack.

**Why deferred:** each provider applies it differently — Anthropic extended-
thinking budget, OpenAI/Codex `reasoning_effort` / `model_reasoning_effort` — so
it needs per-provider plumbing frontend → Rust/sidecar.

**Resume:** add a `reasoningEffort` ('low'|'medium'|'high') field to the launch
options + a `SegmentedControl` in the composer. Plumb: Anthropic provider
(thinking budget), Codex (`-c model_reasoning_effort=…`), OpenAI (`reasoning_effort`).
Files: composer, `createApiConversation` options, `api_agent.rs`, the sidecar
providers.

## 5. Full `agentTaskStore` module split
**Status:** Wave 4 did a **light** extraction (persistence/hydration helpers →
`agentConversationPersistence.ts`, public API preserved via re-exports). The full
split is deferred.

**Why deferred:** the store is 1839 lines with 50+ importers; a full split is high
regression risk for zero user-visible value.

**Resume:** keep extracting cohesive slices (legacy PTY tasks, `api-agent`
listeners, resume logic, conversation CRUD) into sibling modules, re-exporting
from `agentTaskStore.ts` so importers don't change. Do it incrementally, running
`tsc` + `vitest` after each extraction.

## 6. Diff viewer — extra controls
**Status:** Wave 4 rebuilt the diff engine (interleaved rows, line-number gutter,
background-tint). Still missing: word-wrap toggle, unified/split toggle, copy
diff/file, expand-context.

**Resume:** `src/components/agents/diff/*` + `HunkSelectableDiff.tsx` — add the
toolbar controls on top of the new shared row renderer.

## 7. Line-ending normalization (repo-wide)
**Status:** Added `.gitattributes` with `* -text` (preserves the repo's mixed
CRLF/LF, prevents tooling from silently flipping them). A full convergence to LF
is deferred.

**Why deferred:** a repo-wide `git add --renormalize` is a large one-time diff —
a deliberate call, not something to slip into a feature commit.

**Resume:** change `.gitattributes` to `* text=auto`, run
`git add --renormalize .`, and commit as a single dedicated "normalize line
endings to LF" commit (ideally when no big feature branch is open).

---

## Validation TODOs (not code — things to confirm on a real run)

- **Autonomy harness** (`src/lib/agent-harness.ts`) — shipped but not verified on
  a real multi-step task. Run tasks and tune the prompt: watch for over-running,
  stopping too early anyway, wrong tone, or conflicts with plan mode. This is the
  highest-value thing to babysit.
- **PTY orphan reaper** — verify live: open a workspace pane with an agent, close
  it, confirm no orphaned child survives; and that a crash/force-quit is swept on
  next launch (`src-tauri/src/core/pty.rs` `reap_orphaned_pty_children`).
- **Codex streaming feel** — `codex exec` emits complete blocks, not token
  deltas, so it's choppier than the direct APIs. If it matters, investigate a
  Codex streaming/delta mode; otherwise it's inherent.
