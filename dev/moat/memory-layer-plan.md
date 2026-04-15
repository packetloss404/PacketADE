# Memory Layer Plan

## Implementation Status — 2026-04-15

| Item | Status | Notes |
|------|--------|-------|
| Session-end hook | ✅ Done | `useTerminalSession.ts` calls `learnFromSession()` on PTY exit |
| Pattern refresh threshold | ✅ Done | `PATTERN_REFRESH_THRESHOLD = 3` in memoryStore.ts |
| Bounded memory context | ✅ Done | `CONTEXT_MAX_PATTERNS = 10`, `CONTEXT_MAX_SESSIONS = 5` |
| `isLearning` flag | ✅ Done | Uses `isLearning` instead of planned `memoryUpdateInProgress` |
| FlightMemorySnapshot type | ❌ Not started | Type doesn't exist in types/memory.ts |
| Flight→memory wiring | ❌ Not started | No snapshot created on flight completion |

Last updated: 2026-04-09

## What the Memory Layer Does Today

PacketCode's memory layer is implemented across:

- `src/stores/memoryStore.ts`
- `src-tauri/src/commands/memory.rs`

The current flow:

1. `scanCodebaseMemory(projectPath)` — scans the project directory and produces a text summary of the codebase
2. `summarizeSession(projectPath, sessionLog)` — takes a session transcript and produces a natural language summary
3. `extractPatterns(projectPath, summariesText)` — reads multiple session summaries and extracts reusable patterns

Memory context is injected into sessions via `appStore.ts`:

- `getContextForSession()` is called when launching a session
- The result is prepended to the initial prompt

## What Works

- The three-stage pipeline (scan → summarize → extract) is a sound approach
- Injecting memory context into session prompts is the right UX pattern
- Session summarization provides a useful compressed history
- Pattern extraction gives a way to encode learned conventions

## Known Gaps

### 1. No memory update after session completion

Currently, memory is built incrementally but there is no automatic trigger to update it after a session ends. Users must manually run the memory scan or it is recomputed only on demand.

### 2. Pattern extraction is not automatically connected to future sessions

`extractPatterns` runs on demand but its output is not automatically prepended to future session contexts.

### 3. Memory context window is unbounded

There is no mechanism to truncate or rank memory entries when the accumulated context exceeds a threshold. This could cause context overflow with long-running projects.

### 4. No per-flight memory model

Flights have their own context but it is not clearly connected to the memory layer. A flight's work could benefit from memory that is specific to that flight's scope.

### 5. Memory is not surfaced in Insights or other AI views

The memory layer is only used for session launch. It is not accessible from the Insights view, the flight chat, or any other AI-assisted surface.

### 6. No memory persistence across sessions beyond summarization

The memory layer stores summaries, not raw session data. If the summarization quality degrades over time, there is no recovery path without re-scanning.

## What a Full Plan Would Cover

A full memory layer plan would need to address:

1. **When to update memory** — after session end, after flight completion, on demand, or all three
2. **How to rank and truncate** — what to keep when context is full; pattern importance vs. recency
3. **How flights interact with memory** — should flights have scoped memory that feeds the global memory pool on completion
4. **How to surface memory elsewhere** — Insights, flight chat, review packets
5. **How pattern extraction feeds back into future sessions** — is the pattern output stored and injected automatically
6. **How to handle team-shared memory** — if multiple agents contribute, should memory accumulate across all of them

## Implementation Spec

See `dev/moat/memory-layer-implementation.md` for the full implementation plan.

## Recommendation

This doc is currently a gap audit. A full plan is needed before significant memory layer work begins.

The most important single improvement would be: **connect session-end to memory update automatically**, so the memory layer stays current without manual intervention.

## Next Step

Create a dedicated memory layer plan doc with user research on how memory is actually used today, before designing any of the above improvements.

## Implementation Spec

See `dev/moat/memory-layer-implementation.md` for the full implementation plan covering session-end hooks, pattern refresh thresholds, and flight-scoped memory snapshots.
