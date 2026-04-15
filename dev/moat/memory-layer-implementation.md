# Memory Layer — Implementation Spec

## Implementation Status — 2026-04-15

| Item | Status | Notes |
|------|--------|-------|
| Session-end hook | ✅ Done | `useTerminalSession.ts` calls `learnFromSession()` on PTY exit |
| Pattern refresh threshold | ✅ Done | `PATTERN_REFRESH_THRESHOLD = 3` in memoryStore.ts |
| Bounded memory context | ✅ Done | `CONTEXT_MAX_PATTERNS = 10`, `CONTEXT_MAX_SESSIONS = 5` |
| `isLearning` flag | ✅ Done | Uses `isLearning` instead of planned `memoryUpdateInProgress` |
| FlightMemorySnapshot type | ✅ Done | Type exists in types/memory.ts |
| Flight→memory wiring | ✅ Done | Snapshot created on flight completion |

Last updated: 2026-04-15

## Goal

Make the memory layer self-updating: session summaries and pattern extraction happen automatically after a session ends, without manual intervention.

## Current State

The memory layer is a three-stage pipeline:

1. `scanCodebaseMemory` — scans project files and produces a file map
2. `summarizeSession` — takes a session log and produces a natural language summary
3. `extractPatterns` — reads all session summaries and produces reusable patterns

All three stages are callable but must be triggered manually. The memory context is injected into future sessions via `getContextForSession()`.

Relevant files:

- `src/stores/memoryStore.ts`
- `src/types/memory.ts`
- `src-tauri/src/commands/memory.rs`

## What This Spec Adds

1. **Session-end trigger**: after any PTY session exits, automatically call `addSessionSummary`
2. **Pattern refresh trigger**: after a session summary is added, automatically call `refreshPatterns` if the threshold is met
3. **Flight-scoped memory**: store a memory snapshot associated with each completed flight

---

## Change 1: Session-End Memory Hook

### Trigger point

The GUI already emits a `pty:exit` event when a PTY session ends. The hook should be added at `App.tsx` level, listening for `pty:exit`.

### Backend change

None required. `summarizeSession` and `extractPatterns` already exist.

### Frontend change: `src/App.tsx`

Add a `useEffect` that:

1. Listens for `pty:exit` event
2. Reads the session transcript for that session ID via `read_pty_transcript`
3. Calls `memoryStore.addSessionSummary(projectPath, sessionTitle, sessionLog)`

```typescript
// In App.tsx useEffect (after existing event listeners)
const unlistenPtyExit = listen<string>("pty:exit", async (event) => {
  const sessionId = event.payload;
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;

  // Read transcript
  const transcript = await readPtyTranscript(sessionId);
  if (!transcript?.trim()) return; // skip empty sessions

  const projectPath = useLayoutStore.getState().projectPath;
  const title = session.cliCommand || "Session";

  await useMemoryStore.getState().addSessionSummary(projectPath, title, transcript);
});
```

### Threshold for pattern refresh

Do not refresh patterns after every session — that would call the LLM after every session completion.

Threshold: refresh patterns after every 3rd new session summary, or manually via a UI button.

Add to `memoryStore`:

```typescript
const PATTERN_REFRESH_THRESHOLD = 3; // every N sessions

// In addSessionSummary, after successfully adding:
const { sessionSummaries } = get().memory;
if (sessionSummaries.length % PATTERN_REFRESH_THRESHOLD === 0) {
  await get().refreshPatterns(projectPath);
}
```

### UX: show memory is updating

Add a `memoryUpdateInProgress` flag to the memory store:

```typescript
memoryUpdateInProgress: boolean;
```

Display a subtle indicator in the MemoryView when an update is running.

---

## Change 2: Flight-Scoped Memory

### Motivation

When a flight completes, its retrospectives and session summaries should be preserved as a coherent unit. Currently, session summaries are global across all flights — there is no flight-level memory.

### New type: `FlightMemorySnapshot`

```typescript
// src/types/memory.ts

export interface FlightMemorySnapshot {
  flightId: string;
  sessionSummaryIds: string[]; // references into memory.sessionSummaries
  patternSnapshot: LearnedPattern[]; // frozen copy of patterns at flight end
  retrospective?: string; // output from summarize_flight
  createdAt: number;
}
```

### Store change

```typescript
// In MemoryState:
flightMemorySnapshots: FlightMemorySnapshot[];
```

### Backend: `summarize_flight` command already exists

The `summarize_flight` command in `src-tauri/src/commands/memory.rs` already generates a retrospective. This can be used as the flight-level memory snapshot content.

### When to create a snapshot

1. When a flight reaches `done` or `failed` status
2. Call `refreshPatterns` one final time to get the current patterns
3. Freeze the current `sessionSummaries` IDs and `patterns` into a `FlightMemorySnapshot`
4. Store the retrospective output from `summarize_flight`

### Wire to flight store

In the flight store, when a flight status transitions to `done`/`failed`/`cancelled`:

```typescript
// After flight status change, in flightStore:
if (newStatus === "done" || newStatus === "failed") {
  const retrospective = await summarizeFlight(flight, sessionLogs);
  useMemoryStore.getState().addFlightMemorySnapshot(flight.id, retrospective);
}
```

This requires:

- `summarizeFlight(flight, sessionLogs)` call in `flightStore`
- `addFlightMemorySnapshot(flightId, retrospective)` in `memoryStore`

---

## Change 3: Bounded Memory with Priority

### Problem

`getContextForSession` injects all patterns and the first 20 file map entries. With unbounded session summaries, this will grow forever.

### Fix: ranking and truncation

```typescript
getContextForSession: (flightId?: string) => string {
  const { patterns, fileMap, flightMemorySnapshots } = get().memory;

  // If a flightId is provided, boost patterns and summaries from that flight
  const flightSnapshot = flightMemorySnapshots.find(f => f.flightId === flightId);
  const boostedSummaryIds = new Set(flightSnapshot?.sessionSummaryIds ?? []);

  // Rank patterns by confidence
  const rankedPatterns = [...patterns]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);  // max 10 patterns

  // Rank file map by recency of last analysis
  const rankedFiles = [...fileMap]
    .sort((a, b) => b.lastAnalyzed - a.lastAnalyzed)
    .slice(0, 15);  // max 15 files

  // ... format and return
}
```

---

## Summary of Changes

| What                                         | Where                 | Type            |
| -------------------------------------------- | --------------------- | --------------- |
| Listen for `pty:exit`                        | `App.tsx`             | Frontend change |
| Auto-call `addSessionSummary` on session end | `App.tsx`             | Frontend change |
| Pattern refresh threshold                    | `memoryStore.ts`      | Store change    |
| `FlightMemorySnapshot` type                  | `src/types/memory.ts` | Type change     |
| `flightMemorySnapshots` in `MemoryState`     | `memoryStore.ts`      | Store change    |
| `addFlightMemorySnapshot` action             | `memoryStore.ts`      | Store change    |
| Flight → memory snapshot wiring              | `flightStore.ts`      | Store change    |
| Bounded ranking in `getContextForSession`    | `memoryStore.ts`      | Store change    |
| `memoryUpdateInProgress` flag                | `memoryStore.ts`      | Store change    |

## Files to Modify

- `src/App.tsx`
- `src/stores/memoryStore.ts`
- `src/types/memory.ts`
- `src/stores/flightStore.ts` (or wherever flight status transitions are handled)
- `src/components/views/MemoryView.tsx` (add memory update indicator)

## Delivery Order

1. Session-end hook (Change 1) — lowest risk, highest impact per line of code
2. Pattern refresh threshold — small addition to Change 1
3. Flight-scoped memory (Change 2) — requires coordination with flight store
4. Bounded memory (Change 3) — can ship independently
