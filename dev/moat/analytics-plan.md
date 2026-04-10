# Analytics Plan

Last updated: 2026-04-09

## What Analytics Does Today

Analytics is implemented across:

- `src/stores/analyticsStore.ts`
- `src/components/views/AnalyticsView.tsx`
- `src-tauri/src/commands/analytics.rs`

The current flow:

1. `analyticsStore.load()` calls `read_usage_analytics` via Tauri invoke
2. The backend returns a JSON payload with `totalCostUsd`, `totalSessions`, `totalInputTokens`, `totalOutputTokens`, `modelUsage[]`, and `dailyCosts[]`
3. The frontend renders these in `AnalyticsView.tsx`

## What Works

- The backend computes and returns structured analytics data
- The frontend correctly renders the returned data
- Token counts and cost are tracked together, which is more useful than cost alone
- Daily cost breakdown and per-model breakdown are present

## Relationship to Cost Dashboard

`analyticsStore.ts` and `costStore.ts` both track cost and session data:

- `analyticsStore.ts` — gets data from `read_usage_analytics` backend command
- `costStore.ts` — self-reported costs recorded by session launch events

These are two separate data sources that may overlap or conflict. They should probably be one store.

## Known Gaps

### 1. Usage analytics data source is opaque

`read_usage_analytics` returns data but it is unclear:

- what time range it covers (all time? last 30 days? last session?)
- whether it is computed from session logs or from actual provider API responses
- how frequently it is updated

### 2. Analytics has no write path

`analyticsStore.ts` is read-only. There is no way to annotate analytics events, tag sessions, or add notes.

### 3. No per-flight analytics

Flights are the primary work organizer but analytics are tracked at the session level. There is no rollup by flight.

### 4. Analytics is not connected to the review queue

If a session generates issues that go to the review queue, that relationship is not visible in analytics.

### 5. No export or sharing

Analytics data cannot be exported or shared.

### 6. TUI has no analytics view

The TUI has no equivalent to `AnalyticsView.tsx`. Usage analytics are GUI-only.

## What a Full Plan Would Cover

1. **Define the analytics data source** — what backend data does `read_usage_analytics` actually return? What time range? What triggers updates?
2. **Per-flight analytics rollup** — attribute sessions to flights; show total cost and token usage per flight
3. **Write path for annotations** — allow tagging sessions or flights with notes or labels
4. **Connect to review queue** — surface which sessions and flights produced review items
5. **TUI parity** — add an analytics view to the TUI
6. **Data export** — CSV or JSON export of analytics data

## Recommendation

This doc is currently a gap audit. A full plan is needed before significant analytics work begins.

The most important prerequisite for any analytics work is: **document what `read_usage_analytics` actually returns and how it is computed**. Without that, the analytics store is building on sand.

## Next Step

Read `src-tauri/src/commands/analytics.rs` to understand the data source before planning any of the above improvements.
