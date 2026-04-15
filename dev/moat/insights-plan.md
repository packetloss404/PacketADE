# Insights Plan

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

## What Insights Does Today

Insights is implemented across:

- `src/stores/insightsStore.ts`
- `src/components/views/InsightsView.tsx`
- `src-tauri/src/commands/insights.rs`

The current flow:

1. User types a message in the Insights input
2. `askInsightsStream(projectPath, messages)` is called
3. The backend streams responses as `insights:chunk` events
4. The frontend renders them in `InsightsView.tsx`
5. Sessions and messages are persisted in `insightsStore.ts`

Insights is a chat interface for project-aware Q&A.

## What Works

- Streaming responses via `insights:chunk` events work correctly
- Session persistence in `insightsStore.ts` gives a conversation history
- Project context is passed via `projectPath` to the backend
- The `InsightsSession` and `InsightsMessage` types are well-defined

## Relationship to Ideation Scanner

There is a separate ideation scanner at `src-tauri/src/commands/ideation.rs` and `generate_ideas`. The two features are related but distinct:

- **Insights**: interactive chat for general project questions
- **Ideation**: structured generation of ideas, tips, or suggestions based on code analysis

The distinction is not clearly surfaced in the UI. A user could reasonably expect them to be the same feature.

## Known Gaps

### 1. Insights and Ideation are disconnected

`generate_ideas` outputs structured ideas; `askInsights` is freeform chat. They share the project context but not the session. A user who runs ideation and then wants to follow up in Insights has to re-explain the context.

### 2. Insights context is not connected to the memory layer

Insights does not currently use `memoryStore` context. It receives project context but not the accumulated memory summaries or patterns.

### 3. No way to send Insights context to a session

If Insights produces useful analysis, there is no path to send that analysis into a workspace terminal session or a flight.

### 4. Session management is basic

Sessions can be named and resumed but there is no way to:

- export an Insights conversation
- share an Insights session
- link an Insights session to a specific flight or workspace

### 5. Insights has no integration with the review flow

If a review packet surfaces an issue, there is no way to open an Insights session scoped to that issue's context.

## What a Full Plan Would Cover

1. **Merge or clearly separate Insights and Ideation** — they are currently two features with overlapping scope and no clear distinction in the UX
2. **Connect Insights to the memory layer** — Insights should have access to the same memory context that sessions get
3. **Outbound: send Insights output to sessions** — allow copying Insights analysis into a workspace terminal or flight prompt
4. **Flight-scoped Insights** — open an Insights session that is automatically scoped to a specific flight's files and tasks
5. **Session export and sharing** — export an Insights conversation as markdown
6. **Review integration** — open an Insights session from a review packet with relevant file context preloaded

## Recommendation

This doc is currently a gap audit. A full plan is needed before significant Insights work begins.

The most impactful single improvement would be: **connect Insights to the memory layer**, so project-aware chat has access to the same accumulated context that session launches use.

## Next Step

Determine whether Insights and Ideation should be merged into one feature or kept separate with a clear UX distinction, before planning any of the above improvements.

## Implementation Spec

See `dev/moat/insights-implementation.md` for the full implementation plan covering memory context injection, send-to-terminal, flight-scoped sessions, and the Ideation bridge.
