# Memory v0.9+ — Scoped Loop

Created: 2026-07-24
Backlog: [`../backlog.md`](../backlog.md) → "Memory v0.9+ (from v0.8 deferrals)".
Shape: same loop cadence as [`bridgemind/flight-escalation-loop.md`](./bridgemind/flight-escalation-loop.md)
(discrete, independently-gated items; per-item commit; verify → record).

## Objective

Make the Memory pane fully functional and work through the deferred Memory
v0.9+ enhancements. Two buckets:
1. **Fix what's half-wired** (the "really implement the code" part): a search box
   that ignores the better ranker sitting next to it, a `task_completed` path
   that nothing emits, a confidence field with no feedback loop, and a rich
   retrospective command that no frontend calls.
2. **Ship the deferred enhancements** where the value is worth the weight.

**Non-goal:** local embedding semantic retrieval (backlog item a) — see *Deferred*.

## Grounding — what's live today (do not rebuild)

| Piece | Where | Notes |
|---|---|---|
| Corpus + persistence | `src/stores/memoryStore.ts`; slice → `save_memory_slice` → `storage::save_memory` | Backend-persisted app-state slice (`events`, `patterns`), **not** localStorage. Only *settings* use localStorage (`memorySettingsStore.ts`). |
| Retrieval | `memoryStore.ts` `relevanceScores` (~307) + `computeContextItems` (~340) | Brute-force keyword/**IDF** overlap in [0,1]; gates patterns on `confidence>=0.6 || pinned`, re-ranks `0.6*rel + 0.4*conf`. No embeddings. |
| Capture (in) | flight-complete `asyncFlightStore.ts:576`; session `useTerminalSession.ts:295`; **manual → only** `github/InvestigationPanel.tsx:158` | `captureManually` (`memoryStore.ts:541`) is generic + bypasses toggles — the template for more surfaces. |
| Injection (used) | flight launch `asyncFlightStore.ts:474`; API convo `agentTaskStore.ts:479`; previews in AgentChatPane/HeaderOverflowMenu/MemoryView | Gated on `injectIntoFlightPrompts` / per-convo `memoryContextEnabled`. |
| Pane | `MemoryView.tsx` — tabs `patterns` \| `timeline` (line 23) | Patterns (grouped + brief preview) & Timeline (event list + type chips + search). Settings live in ToolsView (`MemorySettingsCard`). |
| Rust cmds | `commands/memory.rs` | `summarize_session`, `extract_patterns`, `summarize_flight` (rich retrospective, **no caller**), `scan_codebase_memory` (no caller), `toggle_pinned_pattern`. |

## Loop ledger

`queued → in-progress → gated → closed`. Order roughly gaps-first, then small
enhancements, then medium. Sizes from the subsystem map.

| ID | Item | Acceptance | Key hooks | Gate | Size | Status |
|---|---|---|---|---|---|---|
| **M1** | Wire IDF search into the Timeline box | The Timeline search ranks/filters via the existing `relevanceScores`, not naive `JSON.stringify().includes()`. Empty query = unchanged list. | `MemoryView.tsx` `filtered` memo (~139-148, search at ~145) → call `memoryStore.relevanceScores`. | Vitest: query ranks a matching event above a non-match; blank query no-ops. | S | queued |
| **M2** | Timeline **project** + **date-range** filter chips | Chips filter the timeline by `event.projectPath` and by a date window; compose with the existing type chips. | `MemoryView.tsx` filter row (~667-690) + `filtered` predicate (~139). Events carry `projectPath`/`timestamp` (`memory.ts:62-63`). | Vitest: pure predicate — project + date window filter correctly, compose with type. | S | queued |
| **M3** | Export / import memory (JSON + Markdown) | Header actions export the `{events, patterns}` slice as JSON and as a readable Markdown digest; import merges a JSON export (dedup by id). | `memoryStore.ts` new `exportMemory`/`importMemory`; buttons in `MemoryView.tsx` header (~216-233). | Vitest: round-trip export→import is identity; Markdown formatter snapshot; import dedups. | S–M | queued |
| **M4** | "+ Add to memory" in more surfaces | The generic `captureManually` affordance (à la `InvestigationPanel`) is added to the flight coordination timeline row and the agent transcript. | `FlightsView.tsx` `TimelineRow`; `AgentChatPane.tsx`; reuse `captureManually` (`memoryStore.ts:541`) with a `ManualNotePayload` `source`. | Vitest/RTL: clicking capture calls `captureManually` with the right payload. | S | queued |
| **M5** | Confidence auto-rerating on outcome | A pattern injected into an attempt's brief has its `confidence` bumped on that flight's success / decayed on failure. Requires persisting brief→attempt provenance. | Persist injected pattern ids per attempt (brief `items` already carry ids, `memoryStore.ts:49`); new `adjustConfidence` action; wire from `captureFlightCompletionOnTransition` (`asyncFlightStore.ts:568`). | Vitest: pure rerate math (bump/decay/clamp) + provenance lookup. | M | queued |
| **M6** | Recurring-error "this looks familiar" hint | At launch, if the prompt/flight matches a prior `pitfall` pattern or a repeated failure signature, surface a one-line hint. | Failure-signature extraction over `flight_completed` payloads; hint in the launch modal (`LaunchAsyncFlightModal`) via `relevanceScores` on `pitfall`-category patterns. | Vitest: signature match + hint selection (pure). | M | queued |
| **M7** | 30-day memory digest | A digest summarizing the last 30 days of memory (counts by type/category + top patterns/lessons), shown in MemoryView. | Client aggregation over `events`/`patterns` (or a `memory.rs` LLM command mirroring `summarize_flight`); UI template like `github/AICatchUpButton`. | Vitest: pure 30-day aggregation. | M | queued |
| **M8** | "Ask your project" memory chat tab | A 3rd MemoryView tab: type a question → keyword-ranked memory answer (reuse `relevanceScores`; no LLM required for v1). | New `Tab` in `MemoryView.tsx:23` + panel beside PatternsTab/TimelineTab; query plumbing to `computeContextItems`. | Vitest: query returns the expected ranked items. | M | queued |
| **M9** | Use the rich flight retrospective | Flight capture uses the stranded `summarize_flight` LLM retrospective for `lessonsLearned` instead of the mechanical error-string derivation, when learning is enabled. | Wire `summarize_flight` (`memory.rs:64`) into `buildFlightCompletedPayload` path (`asyncFlightStore.ts:514-523`) + a `tauri.ts` binding (currently absent). | Vitest (store, mocked cmd) + cargo check for the binding. | M | queued |
| **M10** | Resolve the dead `task_completed` path | Either emit `task_completed` from a real signal or retire the dead UI (renderer + filter chip) so the pane has no permanently-empty surface. | `MemoryEventCard.tsx` `TaskCard` (~216), `MemoryView.tsx` filter chip (~29) + predicate; decide at implementation. | Vitest reflects the decision. | S | queued |

## Deferred (not in this loop)

- **Semantic retrieval / local embeddings (backlog item a)** — the only LARGE
  item: needs a bundled local embedding model + inference (new Rust command),
  vector storage on events/patterns, and a cosine ranker. The backlog explicitly
  says do this *only if keyword misses are measured*. M1 (wire the IDF scorer)
  and M8 (chat) first make keyword quality visible; revisit embeddings only if
  they fall short. Its own effort, gated on measured need.

## Loop protocol

Each iteration: claim the lowest-ID `queued` item whose deps are `closed`;
revalidate hooks against current code (line refs drift); implement minimally;
add a focused test (prefer pure helpers, as the escalation loop did); gate
(targeted vitest + `pnpm lint` + `pnpm build`; `cargo check` real-exit for any
Rust); flip to `closed` + `CHANGELOG` line; commit one item per commit on
`feat/memory-v9`.

## Suggested slices

- **Quick-win slice (S):** M1 → M2 → M4 → M10 → M3-JSON. Immediately makes search
  useful, the timeline filterable, capture ubiquitous, and removes the dead surface.
- **Feedback slice (M):** M5 (confidence rerating) + M6 (recurring-error) — the
  "memory that learns" story, the biggest product upgrade.
- **Surfacing slice (M):** M7 (digest) + M8 (chat) + M9 (rich retrospective) +
  M3-Markdown.
