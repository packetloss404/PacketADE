# Insights — Implementation Spec

## Implementation Status — 2026-04-15

| Item | Status | Notes |
|------|--------|-------|
| Backend `ask_insights_stream` | ✅ Done | Commands exist in commands/insights.rs with `session_context` param |
| InsightsView frontend | ✅ Done | InsightsView component and insightsStore implemented |
| "Include memory context" toggle | ✅ Done | — |
| "Send to terminal" button | ✅ Done | — |
| Flight-scoped Insights | ✅ Done | `flightId` on InsightsSession |
| Ideation→Insights bridge | ✅ Done | — |

Last updated: 2026-04-15

## Goal

Close the gap between Insights, Ideation, the memory layer, and workspace sessions — so that AI-assisted analysis flows naturally between all of them.

## Current State

- **Insights**: chat interface at `InsightsView.tsx`, backed by `insightsStore.ts` and `askInsights` backend command
- **Ideation**: separate command at `src-tauri/src/commands/ideation.rs`, surfaced via `generate_ideas`
- **Memory**: three-stage pipeline (scan → summarize → extract), separate from Insights
- **Sessions**: workspace terminals are completely separate from Insights conversations

No data flows between any of these features.

Relevant files:

- `src/stores/insightsStore.ts`
- `src/stores/memoryStore.ts`
- `src/types/insights.ts`
- `src-tauri/src/commands/insights.rs`
- `src-tauri/src/commands/ideation.rs`

## What This Spec Adds

1. **Memory context in Insights** — feed memory patterns and file map into the Insights prompt
2. **Outbound: send Insights output to a workspace terminal** — paste the assistant's response into an active PTY session
3. **Flight-scoped Insights sessions** — tag an Insights session with a flight ID for traceability
4. **Insights and Ideation: clarify the UX distinction** — decide and document how they differ, with a bridge if useful

---

## Change 1: Memory Context in Insights

### Current state

`insightsStore.sendMessage` builds a prompt from messages only. `memoryStore.getContextForSession()` is not called.

### Fix

In `sendMessage`, after building messages but before calling `askInsightsStream`:

```typescript
// In insightsStore.ts sendMessage:
const includeMemory = get().includeSessionContext;
let systemContext = "";
if (includeMemory) {
  const memoryContext = useMemoryStore.getState().getContextForSession();
  if (memoryContext.trim()) {
    systemContext = `## Project Context\n${memoryContext}`;
  }
}

// Pass to backend
await askInsightsStream(projectPath, messagesForApi, sessionContext, systemContext);
```

### Backend change: `askInsights_stream`

Update `src-tauri/src/commands/insights.rs` to accept and inject the system context:

```rust
#[tauri::command]
pub async fn ask_insights_stream(
    project_path: String,
    messages: Vec<ChatMessage>,
    session_context: Option<String>,
    system_context: Option<String>,  // NEW
) -> Result<(), String> {
    // Prepend system_context as a system message if provided
    let all_messages = if let Some(ctx) = system_context {
        let mut msgs = vec![ChatMessage {
            role: "system".into(),
            content: ctx,
        }];
        msgs.extend(messages);
        msgs
    } else {
        messages
    };
    // ... rest unchanged
}
```

### UX: memory toggle

Retain the existing `includeSessionContext` toggle in InsightsView. When enabled, show a small indicator: "Including memory context".

---

## Change 2: Outbound — Send to Terminal

### Motivation

If Insights produces useful analysis, copying and pasting it into a terminal is poor UX. There should be a one-click path to send the last assistant response into an active workspace session.

### UI addition: "Send to Terminal" button

In `InsightsView.tsx`, after each assistant message:

```tsx
{
  assistantMessage.content && (
    <button
      onClick={() => sendToTerminal(assistantMessage.content)}
      className="hover:text-accent-purple/80 flex items-center gap-1 text-[10px] text-accent-purple"
    >
      <Terminal size={10} />
      Send to terminal
    </button>
  );
}
```

### `sendToTerminal` implementation

```typescript
// In InsightsView or a helper:
async function sendToTerminal(content: string) {
  const layoutStore = useLayoutStore.getState();
  const activePaneId = layoutStore.activePaneId;
  if (!activePaneId) {
    toast.error("No active terminal pane");
    return;
  }
  const pane = layoutStore.panes.find((p) => p.id === activePaneId);
  if (!pane?.sessionId) {
    toast.error("No active session in this pane");
    return;
  }
  // Write to the PTY session
  await writePty(pane.sessionId, content + "\n");
}
```

Requires importing `writePty` from `@/lib/tauri`.

### UX: which terminal?

If multiple workspace panes are active, show a small popover to choose which pane to send to:

```typescript
const panes = useLayoutStore((s) => s.panes).filter((p) => p.sessionId);
if (panes.length <= 1) {
  sendToTerminal(content, panes[0].sessionId);
} else {
  showPanePicker(panes, (sessionId) => sendToTerminal(content, sessionId));
}
```

---

## Change 3: Flight-Scoped Insights

### Motivation

Insights sessions that relate to a specific flight should be linkable. Currently all Insights sessions are global.

### Type change

```typescript
// src/types/insights.ts

export interface InsightsSession {
  id: string;
  title: string;
  messages: InsightsMessage[];
  createdAt: number;
  updatedAt: number;
  flightId?: string; // NEW: optional flight association
}
```

### Store change

```typescript
// In insightsStore:
sessions: InsightsSession[];

associateWithFlight: (sessionId: string, flightId: string) => void;
getSessionsForFlight: (flightId: string) => InsightsSession[];
```

### UI: flight association

In `InsightsView.tsx`, add a "Link to flight" option in the session header menu:

```tsx
<select
  value={currentSession.flightId ?? ""}
  onChange={(e) => insightsStore.associateWithFlight(sessionId, e.target.value)}
  className="rounded border border-bg-border bg-bg-secondary px-1 text-[10px]"
>
  <option value="">No flight</option>
  {flights.map((f) => (
    <option key={f.id} value={f.id}>
      {f.title}
    </option>
  ))}
</select>
```

### Display in flight detail

In `FlightDetailView.tsx`, show linked Insights sessions as a collapsible section:

```
Insights (2 sessions)
  - "How should I structure the auth layer?" — 2h ago
  - "Is this the right approach for caching?" — 1d ago
```

---

## Change 4: Clarify Insights vs. Ideation

### Current confusion

- **Insights**: freeform chat, project-aware, streaming responses
- **Ideation**: structured generation of ideas, tips, suggestions based on code analysis

Both exist but:

- The UX does not clearly distinguish them
- Ideation output is hard to act on — it just generates text
- There is no path from an ideation result into a session or flight

### Recommended UX distinction

| Feature      | When to use                                                   | Output                 |
| ------------ | ------------------------------------------------------------- | ---------------------- |
| **Insights** | freeform questions, debugging, explanations                   | conversation           |
| **Ideation** | structured exploration, finding opportunities in the codebase | numbered list of items |

### Bridge: Ideation → Insights

Add a "Ask about this" button next to each ideation item:

```tsx
// In IdeationView, next to each generated idea:
<button
  onClick={() => {
    useInsightsStore.getState().createSession();
    useInsightsStore.getState().sendMessage(`Tell me more about: ${idea.text}`);
    setActiveView("insights");
  }}
>
  Ask about this
</button>
```

This creates a new Insights session pre-filled with the ideation item as the first message.

### Alternative: merge Ideation into Insights

If the distinction is more confusing than helpful, Ideation could become a template inside Insights — a special session mode that structures the output as a numbered list but feeds into the same session management.

Decision: try the bridge approach first (lowest coupling), re-evaluate after user feedback.

---

## Summary of Changes

| What                                               | Where                                | Type           |
| -------------------------------------------------- | ------------------------------------ | -------------- |
| `system_context` parameter to `askInsights_stream` | `src-tauri/src/commands/insights.rs` | Backend change |
| Memory context injection in `sendMessage`          | `insightsStore.ts`                   | Store change   |
| `includeSessionContext` toggle display             | `InsightsView.tsx`                   | UI change      |
| Memory context indicator                           | `InsightsView.tsx`                   | UI change      |
| `sendToTerminal` helper                            | `InsightsView.tsx` (or new util)     | UI change      |
| "Send to terminal" button on assistant messages    | `InsightsView.tsx`                   | UI change      |
| Pane picker for multi-pane workspaces              | `InsightsView.tsx`                   | UI change      |
| `InsightsSession.flightId` field                   | `src/types/insights.ts`              | Type change    |
| `associateWithFlight` store action                 | `insightsStore.ts`                   | Store change   |
| `getSessionsForFlight` store action                | `insightsStore.ts`                   | Store change   |
| "Link to flight" in session header                 | `InsightsView.tsx`                   | UI change      |
| Flight Insights section in flight detail           | `FlightDetailView.tsx`               | UI change      |
| Ideation → Insights bridge button                  | `IdeationView.tsx`                   | UI change      |

## Files to Modify

- `src-tauri/src/commands/insights.rs`
- `src/stores/insightsStore.ts`
- `src/types/insights.ts`
- `src/components/views/InsightsView.tsx`
- `src/components/views/FlightDetailView.tsx`
- `src/components/views/IdeationView.tsx` (or wherever ideation is rendered)

## Delivery Order

1. Memory context in Insights (Change 1) — immediate value, small change
2. Send to Terminal (Change 2) — highly useful UX win, medium change
3. Flight-scoped sessions (Change 3) — nice organizational improvement, small change
4. Ideation bridge (Change 4) — lowest priority, depends on user feedback to validate direction
