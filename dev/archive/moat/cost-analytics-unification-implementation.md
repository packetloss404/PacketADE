# Cost and Analytics — Implementation Spec

## Implementation Status — 2026-04-15

| Item | Status | Notes |
|------|--------|-------|
| `read_usage_analytics` backend | ✅ Done | Returns AnalyticsData with cost, tokens, per-model |
| CostDashboardView | ✅ Done | Standalone view + toolbar dollar sign button |
| Cost alerts | ❌ Not started | Nice-to-have |
| Per-flight cost rollup | ⚠️ Partial | Deploy integration tracks per-flight |
| Cost/analytics unification | ✅ Done | analyticsStore is sole source of truth |

Last updated: 2026-04-15

## Goal

Unify the cost and analytics data sources so that there is one source of truth for cost and token data, and remove the current dual-track system where `costStore` (frontend self-reported) and `analyticsStore` (backend actuals) can diverge.

## Current State

There are two separate tracking paths:

### Path 1: `analyticsStore` (actual costs)

- `src/stores/analyticsStore.ts`
- Calls `read_usage_analytics` backend command
- Reads `~/.claude/cost-tally.json` (written by Claude CLI) and `~/.claude/stats-cache.json`
- Returns `totalCostUsd`, `totalSessions`, `totalInputTokens`, `totalOutputTokens`, `modelUsage[]`, `dailyCosts[]`
- **Read-only** — no write path from within PacketCode

### Path 2: `costStore` (self-reported estimates)

- `src/stores/costStore.ts`
- Called by whatever code launches a session: `recordCost(sessionId, cost, model)`
- The `cost` value is **passed in by the caller**, not measured
- **Self-reported estimates** — not actual API billing data

These two systems can produce completely different numbers for the same sessions.

Relevant files:

- `src/stores/costStore.ts`
- `src/stores/analyticsStore.ts`
- `src/types/cost.ts`
- `src-tauri/src/commands/analytics.rs`

## What This Spec Adds

1. **Single source of truth**: `analyticsStore` becomes the primary store for cost and token data; `costStore` is deprecated
2. **Per-flight cost rollup**: attribute backend cost data to flights via session IDs
3. **Cost alert system**: set a spend threshold and get warned when approaching it
4. **Frontend cost tracking removed**: `recordCost` calls become unnecessary

---

## Change 1: Deprecate `costStore` in Favor of `analyticsStore`

### What to deprecate

`recordCost`, `clearEntries`, `getSummary` in `costStore.ts` — these are all self-reported and will diverge from reality.

### Migration

1. Remove all calls to `useCostStore.getState().recordCost()` from session launch code
2. Keep `costStore.ts` in the codebase but mark it as deprecated — it still functions for historical data but no new entries are written
3. Update `CostDashboardView` to read from `analyticsStore` instead of `costStore`

### Data migration

On first launch after this change, import historical `costStore` entries into `analyticsStore` as a one-time seed:

```typescript
// In CostDashboardView, on mount:
const historicalCosts = useCostStore.getState().entries;
if (historicalCosts.length > 0) {
  // These are estimates — flag them as such in the UI
  // Or silently ignore them in favor of actual backend data
}
```

---

## Change 2: Connect `analyticsStore` to Flight Attribution

### Current problem

`analyticsStore` tracks sessions but not flights. Flights are the primary work organizer. There is no way to see "total cost of flight X".

### New backend command: `get_session_cost`

```rust
// In analytics.rs:

#[tauri::command]
pub fn get_session_cost(session_id: String) -> Result<SessionCost, String> {
    // Look up cost for a specific session from cost-tally.json
    // session_id maps to entries in cost-tally.json
}
```

### Store change: `analyticsStore`

```typescript
// Add to AnalyticsData:
flightCosts?: Record<string, number>;  // flightId -> total cost

// Add to AnalyticsStore:
loadForFlight: (flightId: string) => Promise<void>;
getFlightCost: (flightId: string) => number;
```

### Wire to flight store

In `flightStore.ts`, when a flight completes:

```typescript
const analytics = useAnalyticsStore.getState().data;
if (analytics && flight.linkedSessionIds.length > 0) {
  const flightCost = flight.linkedSessionIds.reduce((sum, sid) => {
    return sum + (analytics.sessionCosts?.[sid] ?? 0);
  }, 0);
  // Update flight totalCost field
}
```

---

## Change 3: Cost Alerts

### Motivation

Users running agents against paid APIs need to know when they are approaching a budget.

### New backend command: `set_cost_alert`

```rust
#[tauri::command]
pub fn set_cost_alert(threshold_usd: f64) -> Result<(), String> {
    // Store in local config: ~/.packetcode/cost-alert.json
}

#[tauri::command]
pub fn get_cost_alert() -> Result<Option<f64>, String> {
    // Read from ~/.packetcode/cost-alert.json
}
```

### Alert check

In `analyticsStore.load()`, after fetching analytics data:

```typescript
const alert = await getCostAlert();
if (alert && data.totalCostUsd >= alert * 0.9) {
  // Emit a warning toast or set a store flag
  useAnalyticsStore.setState({ approachingAlert: true });
}
```

### UI: alert indicator in dashboard

In `CostDashboardView`:

```tsx
{
  approachingAlert && (
    <div className="rounded border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-400">
      Approaching cost alert threshold
    </div>
  );
}
```

---

## Change 4: Analytics → Cost Dashboard Unification

### New unified store: `unifiedAnalyticsStore`

Replace `costStore` with a single store that wraps `analyticsStore` and adds PacketCode-specific aggregations:

```typescript
interface UnifiedAnalyticsStore {
  data: AnalyticsData | null;
  loading: boolean;
  costAlertThreshold: number | null;
  approachingAlert: boolean;

  load: () => Promise<void>;
  setCostAlert: (threshold: number | null) => Promise<void>;
  getCostForFlight: (flightId: string) => number;
  getDailyCosts: (days: number) => DailyCost[];
}
```

### Dashboard changes

`CostDashboardView.tsx` reads from `unifiedAnalyticsStore`:

- Remove `recordCost` calls from session launch code
- Remove `costStore` import
- Import `unifiedAnalyticsStore` instead
- Show backend-computed costs, not frontend estimates

---

## Summary of Changes

| What                                               | Where                          | Type           |
| -------------------------------------------------- | ------------------------------ | -------------- |
| Deprecate `recordCost` calls                       | Session launch code            | Remove calls   |
| New `get_session_cost` backend command             | `analytics.rs`                 | Backend change |
| Flight attribution in `analyticsStore`             | `analyticsStore.ts`            | Store change   |
| New `set_cost_alert` and `get_cost_alert` commands | `analytics.rs`                 | Backend change |
| Alert check in `load()`                            | `analyticsStore.ts`            | Store change   |
| Unified store replacing `costStore`                | New `unifiedAnalyticsStore.ts` | New file       |
| Update `CostDashboardView` to use new store        | `CostDashboardView.tsx`        | UI change      |
| Remove `recordCost` from session launch            | `appStore.ts` or session code  | Remove calls   |

## Files to Modify

- `src/stores/analyticsStore.ts` — add flight attribution and alert support
- `src/stores/costStore.ts` — deprecate in favor of analyticsStore
- `src/stores/unifiedAnalyticsStore.ts` — new unified store (replaces costStore usage)
- `src/components/views/CostDashboardView.tsx` — switch to unified store
- `src-tauri/src/commands/analytics.rs` — add `get_session_cost`, `set_cost_alert`, `get_cost_alert`
- `src/App.tsx` or wherever session launch calls `recordCost` — remove those calls

## Delivery Order

1. Add `get_session_cost` to backend (Change 2 backend part)
2. Add cost alerts to backend and store (Change 3)
3. Remove `recordCost` calls from frontend (Change 1)
4. Create `unifiedAnalyticsStore` and update dashboard (Change 4)
5. Add flight attribution to store (Change 2 frontend part)
