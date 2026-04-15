# Cost Dashboard Plan

## Implementation Status — 2026-04-15

| Item | Status | Notes |
|------|--------|-------|
| `read_usage_analytics` backend | ✅ Done | Returns AnalyticsData with cost, tokens, per-model |
| CostDashboardView | ❌ Missing | No standalone component |
| Cost alerts | ❌ Not started | No `set_cost_alert` backend command |
| Per-flight cost rollup | ❌ Not started | — |
| Cost/analytics unification | ❌ Not started | costStore and analyticsStore still separate |

Last updated: 2026-04-09

## What the Cost Dashboard Does Today

The cost dashboard is implemented across:

- `src/stores/costStore.ts`
- `src/components/views/CostDashboardView.tsx`

The current flow:

1. `recordCost(sessionId, cost, model)` is called with a session ID, cost in USD, and model name
2. Entries are persisted in localStorage under `packetcode:cost-entries`
3. `getSummary()` computes total cost, session count, cost by day, and cost by model
4. The `CostDashboardView` renders the summary

## What Works

- The cost tracking model is straightforward and performant
- LocalStorage persistence keeps data across restarts
- Summary computation covers the most useful dimensions: total, per-session, per-day, per-model
- The 1000-entry cap prevents unbounded storage growth

## Known Gaps

### 1. Cost data is self-reported, not measured

`recordCost` is called by whoever launches a session. The cost value is passed in, not computed from actual API usage. There is no verification that the cost matches the actual API spend.

### 2. No actual token counts

`costStore.ts` records cost but not token counts. `analyticsStore.ts` has `inputTokens` and `outputTokens` from `read_usage_analytics`, but `costStore.ts` does not use them.

### 3. No per-flight cost tracking

Sessions are tracked but flights (which may involve multiple sessions) are not costed as a unit.

### 4. No cost cap or alert

There is no way to set a budget or get warned when spend approaches a threshold.

### 5. No per-user cost attribution

If multiple users share a machine, costs are not attributed to different users.

### 6. Analytics and cost are two separate stores

`costStore.ts` and `analyticsStore.ts` both track related data (cost, tokens, sessions) but they are separate and may produce conflicting summaries.

## What a Full Plan Would Cover

1. **Source of truth for cost data** — should costs come from actual API responses, estimates, or both? Can costs be verified against actual provider billing?
2. **Token count tracking** — connect `analyticsStore.ts` token data to `costStore.ts` so both cost and tokens are tracked together
3. **Per-flight cost rollup** — attribute session costs to flights; show total flight cost
4. **Cost alerts** — allow setting a spend threshold; surface a warning when approaching it
5. **Dashboard UX improvements** — trend charts, per-model breakdowns, date range filtering
6. **Cost vs. budget** — if flights have estimates, track actual vs. estimated cost

## Relationship to Analytics

`analyticsStore.ts` calls `read_usage_analytics` which comes from the backend. `costStore.ts` is purely frontend-driven from session launch events. These two should be reconciled — ideally one store is the source of truth for both cost and token data.

## Recommendation

This doc is currently a gap audit. A full plan is needed before significant cost dashboard work begins.

The most impactful single improvement would be: **unify the cost and analytics data sources** so that token counts and cost estimates come from the same backend data rather than two independent paths.

## Next Step

Audit how `recordCost` is called today — what values are passed, from where, and whether they are actual or estimated — before designing any of the above improvements.

## Implementation Spec

See `dev/moat/cost-analytics-unification-implementation.md` for the full implementation plan covering deprecation of self-reported cost tracking, backend-as-source-of-truth, per-flight cost attribution, and cost alerts.
