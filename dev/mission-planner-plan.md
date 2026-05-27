# Mission Planner — Locked Design (v1)

Locked v1 reference for the autonomous Mission Planner work-stream. For current
outstanding work, use [`../backlog.md`](../backlog.md). For manual release
sign-off, use
[`mission-planner-v1-acceptance-runbook.md`](./mission-planner-v1-acceptance-runbook.md).
All implementation agents touching Mission Planner internals should still read
this top-to-bottom before changing that surface.

Status: **locked 2026-05-14** after a two-agent independent-draft synthesis
and decisions from the project owner. Updated 2026-05-27 to clarify live
ownership only; no design semantics changed.

## Why we're building this

Today, "Missions" (internal type `Flight`) launch through a modal that
asks for a prompt + targets. The project owner has *never seen a mission
fully populate* because the launch friction stops them every time. We're
replacing that entry path with a **conversational spec mode** that an
**autonomous planner agent** owns end-to-end.

## What it is

One long-lived Claude session per Mission, running through the existing
sidecar via `api-claude-oauth` (uses the user's Claude subscription, not
API credit):

1. Starts as the chat partner in **spec mode** — a full-pane chat that
   replaces the current `MissionsView` empty-state buttons.
2. On user **Launch** → decomposes the spec into milestones + tasks,
   streams the plan into the mission detail pane.
3. **Owns** the mission for its whole life: reacts to task completions,
   replans on failures, escalates to user on gates, can spawn one
   helper-planner *(deferred to v1.1)*.
4. Maintains a per-mission **journal** (markdown rendered in a new
   Journal tab on `FlightDetailPane`, exportable to
   `~/.packetade/missions/<shortId>_<mission_id>.md`; early drafts used
   `<shortId>.md`).

## Locked decisions

### Models
- **Primary**: `claude-sonnet-4-6`
- **Helper** *(v1.1)*: `claude-opus-4-7`, one-shot per mission

### Lifecycle
`spec → planning → active → review → paused → done|failed|cancelled`

(`paused` retained because it's already wired through
`pauseFlight`/`resumeFlight`. `draft`/`ready` are legacy and untouched.)

### Planner tools (callable via in-process MCP)
- `create_milestone(title, goal, dependencies?)`
- `create_task(milestone_id, title, prompt, agent_id, target_spec)`
  — **target_spec uses the async-attempts shape** (`AttemptTargetSpec`)
- `update_task(task_id, patch)`
- `mark_task_blocked(task_id, reason)`
- `replan_after_failure(task_id) → new task subtree`
- `request_user_approval(question, options)` — **async return**
  (sentinel `pending_approval:<id>`, planner keeps working)
- `complete_mission(summary)`

Deferred for v1.1 and intentionally not exposed in v1:
- `spawn_helper_planner(scope, reason)`

### Wake triggers
`task_completed`, `task_failed`, `approval_gate_reached`,
`collision_detected`, `user_message_in_journal`, `quota_exhausted`

### Budgets (corrected from initial brief)
| Mode | Output `max_tokens` | Wake-msg input pack (chars) |
|---|---|---|
| Decomposition | 8K | ~120K |
| Reactive | 4K | ~40K |
| Replan | 6K | ~80K |
| Helper *(v1.1)* | 32K | ~350K |

### Caps
- Tool calls per tick: **Decomp 50, Reactive 25, Replan 25, Helper 30**
- Task ceiling before user approval gate: **60**
- Replans per task: **3** — **RateLimit / Network errors do NOT count**
  (use `core/error_classifier.rs::AiErrorCategory`)
- Helper-planner spawn: **1 successful spawn per mission**, failed-to-start
  doesn't count *(v1.1)*

### Safety rails
- Catch `RateLimitError` from SDK → `PlannerStatus::QuotaPaused` →
  exponential backoff (60s → 10min) → desktop notification → auto-resume
  on `retry-after`
- Kill-switch button in `FlightDetailPane` header
- **No predictive quota awareness** — Claude Agent SDK doesn't expose
  `anthropic-ratelimit-*` response headers
- Cold-start: planner sessions are ephemeral; on app restart, missions
  in `active` flip to `paused` and require user resume

### Executor path
Planner-emitted tasks run through the **async-attempts path**
(`asyncFlightStore.launchAsync` → `claude-oauth` API-agent sessions in
local/SSH worktrees) — **NOT** the PTY orchestrator.

Reason: the planner is itself a `claude-oauth` session, the user already
launches agents this way today, and the entire stack stays on one
execution model.

**Follow-up**: back-port milestone-gating + file-collision detection
from `orchestrator.rs` to the async-attempts path. Not blocking for v1
but should land soon after.

### Transport *(validated 2026-05-14 by spikes)*
- Planner tools exposed as **in-process MCP server** registered into
  the existing sidecar's Anthropic SDK call. SDK version `0.2.116`
  supports `McpSdkServerConfigWithInstance` natively — no fallback
  needed.
- **Tool naming**: `mcpServers["planner"] = createSdkMcpServer({ name: "mission-planner", tools: [...] })`
  so tool names are `mcp__planner__create_milestone`,
  `mcp__planner__create_task`, etc. The `allowedTools` list pins these
  exact names.
- **In-sidecar construction**: `McpServer` instances cannot cross the
  wire (live JS objects). The wire protocol carries a
  `mcpKind: "planner"` flag on `StartSessionRequest`; the sidecar
  constructs the planner MCP server locally in
  `agent-sidecar/src/mcp/mission-planner-server.ts` and merges it into
  `query()`'s `mcpServers` map.
- Wake-triggers injected via **new typed `inject_user_turn` sidecar
  message (introduced in protocol v5; live protocol is now v6)** — NOT
  sentinel-overloaded `send_message`.
  Content wrapped in
  `<wake_trigger source="..." kind="...">…</wake_trigger>` so the
  planner system prompt distinguishes wake-triggered re-entry from
  human user messages.
- **Pre-existing bug shipped fixed in E1**: `anthropic.ts:547-573`
  `pumpMessages` currently breaks out of the SDK message iterator on
  `result`, which silently kills multi-turn `api-claude-oauth` chat
  (and would kill the wake-trigger pipeline). Fix: remove the `break`
  on line 555; let `for await` run until the prompt iterable closes.
  ~6 lines. See [`mission-planner-spike-retro.md`](./mission-planner-spike-retro.md).

## Architecture surface

### New files
- `src-tauri/src/commands/mission_planner.rs` — registry, tool dispatch,
  wake consumer, journal writer
- `src-tauri/src/core/mission_planner_prompts.rs` — hand-authored
  system prompts + per-wake-trigger user-message builders
- `agent-sidecar/src/mcp/mission-planner-server.ts` — in-process MCP
  server with 7 real tool handlers (`noop` remains for E1 smoke
  back-compat; helper planner is deferred)
- `src/stores/missionPlannerStore.ts` — frontend state + event subs
- `src/components/missions/MissionSpecPane.tsx` — full-pane spec chat
- `src/components/missions/JournalTab.tsx` — markdown journal render

### Key edits
- `src/types/flight.ts` — add `spec` to `FlightStatus`,
  `plannerSessionId?`, `plannerStatus?`, `plannerCost?`, `plannerTokens?`
- `src-tauri/src/core/flight.rs` — mirror enum + DTO fields
  (`#[serde(default)]` for back-compat)
- `agent-sidecar/src/protocol.ts` — protocol v5 added
  `InjectUserTurnRequest`, `PlannerToolEvent`, `PlannerToolResultRequest`,
  and planner MCP fields; protocol v6 added `RateLimitedEvent`
- `src-tauri/src/commands/agent_sidecar.rs` — bump expected version, add
  `forward_inject_user_turn`, route `planner_tool` events to callback
- `src-tauri/src/commands/orchestration.rs` — emit `PlannerWakeEvent`
  at existing coordination-event hook sites
- `src/components/views/MissionsView.tsx` — replace empty state, mount
  spec pane on `status===spec`, add Journal tab, split cost in StatGrid

## Epics

| Epic | Title | Build-seq | Depends |
|---|---|---|---|
| E1 | Planner session plumbing (struct, registry, protocol v5 wake bus; live protocol now v6) | 1 | spike |
| E2 | Planner MCP tool surface (server + dispatcher + 7 handlers) | 2 | E1 |
| E3 | Spec mode UI (MissionSpecPane + MissionsView empty state) | 3 | E1 |
| E4 | Initial decomposition (system prompt + Launch transition) | 4 | E2, E3 |
| E5 | Reactive replan on task failure | 5 | E2, E4 |
| E6 | Safety rails (caps, ceiling, rate-limit, kill-switch) | 6 | E1–E5 |
| E7 | Mission journal (storage + Journal tab) | 7 | E1, E2 |
| E8 | Cost display (planner vs executor split) | 8 | E6, E7 |
| E10 | Context compaction (long-running session safety) | 9 | E1, E7 |
| ~~E9~~ | ~~Helper planner~~ — **deferred to v1.1** | — | — |

## Open risks (carry into implementation)

1. ~~In-process MCP transport unverified~~ **Resolved 2026-05-14** — SDK
   `0.2.116` supports `type: "sdk"` MCP server registration with a live
   `McpServer` instance. See `mission-planner-spike-retro.md`.
2. **Wake-trigger storm** — 8 parallel tasks finishing in 1s = 8
   sequential planner turns = TPM throttle. Mitigation: 2-3s debounce
   window in the wake consumer.
3. **Context compaction is mandatory, not optional** — without E10, any
   multi-day mission hits the 200K context wall and dies. E10 ships
   in v1.
4. **`request_user_approval` async-return needs prompt training** — the
   planner system prompt must teach the model that
   `pending_approval:<id>` means "filed, keep working" not "blocked".
5. **OAuth quota visibility** — no public Anthropic endpoint exposes
   Claude.ai subscription usage. E8 shows cumulative tokens as
   best-effort; subscription-% display deferred until/unless an endpoint
   appears.

## Build sequence

1. **Spike phase** (foreground, blocks everything): verify in-process
   MCP transport and long-lived-session user-turn injection.
2. **Implementation phase**: 8 implementation sub-agents in parallel
   where dependencies allow, following the epic dependency graph.
3. **Peer review per epic**: 2 reviewer sub-agents validate each epic
   against this spec before commit. No commit without both green-lights.

## Acceptance — the headline test

A user with zero existing missions clicks "Start a mission", types
"build a dark-mode toggle for the app", chats briefly with the planner,
hits Launch, and within ~30 seconds sees:

- Mission status: `active`
- 2-4 milestones populated in `MilestonesCard`
- 4-10 tasks with prompts visible in milestones
- At least one task running an executor session
- Journal tab showing the planning conversation + tool calls
- StatGrid showing both planner cost and (zero-so-far) executor cost

If any of those don't fire, the build isn't done.
