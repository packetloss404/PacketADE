# Cost Dashboard Plan

## Implementation Status — 2026-04-15

| Item | Status | Notes |
|------|--------|-------|
| `read_usage_analytics` backend | ✅ Done | Returns AnalyticsData with cost, tokens, per-model |
| CostDashboardView | ✅ Done | Standalone view + toolbar dollar sign button |
| Cost alerts | ❌ Not started | Nice-to-have |
| Per-flight cost rollup | ⚠️ Partial | Deploy integration tracks per-flight |
| Cost/analytics unification | ✅ Done | analyticsStore is sole source of truth |

Last updated: 2026-04-28

## What the Cost Dashboard Does Today

The cost dashboard is implemented across:

- `src/stores/analyticsStore.ts`
- `src-tauri/src/commands/analytics.rs`
- `src-tauri/src/commands/pricing.rs`
- `src/components/views/CostDashboardView.tsx`

The current flow:

1. API agents append `UsageEntry` rows to `~/.packetade/usage.jsonl`.
2. `read_usage_analytics` also ingests Claude's `~/.claude/cost-tally.json` and Codex `~/.codex/sessions/**/*.jsonl`.
3. `pricing.rs` estimates model costs where raw session logs provide token counts but not cost.
4. `analyticsStore.ts` loads the aggregated `AnalyticsData`.
5. `CostDashboardView` renders totals, daily costs, token counts, and per-model usage.

## What Works

- Backend aggregation keeps frontend state simple.
- Data survives restarts through provider logs and PacketADE's `usage.jsonl`.
- Summary computation covers the most useful dimensions: total, sessions, tokens, per-day, and per-model.
- Local/self-hosted models are priced at `$0`; known cloud models use the pricing table in `pricing.rs`.

## Known Gaps

### 1. Cost data is mixed-source

Claude cost-tally entries may carry cost directly, PacketADE API-agent rows carry calculated cost, and Codex CLI sessions are estimated from token counts. This is useful operationally but should not be treated as provider-billing truth.

### 2. Unknown models price to zero

`pricing.rs` returns zero for unknown models. That is safe, but new model IDs need table updates to avoid undercounting.

### 3. No per-flight cost tracking

Sessions are tracked but flights (which may involve multiple sessions) are not costed as a unit.

### 4. No cost cap or alert

There is no way to set a budget or get warned when spend approaches a threshold.

### 5. No per-user cost attribution

If multiple users share a machine, costs are not attributed to different users.

## What a Full Plan Would Cover

1. **Source of truth for cost data** — should costs come from actual API responses, estimates, or both? Can costs be verified against actual provider billing?
2. **Pricing table maintenance** — keep `pricing.rs` aligned with supported model IDs and provider rate changes
3. **Per-flight cost rollup** — attribute session costs to flights; show total flight cost
4. **Cost alerts** — allow setting a spend threshold; surface a warning when approaching it
5. **Dashboard UX improvements** — trend charts, per-model breakdowns, date range filtering
6. **Cost vs. budget** — if flights have estimates, track actual vs. estimated cost

## Relationship to Analytics

`analyticsStore.ts` calls `read_usage_analytics` and is the frontend source of truth for cost and token summaries. Historical `costStore.ts` references are obsolete.

## Recommendation

This doc is now a gap audit for the implemented dashboard. The most impactful next improvement would be: **add budget thresholds and visible cost alerts** using the existing backend analytics output.

## Next Step

Design budget thresholds and decide whether alerts are global, per-provider, or per-flight.

## Implementation Spec

See `dev/archive/moat/cost-analytics-unification-implementation.md` for the historical implementation plan covering deprecation of self-reported cost tracking, backend-as-source-of-truth, per-flight cost attribution, and cost alerts.
