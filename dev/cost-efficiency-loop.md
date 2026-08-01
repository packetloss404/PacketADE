# Cost Efficiency Loop (caching + context discipline)

Status: **IN PROGRESS — Phase 1 caching landed (not yet measured live); CE14
pulled forward out of Phase 2**
Last updated: 2026-07-31 (after `422ab94`)
Created: 2026-07-30
Research basis: five independent source audits (prompt caching, context
discipline, task-class routing, batch APIs, cost measurement), 2026-07-30.

Progress:
- **SPIKE-1 — RESOLVED 2026-07-31** (Anthropic half; OpenAI half still open).
- **CE2 — DONE 2026-07-31.** One shared rate table, corrected Anthropic and
  MiniMax rows, cache-aware and date-aware pricing. See below.
- **CE5 — CUT 2026-07-31** (owner decision, see next block).
- **CE3 / CE4 — RE-SCOPED 2026-07-31** to temporary instrumentation. CE4's
  instruments shipped with CE6 (`log_cache_usage` + `scripts/cache-hit-rate.mjs`).
- **CE6 — DONE 2026-07-31.** Anthropic automatic prompt caching (top-level
  `cache_control`), 5-minute TTL, plus the two instruments that prove it. See
  below. **Effect is modelled, not yet measured against the live API.**
- **CE9 — DONE 2026-07-31.** Real `cached_tokens` on the OpenAI-compat path,
  `prompt_cache_key` for OpenAI, and the superset/disjoint normalisation moved
  to the Rust cost call site. See below.
- **CE14 — DONE 2026-07-31** (`422ab94`), out of phase order. The targeted
  `edit_file` tool landed with the provider loop rather than waiting for
  Phase 2, because whole-file rewrites were the dominant *output* cost and
  caching cannot help output at all. Local paths only. See below.
- **CE20 — SUPERSEDED 2026-07-31**, not executed. The routing placebo was
  wired instead of retired; `resolveForTask` has production callers and the
  card drives auxiliary-task provider selection. See below.

**Ordering note.** CE14 landed **before** CE8 (freeze the tool array), which is
the sequence CE14 itself asked for — the tools array changed once, deliberately,
while nothing depended on it being stable. CE8 can now freeze the final shape.

Related: [`local-model-routing.md`](./local-model-routing.md) (LM1–LM7 — the
auxiliary-surface routing plan this doc deliberately does **not** duplicate).

---

## 0. Owner decision, 2026-07-31 — the Cost Dashboard is removed

**What happened.** The user-facing cost *reporting* surface was deleted: the
`cost_dashboard` route and `CostDashboardView`, the always-mounted `LiveSpendChip`
in the toolbar, the Settings "Usage Analytics" `CostCard`, the per-conversation
cost line in `SessionMetaLine`, the inspector's Cost row, the per-turn USD
tooltip on the message token pill, and the `/usage` slash command. The owner's
reasoning: a reporting surface is not worth its maintenance cost.

**What survives, and why.** Cost did not stop being a *control input*:

- **Budget guardrails** (`lib/costGuardrails.ts`, `stores/costGuardrailStore.ts`,
  `stores/analyticsStore.ts`) still hard-stop a launch over a cap and still fire
  threshold notifications. Their caps are now edited in
  Settings → Flights & Autonomy (`BudgetGuardrailsCard`), and the poll that
  refreshes their data source moved from `LiveSpendChip` into
  `startCostGuardrailMonitor()`, started once from `bootstrap`.
- **The bounded-autonomy cost hard-stop** (`lib/autonomyPolicy.ts`
  `maxTotalCost` vs `Flight.totalCost`) and the Rust rollup that feeds it
  (`commands/flight_cost.rs`, the `flight:cost-updated` event) are untouched.
- **The shared pricing table** — `shared/model-pricing.json`,
  `src/lib/modelPricing.ts`, `src-tauri/src/commands/pricing.rs`, and the
  golden fixture `shared/model-pricing-cases.json` — is untouched. The rates
  corrected in CE2 are still load-bearing *for the guardrails*.
- **All token accounting plumbing** — `cache_read_input_tokens` /
  `cache_creation_input_tokens` parsing, the `turn_summary` path,
  `estimateTurnCostUsd` stamping `costUsd` on messages, and
  `~/.packetade/usage.jsonl` — is untouched. Token counts are still displayed
  per turn and per session (`N tok`); only the dollars are gone.

**What this changes about this plan.**

1. **CE5 (self-owned ledger with attribution) is CUT.** It existed to make a
   permanent reporting surface complete and trustworthy. There is no reporting
   surface, so the coverage work is not worth its cost.
2. **CE3 and CE4 are RE-SCOPED** from "make the dashboard correct" / "add a
   dashboard cache-hit tile" to **enough token measurement to prove caching
   worked, as temporary instrumentation** — a script or dev-only readout over
   `usage.jsonl`, deleted or left dormant once CE6 is verified. Neither is a
   product feature any more.
3. **The CE5-before-OAuth-removal constraint is DISSOLVED.** That constraint
   existed because removing subscription OAuth would freeze roughly half the
   *dashboard's* history with no PacketADE-side replacement. With no dashboard,
   there is no history to freeze and no user-visible gap. OAuth removal is no
   longer gated on ledger coverage. (SPIKE-2 still matters for a different
   reason: we would be comparing a possibly-cached sidecar path against an
   uncached in-process one.)
4. **Nothing about Phase 1 changes.** CE6–CE11 and the context-discipline work
   in Phase 2 are unaffected — they were always about request bytes, never
   about the dashboard.

---

## 1. Goal and the honest baseline

### Goal

Reduce real per-token spend on the in-process API-agent path by 60–80% on
multi-iteration turns, **and be able to prove it**. The trigger is the pending
decision about removing subscription OAuth from the API-agent surface: if
users move from `api-claude-oauth` (subscription, effectively flat) to
`api-claude` (metered API key), today's request shape is a large and immediately
visible cost regression for exactly the migrated population.

### What we know costs money today

Verified against source on 2026-07-30:

| Fact | Evidence |
| --- | --- |
| ~~**Zero prompt caching on the in-process Anthropic path.**~~ **FIXED by CE6 (2026-07-31)** — every Messages request now carries a top-level `cache_control` marker. The original finding stands as the baseline: `cache_control` appeared in **no** file under `src-tauri/src`, `src`, or `agent-sidecar/src`, and the body was `model`/`messages`/`max_tokens`/`stream` + optional `system` (bare string) / `tools` / `temperature` / `thinking`. | `core/llm_anthropic.rs`; repo-wide grep returned nothing |
| **The agent loop re-sends everything, up to 150 times per user turn.** `messages` is re-cloned from `state.histories` at the top of every iteration; `tools` and `system_prompt` are cloned in. History is append-only. | `commands/api_agent.rs:30` (`MAX_TOOL_ITERATIONS = 150`), `:1742`, `:1762-1765`, `:1779-1789`, `:1782` |
| **Nothing bounds a live session's context.** The only `history.truncate` is the retry/rewind path. The only compaction runs on app-restart resume. | `api_agent.rs:1437`; `src/stores/agentTaskStore.ts:290-312`, only called from `resumeApiConversation` (`:1501`, `:1558`) |
| **`/compact` is a placebo.** It trims the local UI array to the last 4 messages and inserts a note that literally says the backend context was not compacted. It never touches `state.histories`. | `src/components/agents/composer/slashCommandHandlers.ts:146-164` |
| **`read_file` has no pagination.** Schema accepts `path` only; returns the whole file up to `MAX_FILE_SIZE = 2_000_000`. One read of this repo's `core/worktree.rs` (98,696 B) is ~25k tokens resident forever. | `core/tool_runtime.rs:13`, `:122-135`, `:360-385` |
| **There is no edit tool.** `write_file` takes full content, so a read-then-write stores two full copies of the file in billed history. | `core/tool_runtime.rs:136-153`; `api_agent.rs:420-437` clones `tc.arguments` verbatim |
| **Bash output caps at 256 KB** (~65k tokens) per tool result, tail-truncated. | `core/tool_runtime.rs:16`, `:606-608`; SSH twin at `core/tool_runtime_ssh.rs:11`, `:464-466` |
| **Tool definitions are re-derived from live MCP discovery every turn**, and a failed server is silently skipped with a `warn`. Tools sit at the top of Anthropic's cache hierarchy, so a flap invalidates tools **and** system **and** messages. | `api_agent.rs:1699-1712`; `core/mcp_bridge.rs:380-427` |

### What we do **not** measure — and the parts we currently measure wrongly

This is the uncomfortable half. **We cannot presently state a trustworthy
baseline**, so nothing in this plan may claim a saving until Phase 0 lands.

1. ~~**Two disagreeing cost engines.**~~ **FIXED by CE2 (2026-07-31).** Rust
   `pricing.rs` and `src/lib/conversationCost.ts` each carried their own table;
   they disagreed on three shipped models (haiku 25%, gemini-2.5-pro 2x,
   llama-4-maverick 2x) and the frontend's single provider-agnostic
   `CACHED_INPUT_RATE_RATIO = 0.25` was wrong for every vendor. Both tables are
   deleted. Rates now live in `shared/model-pricing.json`, compiled into Rust
   with `include_str!` and imported by `src/lib/modelPricing.ts` — one file,
   two readers, no possible divergence. `calculate_turn_cost` remains
   registered but is still uncalled by the frontend **by design**: per-message
   IPC is the wrong shape, and it is no longer a second source of truth.
2. **Codex cached tokens are double-counted.** `analytics.rs:217-223` and
   `agent_sidecar/handler.rs:627-633` pass `input` **and** `cached` as separate
   arguments into `calculate_cost`, which is purely additive
   (`pricing.rs:227-230`). OpenAI's `cached_tokens` is a *subset* of prompt
   tokens. At a 90% hit rate that is a **2.6x overstatement**. Codex routinely
   runs 90%+ hit rates, so this is the normal case.
3. ~~**The frontend estimator has no cache-write term at all.**~~ **FIXED by
   CE2 (2026-07-31)** — folded in early because pricing cache reads correctly
   while ignoring cache writes would have been a worse meter than before.
   `estimateTurnCostUsd` now takes `cacheWriteTokens`, both listener sites pass
   `cache_creation_input_tokens`, and read / 5-minute-write / 1-hour-write each
   bill at their own published rate. CE3's remaining half was the
   live/persisted de-dup in `CostDashboardView` — **moot since the dashboard
   was removed (§0)** — plus the `cacheWriteTokens` field on the Codex
   sub-agent bucket (`SubAgentTokenBucket` still has none), which is the only
   part still worth doing.
4. **Two contradictory definitions of `inputTokens` in the same codebase.**
   `conversationCost.ts` used to do `Math.max(0, input - cached)`
   unconditionally (assumes input *includes* cached); `modelContext.ts:91-105`
   documents the opposite and adds them. **Partly fixed by CE2:** the shared
   table now carries `inputIncludesCacheRead` per vendor and the frontend
   estimator branches on it, so Anthropic's disjoint buckets are no longer
   wrongly subtracted. The Rust call sites (item 2) and `modelContext.ts` are
   still unbranched — that is CE1's remaining scope.
5. **Half the provider rows write no PacketADE-owned usage record.**
   `append_usage_entry` is called from exactly three sites, all in
   `api_agent.rs` — the in-process path only. `api-claude-oauth`,
   `api-openai-codex`, and `api-openai-agents` produce zero rows in
   `~/.packetade/usage.jsonl`; their spend is reconstructed by scraping
   `~/.codex/sessions/*.jsonl` and `~/.claude/cost-tally.json`, files the
   **vendor CLIs** write.
6. **The ~15 auxiliary LLM call sites emit no usage entry whatsoever** — side
   chat, subagent, custom agent, GitHub catch-up/triage/PR/investigate, code
   quality, spec import, four memory ops, insights. `UsageEntry.agent_id`
   exists and is hardcoded `None` at all three construction sites.
7. **Cache tokens are recorded then thrown away.** `UsageEntry` carries
   `cache_read`/`cache_write`; the `analytics.rs` ingest loop reads only
   `cost_usd`/`input_tokens`/`output_tokens`. `AnalyticsData`/`ModelUsage` have
   no cache fields, so there is no hit-rate figure anywhere in the product.
   This is the one gap CE4 still has to close, now as temporary
   instrumentation rather than a dashboard column.
8. ~~**The dashboard's "today" number double-counts in-process turns.**~~
   **MOOT since 2026-07-31 (§0).** The double-count lived in
   `CostDashboardView`'s `todayPersisted + liveSummary.costUsd`, which iterated
   a *persisted* conversation store and therefore re-added turns already in
   `usage.jsonl`. The dashboard is gone and the chip that reproduced the same
   sum is gone with it. The guardrails now evaluate the backend
   `read_usage_analytics` figures directly, with no live re-add — which also
   removes the risk that the double-count made a cap fire early.

**Where the researchers disagreed — stated, not papered over:**

- ~~**Anthropic per-MTok rates.**~~ **RESOLVED 2026-07-31 — see SPIKE-1 below.**
  The `$5/$25` audit was right and the shipped table was wrong by 3x on Opus.
  "Fable 5" and "Mythos 5" are real published models (we simply pin neither),
  so that fetch was sound after all. Every savings figure in this doc that was
  modelled at `$15/M` for Opus overstates the dollar saving by 3x; the
  token-mix ratios are unaffected.
- **Prefix size.** Estimates for the static tools+system prefix ranged from
  ~2–3k tokens to ~5k tokens. Both are byte-count-derived (~4 B/token), not
  tokenizer output. This matters only for the minimum-cacheable-length question
  on `claude-opus-4-6` / `claude-haiku-4-5` (4,096-token minimum).
- **Cache multipliers.** The Anthropic half is **resolved**: 0.1x read, 1.25x
  5-minute write, 2x 1-hour write, confirmed first-party. CE2 replaced the
  multipliers with absolute per-row rates *and* added the missing 1-hour-TTL
  column, so the "no TTL dimension in the type" gap is closed. The OpenAI half
  is **still open**: the shipped 0.50x read / 1.0x write values were carried
  over unverified into `shared/model-pricing.json` and are flagged there as
  such. The claimed 0.10x read / 1.25x write on GPT-5.6+ was not confirmed
  against a first-party source and was therefore **not** applied.
- **Everything is static analysis.** No request was executed, no cargo/pnpm run.
  Every savings figure below is *modelled from documented multipliers and
  measured source sizes*, not observed `cache_read_input_tokens`. Treat them as
  hypotheses that CE6's verification step confirms or kills.

---

## 2. The central insight: caching and context discipline are ONE design

The naive framing is "caching saves money on the prefix; compaction saves money
on the tail". That framing produces two teams shipping changes that cancel each
other out.

The correct framing: **prompt caching is a discount on a byte-stable prefix, and
context discipline is the practice of keeping that prefix stable and its growth
rate low.** Every context change is also a cache decision:

- Truncating old history to save tokens *invalidates the messages cache* and
  forces one full-price re-write of the new prefix. Compaction that fires too
  often costs more than it saves.
- Adding an image on iteration 0 and dropping it on iteration 1 costs a full
  messages-cache write mid-turn (Anthropic lists "images added/removed" as an
  explicit invalidator) — **and** loses the screenshot.
- A flaky MCP server shrinking the tools array invalidates tools → system →
  messages, the entire cache, for that turn and the next.
- Every unbounded `read_file` result is not just N tokens once; it is N tokens
  in the cached prefix, re-read at 0.1x for the rest of the session, and N
  tokens of cache *write* the first time.

So the design is a single object: **an ordering contract over the request.**

### The ordering contract

Anthropic's cache hierarchy is `tools → system → messages`. A change at any
level invalidates that level **and everything after it**. Therefore:

**INVARIANT 1 — the prefix is ordered stable-first, volatile-last.**

```
[ tools ]                       ← frozen for the life of the session
[ system: profile prompt ]      ← frozen for the life of the session
[ system: AGENTS.md / CLAUDE.md ] ← frozen for the life of the session
[ system: memory brief ]        ← query-derived; varies per session, never within
--- cache breakpoint region ---
[ messages: turn 1 .. turn N-1 ] ← append-only, never rewritten
[ messages: current turn tail ]  ← the only growing part
```

**INVARIANT 2 — nothing before the breakpoint may mutate within a session.**
Concretely, these must never move or change once a session starts:

| Element | Today | Required |
| --- | --- | --- |
| `tools` array contents **and order** | recomputed per turn from live MCP discovery (`api_agent.rs:1699-1712`) | resolved once at session start, frozen into `SessionConfig`; MCP failure reuses last known list, never emits a shorter array |
| `system_prompt` | already frozen at `:1032-1034`/`:1058`, read back at `:1689` — **compliant** | keep it that way; no clock, no counter, no per-request interpolation |
| system-prompt *internal order* | AGENTS.md → memory brief → profile prompt (`agentTaskStore.ts:573-601`) — volatile in the middle | profile → AGENTS.md → memory brief |
| message history | append-only — **compliant** (`:1905-1908`, `:2480-2481`) | keep; the only rewrite is the deliberate rewind at `:1437` and any future compaction, both of which are *known* cache-invalidation events |
| attachments | injected out-of-band on iteration 0 only, `mem::take`n (`:1767-1777`) — **violates the invariant** | stored as `ContentBlock::Image` in history when the user turn is appended; rendered from history thereafter |
| `thinking` params | set per session (`:1690`, `:1787`) — **compliant** | never expose a mid-conversation thinking toggle without accepting full cache loss |

**INVARIANT 3 — every deliberate invalidation is budgeted and logged.**
Compaction, rewind, and MCP-set changes each cost one full-prefix write
(1.25x input). They are allowed; they must be infrequent, threshold-driven, and
observable, not incidental.

This is why measurement leads the plan: **the acceptance test for the whole
programme is a non-zero, high, and stable `cache_read_input_tokens` share**, and
today there is no surface anywhere in the product that can display it.

---

## 3. Phased plan

Sequencing rule: **measurement lands first.** Phase 0 changes no request bytes
and saves nothing; it makes the meter honest. Phase 1 is the actual win.

> **Explicit warning — enabling caching breaks current cost reporting.**
> ~~The moment CE6 ships, `cache_creation_input_tokens` becomes non-zero. The
> frontend estimator has no write term, so the *most expensive* token class
> renders as **$0.00** in the message pill, the sidebar pill, the dashboard
> live-spend figure, and the daily/session/flight guardrails — which would
> therefore under-trigger precisely during cache thrash, the failure mode
> caching introduces. Simultaneously `CACHED_INPUT_RATE_RATIO = 0.25` would
> overstate Anthropic cache reads by 2.5x, hiding the real saving.~~
> **Largely closed by CE2 (2026-07-31):** cache writes and cache reads now bill
> at their own published per-model rates in both engines, and the 0.25 constant
> is gone. **Narrowed further by the dashboard removal (§0):** there are no
> message, sidebar, or dashboard dollar figures left to render wrong. What the
> warning still applies to is the **guardrails**, which do consume these
> numbers — so the remaining half of CE3 (the missing `cacheWriteTokens` on the
> Codex sub-agent bucket) stays a prerequisite of CE6.

### Phase 0 — Make the meter honest (no behaviour change)

#### CE1 — Token-semantics contract + Codex cached-token double-count fix
- **Changes:** Add `input_includes_cache: bool` to `ModelPricing` and branch
  inside `calculate_cost`, so the subset-vs-disjoint distinction lives with the
  vendor rather than at three call sites. Normalise all OpenAI-family payloads
  to the disjoint model at the edge. ~~Delete `Math.max(0, input - cached)` from
  `conversationCost.ts`~~ (**done in CE2** — the frontend now branches on the
  shared table's `inputIncludesCacheRead`; CE1 should move that branch into the
  shared cost primitive and apply it in Rust too) and make `modelContext.ts`
  occupancy provider-correct.
- **Files:** `src-tauri/src/commands/pricing.rs`,
  `src-tauri/src/commands/analytics.rs`,
  `src-tauri/src/commands/agent_sidecar/handler.rs`,
  `src/lib/conversationCost.ts`, `src/lib/modelContext.ts`,
  `agent-sidecar/src/providers/openai-codex.ts`
- **Effort:** medium
- **Expected saving:** $0 — this is a **baseline correction**. Codex rows are
  currently overstated ~2–2.6x at typical hit rates.
- **Verify:** Rust `#[test]` pricing a hand-computed invoice under both
  semantics; dashboard before/after capture on identical `usage.jsonl` data.
- **Depends on:** nothing. **Must be its own commit** with a CHANGELOG note —
  historical Codex totals will visibly halve and will otherwise be misread as
  data loss or as "the caching already worked".

#### CE2 — Collapse to ONE rate table — **DONE 2026-07-31**
- **Shipped, and how it differs from the plan above.** The plan proposed a
  `get_model_pricing_table` command hydrated at app start. That was rejected:
  it keeps *two* tables (Rust's literal + the frontend's cached copy) and adds
  a hydration race in which every cost pill renders wrong — or empty — until
  the IPC lands, on a value that never changes at runtime. Rates are static
  data, so they ship as static data. `shared/model-pricing.json` is now the
  single source of truth: Rust compiles it in with `include_str!`
  (`commands/pricing.rs`), the frontend imports it (`src/lib/modelPricing.ts`).
  One file, two readers, zero IPC, no hydration state, and drift is not
  *detected* — it is **impossible**, because there is nothing to drift from.
- **Rate corrections** (old → new, per MTok in/out):
  - Opus 5 / 4.8 / 4.7 / 4.6 / 4.5: `$15/$75` → **`$5/$25`** (the old figure was
    the deprecated Opus 4.1 rate — a 3x overstatement on the default model).
  - Haiku 4.5: `$0.80/$4.00` → **`$1/$5`** (the old figure was the retired
    Haiku 3.5 rate).
  - MiniMax M2 family: `$0.40/$2.20` → **`$0.30/$1.20`**, and M2.5/M2.7 now
    have their own rows instead of being swallowed by `contains("minimax-m2")`.
  - gemini-2.5-pro: the two tables disagreed 2x on output (`$5` vs `$10`);
    `$10` kept. llama-4-maverick: disagreed 2x (`0.40/1.20` vs `0.20/0.60`);
    `0.20/0.60` kept. Both flagged unverified in the JSON.
  - Added rows the catalog did not price at all: Fable 5, Mythos 5, Opus 5,
    Opus 4.5, Opus 4.1 (deprecated), Opus 4 (retired), Sonnet 5, Sonnet 4.5,
    Sonnet 4, Haiku 3.5 (retired).
- **Cache-aware.** Every row carries absolute `cacheRead`, `cacheWrite5m`, and
  `cacheWrite1h` rates (the 1-hour TTL had no representation at all before).
  Both engines price all five buckets additively; the frontend estimator gained
  the `cacheWriteTokens` term and both listener sites now pass
  `cache_creation_input_tokens`. `CACHED_INPUT_RATE_RATIO = 0.25` is deleted.
- **Date-aware.** Claude Sonnet 5 is `$2/$10` through 2026-08-31 and `$3/$15`
  from 2026-09-01. A row may carry a `schedule` of dated windows instead of a
  single `rates` object, and **every lookup takes the date of the priced turn**
  (`pricing_for_at` / `ratesForModel(model, at)`), defaulting to today only for
  live turns. The switchover needs no human action and no migration, and
  historical turns are never repriced: stored `cost_usd` is read, not
  recomputed, and the two places that do recompute (message-level UI fallback,
  Codex session scrape) pass the record's own timestamp.
- **Files:** `shared/model-pricing.json`, `shared/model-pricing-cases.json`,
  `src-tauri/src/commands/pricing.rs`, `src-tauri/src/commands/analytics.rs`,
  `src/lib/modelPricing.ts` (new), `src/lib/conversationCost.ts`,
  `src/lib/api-models.ts`, `src/stores/apiAgentListeners.ts`,
  `src/components/agents/chat/MessageList.tsx`,
  `src/components/agents/chat/SessionMetaLine.tsx`,
  `src/lib/__tests__/modelPricing.test.ts` (new)
- **Expected saving:** $0 — correctness. Removes a 3x Opus overstatement, a
  2.5x post-caching cache-read error, and three live rate divergences.
- **Verify:** `shared/model-pricing-cases.json` is a golden fixture run by
  **both** languages (`pricing.rs::tests::golden_cases_match` and
  `modelPricing.test.ts`). The table can't drift; this proves the two
  *implementations* — matching order, date windows, cost formula — can't
  either. Rust 499 passed / 2 ignored; Vitest 1761 passed across 212 files.
- **Not done here (deliberately):** stored historical figures were **not**
  migrated. Every `cost_usd` already in `~/.packetade/usage.jsonl` and every
  `costUsd` stamped on a persisted message was computed with the old rates —
  Anthropic rows are overstated ~3x, MiniMax M2 rows ~1.6x, Haiku 4.5 rows
  understated ~20%. Repricing them is a product decision (it visibly rewrites
  history), not a refactor, so it is left to CE5's one-time-import work.

#### CE2-B — Reprice the stored history — **DONE 2026-07-31**

The product decision CE2 deferred, taken by the owner on 2026-07-31 and no
longer blocked on CE5 (which is CUT). CE5's cancellation is precisely why this
had to become its own item: there is no longer a one-time-import workstream to
carry it.

- **Changes:** `src-tauri/src/core/reprice.rs` — a one-shot startup migration in
  the established `core::migration` mould (called from `lib::run` after
  `migrate_data_dir`, best-effort, warn-and-continue). It rewrites `cost_usd` in
  `~/.packetade/usage.jsonl` and `messages[].costUsd` in
  `~/.packetade/conversations/*.json`, recomputing each figure **from that
  record's own stored token counts** through the shared table, priced at the
  record's **own date** via `pricing_for_at`/`calculate_cost_at`.
- **Why automatic rather than a script:** the numbers feed a hard stop that
  fires without user action, and this repo's only precedent for touching user
  data is the startup migration (`scripts/` is build tooling). It is a total
  no-op on a fresh install — it returns before creating so much as a state file.
- **Safety:** originals copied to `usage.jsonl.pre-reprice-<date>` and
  `conversations.pre-reprice-<date>/` (never overwritten, never deleted) before
  any write; writes go through tmp+rename. Rewritten records carry
  `repriced_at`/`repricedAt` + `cost_usd_before`/`costUsdBefore`. Idempotent per
  record on that marker, with `PersistedState.cost_reprice_v1_at` as a
  fast-path skip.
- **Deliberately skipped:** records without the token detail to recompute, and
  models absent from the table (`calculate_cost_at` would return `0.0` and erase
  a real figure). Also the flight rollups — `flights[].total_cost`,
  `attempts[].cost`, `tasks[].cost`, `planner_cost`,
  `autonomy_runtime.action_history[].cost` — which carry only a collapsed
  `tokens` sum with no per-class split and no per-turn model, so they are not
  recomputable without guessing. **Open consequence: a per-flight cap can still
  trip early on pre-CE2 spend.** Recorded in `backlog.md`.
- **Why it matters with the dashboard gone (§0):** `usage.jsonl` `cost_usd` is
  read by `read_usage_analytics`, which is what `assertCostGuardrailsAllowLaunch`
  hard-stops on. A 3x-overstated Opus history trips a daily/monthly cap at ~⅓ of
  the authorised spend. The message-level `costUsd`, by contrast, now has **no
  reader at all** (`aggregateConversationCost` recomputes from tokens); it is
  repriced for consistency, not for behaviour.
- **Verify:** `core::reprice::tests` — Opus 3x down, Haiku up, MiniMax M2 +
  M2.7, date-aware selection across the Sonnet 5 rollover, skip-not-corrupt for
  four flavours of unrecomputable record, backup-before-write, no-overwrite of
  an existing backup, idempotency (ledger + conversations), OpenAI
  `inputIncludesCacheRead` subtraction, reasoning-at-output-rate, checkpoint
  subdirectories ignored, and fresh-install total no-op.

#### CE3 — Cache-write term in the token accounting — **RE-SCOPED 2026-07-31**
- **Re-scope.** Originally "make the estimator and the dashboard correct". The
  dashboard is gone (§0), so the live/persisted de-dup is deleted from scope
  and what remains is a narrow correctness fix in the numbers the **guardrails**
  consume. Most of the original scope already shipped inside CE2.
- **Remaining changes:** add `cacheWriteTokens` to the `agentStreamingStore`
  Codex sub-agent bucket (`SubAgentTokenBucket` has no such field, so a
  multi-agent Codex turn under-reports the most expensive token class once CE6
  makes it non-zero). ~~Scope `liveSummary` to in-flight conversations~~ —
  dropped with `CostDashboardView`.
- **Already done in CE2:** `cacheWriteTokens` on `estimateTurnCostUsd`, both
  listener call sites passing `cache_creation_input_tokens`, per-class rates.
- **Files:** `src/stores/agentStreamingStore.ts`, `src/lib/conversationCost.ts`
- **Effort:** small
- **Expected saving:** $0 — without it CE6 makes the **guardrails** under-trigger
  during cache thrash. No longer a UI-correctness item; there is no UI.
- **Verify:** synthetic multi-agent turn with known cache-write tokens; guardrail
  fires at the right threshold.
- **Depends on:** CE1, CE2. **Blocks CE6.**

#### CE4 — Measure the cache hit rate (temporary instrumentation) — **RE-SCOPED 2026-07-31**
- **Re-scope.** Originally "add three columns and a hit-rate tile to the Cost
  Dashboard". There is no dashboard (§0) and no appetite for building one, so
  this becomes **temporary instrumentation whose only job is to prove CE6
  worked**, then go dormant. Explicitly NOT a product feature: no view, no
  route, no always-mounted chip.
- **Changes:** a script (or dev-only command) that reads `~/.packetade/usage.jsonl`
  — where `cache_read`/`cache_write` are *already* recorded and then discarded by
  the ingest loop — and prints input / cache_read / cache_write / output and
  **cache hit rate** = `cache_read / (input + cache_read + cache_write)`, broken
  down by model. Extending `ModelUsage`/`AnalyticsData` is only warranted if the
  guardrails end up needing the fields; they do not today.
- **Files:** `scripts/`, optionally `src-tauri/src/commands/usage.rs`
- **Effort:** small
- **Expected saving:** $0 — this is *the* before/after artifact. Hit rate is
  rate-independent and therefore survives the stale-pricing-table problem
  entirely, which is exactly why it is the acceptance signal rather than dollars.
- **Verify:** reads ~0% today (correct — caching is off) and jumps after CE6.
- **Depends on:** CE1.
- **Retire when:** CE6 is verified across the CE6-PRE benchmark. Do not let it
  grow into a reporting surface; that is the thing that was just deleted.

#### CE5 — ~~Self-owned ledger from every path, with attribution~~ — **CUT 2026-07-31**

**Cut by owner decision (§0).** Full per-path ledger coverage — calling
`append_usage_entry` from the sidecar handler and the ~15 auxiliary call sites,
adding `task_class`/`run_id`/`agent_id` attribution, and demoting the vendor CLI
files to a one-time historical import — existed to make a permanent reporting
surface complete and trustworthy. With the reporting surface deleted, the
coverage is not worth its cost.

Consequences, stated so they are not rediscovered later:

- **The OAuth-removal ordering constraint is dissolved.** The "ledger first,
  OAuth removal second" rule was entirely about not freezing half the
  dashboard's history mid-transition. No dashboard, no constraint. See
  Sequencing.
- **Guardrails are unaffected.** They read `read_usage_analytics`, which keeps
  ingesting `~/.packetade/usage.jsonl` plus the vendor CLI files exactly as
  today. Subscription providers were never in the PacketADE-owned ledger and
  still are not; that gap is now permanent and accepted.
- **CE6-PRE loses its `run_id`.** It needs a way to select one benchmark run out
  of the ledger. Add `run_id` alone, as CE6-PRE's own temporary instrumentation
  (serde-default, so old lines parse) — not as the first slice of a revived CE5.
- **LM7 loses `task_class`.** The local-routing plan's headline claim about the
  ~15 auxiliary call sites cannot be substantiated from the ledger. LM7 must
  either carry its own measurement or state its saving as modelled, not
  measured. Recorded in `backlog.md`.

#### CE6-PRE — Frozen replayable benchmark
- **Changes:** Fixture of N scripted conversations (fixed prompts, repo pinned
  to a commit, fixed model, fixed tool-permission answers) + a script filtering
  `usage.jsonl` by `run_id` and printing input / cache_read / cache_write /
  output / $ / hit-rate broken down by `task_class`.
- **Files:** `scripts/`, `src-tauri/src/commands/usage.rs`
- **Effort:** medium
- **Expected saving:** $0.
- **Rationale:** caching's benefit is entirely a function of prefix stability
  *across turns*, which is a property of the workload. Without a pinned
  workload, a month-over-month drop is indistinguishable from "I asked shorter
  questions this week."
- **Depends on:** ~~CE5~~ — CE5 is CUT (§0), so CE6-PRE now carries the single
  `run_id` field on `UsageEntry` itself, serde-default, as its own temporary
  instrumentation. Do not treat that as a first slice of a revived CE5.

### Phase 1 — Caching (the win)

#### CE6 — Anthropic automatic cache breakpoint — **DONE 2026-07-31**

- **What shipped.** `build_anthropic_body` (a new pure function extracted from
  `stream_chat` so the caching contract is testable without a network call) now
  emits a single top-level `"cache_control": {"type": "ephemeral"}` on every
  Messages API request. This is Anthropic's **automatic** caching mode: the API
  places the breakpoint on the last cacheable block and advances it as the
  conversation grows, so we hand-manage nothing. `system` deliberately stays a
  bare string — promoting it to a text-block array is only needed to hang an
  *explicit* per-block breakpoint off it (that is CE11, still not done).
- **Shape verified first-party 2026-07-31**, not guessed:
  <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
  ("Automatic caching … the recommended starting point for most use cases") and
  the `POST /v1/messages` reference, which lists a top-level optional
  `cache_control` of type `CacheControlEphemeral` described as "Top-level cache
  control automatically applies a cache_control marker to the last cacheable
  block in the request." **No beta header is required.**
- **TTL.** `ANTHROPIC_CACHE_TTL: Option<&str> = None` — the API default
  5-minute window. `Some("1h")` is the one-line switch to the 1-hour window and
  the constant carries the reasoning inline: cache *reads refresh the TTL for
  free*, so 5m already survives an entire agent loop, while 1h charges every
  one-shot turn 2x input (vs 1.25x) for a benefit only an idle-returning user
  collects. Do not flip it without SPIKE-3's idle-share measurement.
- **Files:** `src-tauri/src/core/llm_anthropic.rs`,
  `src-tauri/src/core/llm_types.rs` (`LlmRequest.cache_key`),
  `src-tauri/src/commands/api_agent.rs` (`log_cache_usage`),
  `scripts/cache-hit-rate.mjs` (new).
- **Expected effect (modelled, not yet measured).** 60–80% input reduction on
  multi-iteration turns; ~0%, and ~25% *worse* on input, for one-shot abandoned
  turns. Worked example from the audit: 20 iterations, ~5k stable prefix,
  ~3k/iteration growth → ~670k billed input tokens before, of which the ~570k
  quadratic term becomes 0.1x reads. **No measured figure is claimed here** —
  the change was verified statically and by unit test; the token-mix
  confirmation is the acceptance step below.
- **How we prove it worked (this is the re-scoped CE4).** Prompt caching fails
  **silently** below a model's minimum cacheable length, so "it compiled" proves
  nothing. Two instruments landed with it:
  1. `log_cache_usage` in `api_agent.rs` emits one `CE6-CACHE` line per LLM
     round trip (`target: "packetade::cache"`) with `iteration`, `input_tokens`,
     `cache_read`, `cache_write` and the hit rate. Per *iteration*, not per
     turn, so a mid-turn invalidation shows up as the exact iteration where
     reads fall back to zero. **Acceptance: `cache_read` is 0 on iteration 0
     (the write) and non-zero from iteration 1 onward.**
  2. `scripts/cache-hit-rate.mjs` reads `~/.packetade/usage.jsonl` — where
     `cache_read`/`cache_write` were already recorded and then discarded by the
     ingest loop — and prints input / cache_read / cache_write / output and
     hit rate **per model**. It reads the vendor-semantics flag out of
     `shared/model-pricing.json` so the denominator means the same thing for a
     superset vendor and a disjoint one. Expected ~0% before this change, high
     and stable after. It prints an explicit diagnostic when every row is 0.
- **Unit-test evidence** (`core::llm_anthropic::tests`): the body carries the
  top-level marker; `ttl` is absent (5-minute default); `system` is still a bare
  string; two identical requests serialise byte-identically (nothing clock- or
  counter-derived can poison the prefix); `cache_key` never leaks into the
  Anthropic body.
- **Still outstanding, deliberately:** hit rate has not been observed against
  the live API, so SPIKE-4 (minimum-cacheable-prefix per model, notably
  `claude-opus-4-6` / `claude-haiku-4-5` at 4,096 tokens on a bare project) is
  still open and is what the two instruments above exist to answer.
- **Depended on:** CE3 (hard), CE4 (shipped here as the two instruments),
  CE7 (attachment-bearing sessions still do not benefit — unchanged).
- **CE3's remainder was NOT done first, and that is deliberate — here is why it
  is safe.** CE3's outstanding half is the missing `cacheWriteTokens` field on
  `agentStreamingStore`'s **Codex sub-agent** bucket (`SubAgentTokenBucket`).
  That bucket is fed only by the *sidecar* Codex MultiAgentV2 path
  (`api-openai-codex`), which neither CE6 nor CE9 touches: CE6 is the in-process
  Anthropic provider, CE9 the in-process OpenAI-compat provider, and neither
  makes a Codex sub-agent's cache writes non-zero. The dependency was written
  against "any change that makes `cache_creation_input_tokens` non-zero
  anywhere"; scoped to what actually shipped, it is not triggered. **It still
  blocks any future sidecar caching work (SPIKE-2).**

#### CE7 — Fix the attachment lifecycle
- **Changes:** Construct `ContentBlock::Image` into stored history when a user
  message carries attachments; delete the `iteration == 0` /
  `std::mem::take` special case; render images from history blocks rather than
  the side-channel `request.attachments`.
- **Files:** `src-tauri/src/commands/api_agent.rs`,
  `src-tauri/src/core/llm_anthropic.rs`,
  `src-tauri/src/core/llm_openai_compat.rs`,
  `src-tauri/src/core/llm_types.rs`
- **Effort:** medium
- **Expected saving:** removes one guaranteed full-prefix messages-cache write
  per attachment-bearing turn. **Also a standalone correctness bug** — the model
  currently loses the screenshot after its first tool call. `ContentBlock::Image`
  is declared at `llm_types.rs:66-70` and constructed nowhere in `src-tauri`.
- **Verify:** hash-of-serialised-prefix log line identical across iterations 0
  and 1 of an attachment turn; model can still describe the image on iteration 3.
- **Depends on:** none (ship with or before CE6).

#### CE8 — Freeze the tool array for the life of the session
- **Changes:** Resolve `tool_definitions_with_mcp_trust` once at session start,
  store the `Vec<ToolDefinition>` in `SessionConfig` alongside
  `system_prompt` and the existing `mcp_trust_snapshot`. On MCP discovery
  failure, reuse the last-known list and log loudly rather than silently
  emitting a shorter array.
- **Files:** `src-tauri/src/commands/api_agent.rs`,
  `src-tauri/src/core/tool_runtime.rs`, `src-tauri/src/core/mcp_bridge.rs`
- **Effort:** medium
- **Expected saving:** eliminates sporadic total-cache invalidation. Each flap
  currently costs two full-prefix writes at 1.25x instead of 0.1x reads —
  roughly $1.50 vs $0.06 on a 40k prefix at $15/M. Also a latency win: MCP
  discovery spawns child processes and does stdio JSON-RPC per turn.
- **Verify:** kill an MCP server mid-session; hit rate does not drop.
- **Depends on:** CE4 (to observe).

#### CE9 — OpenAI-compat: parse `cached_tokens`, send `prompt_cache_key` — **DONE 2026-07-31**

- **What shipped.** The two hardcoded `cache_read_input_tokens: 0` literals are
  gone. Both stream terminators now route through one `finish_compat_turn`
  helper that reports the real `usage.prompt_tokens_details.cached_tokens`
  (Chat Completions' documented path;
  <https://developers.openai.com/api/docs/guides/prompt-caching>). Cache
  *writes* stay 0 and are documented as such: OpenAI-style caching is automatic
  and writes are neither billed nor counted.
- **Where the superset/disjoint normalisation went — a correction to the plan
  above.** The plan said to subtract `cached_tokens` from `prompt_tokens` before
  reporting. That would have been a **regression**: the frontend estimator
  already branches on the shared table's `inputIncludesCacheRead` and subtracts
  itself (`conversationCost.ts`), so normalising on the wire would have
  double-subtracted and *under*-billed OpenAI turns. Instead:
  - The wire payload and the `UsageEntry` row keep the **vendor's own numbers**,
    which is what both cost engines are already written against.
  - Normalisation happens at the Rust cost call site, via a new
    `pricing::billable_input_tokens(model, input, cache_read)` that reads the
    per-vendor flag out of the shared table. This is exactly where
    `pricing.rs`'s own module doc says it belongs ("normalising those payloads
    … happens at the call sites, not here"), and it means no call site hardcodes
    a vendor assumption. Applied at all three `calculate_cost` sites in
    `api_agent.rs`. A no-op before this change (cache reads were always 0) and a
    no-op for Anthropic (disjoint), so nothing historical shifts.
  - `scripts/cache-hit-rate.mjs` applies the same flag when computing its
    denominator, so a MiniMax row and an Anthropic row are comparable.
- **`prompt_cache_key`.** `LlmRequest` gained an optional `cache_key`;
  `api_agent.rs` fills it with the session id, stable for the session's life.
  It is sent **only** when `provider_id == "openai"` — MiniMax / OpenRouter /
  Ollama do not document the field and an unknown parameter is a 400 risk for
  zero benefit. A unit test asserts it never reaches the Anthropic body.
- **Files:** `src-tauri/src/core/llm_openai_compat.rs`,
  `src-tauri/src/core/llm_types.rs`, `src-tauri/src/commands/pricing.rs`,
  `src-tauri/src/commands/api_agent.rs`, `scripts/cache-hit-rate.mjs`.
- **Saving:** none new — OpenAI/MiniMax/OpenRouter already cached automatically
  with no client opt-in. This makes the existing saving **visible** and stops
  cached input being priced at the full input rate.
- **Note for CE1.** This closes the in-process half of the superset/disjoint
  contract. The Codex double-count in `analytics.rs` and
  `agent_sidecar/handler.rs` is untouched and remains CE1's scope — those sites
  should call `billable_input_tokens` rather than re-deriving the rule.
- **Depended on:** CE1, CE2. Per-provider gating was mandatory and is enforced
  by `config.provider_id` checks, not by a shared code path.

#### CE10 — System-prompt ordering contract
- **Changes:** Reorder frontend composition to profile prompt → AGENTS.md →
  memory brief (currently AGENTS.md → memory brief → profile prompt, with the
  query-derived brief in the middle). Separately, confirm whether a non-empty
  override *replacing* `build_system_prompt` entirely (`api_agent.rs:1032-1034`)
  is intended — today an AGENTS.md-only project silently loses the base tool
  instructions, the CLAUDE.md injection, and the `<PACKETCODE_DONE>` sentinel
  that Flight Deck `AttemptTile` depends on.
- **Files:** `src/stores/agentTaskStore.ts`,
  `src-tauri/src/commands/api_agent.rs`,
  `src-tauri/src/core/llm_system_prompt.rs`
- **Effort:** small
- **Expected saving:** cross-session prefix reuse only — a few hundred to ~2k
  tokens at 0.1x-vs-1.0x per new session in the same project. Small, but it is
  the item that makes INVARIANT 1 true rather than aspirational.
- **Depends on:** CE6 (pointless before caching exists).

#### CE11 — Explicit breakpoints (Phase 2 caching)
- **Changes:** `cache_control` on the **last** element of the tools array;
  convert `system` from a bare string to
  `[{"type":"text","text":sp,"cache_control":{"type":"ephemeral"}}]`; retain a
  rolling message-tail breakpoint. Cap at 4 breakpoints total.
- **Files:** `src-tauri/src/core/llm_anthropic.rs`,
  `src-tauri/src/core/llm_types.rs`
- **Effort:** medium
- **Expected saving:** incremental over CE6 — gives a durable floor so that a
  messages-level invalidation still reads tools+system at 0.1x instead of
  re-writing them.
- **Verify:** hit rate under deliberate messages-level invalidation stays above
  the CE6 baseline.
- **Depends on:** CE6 **shipped and measured**. Do not build this speculatively
  — if CE6's measured hit rate is already >90%, CE11 may not be worth the 400-risk
  (the top-level marker errors if 4 explicit breakpoints exist, or if the last
  block carries a conflicting explicit TTL).

### Phase 2 — Context discipline

#### CE12 — `read_file` offset/limit + default line cap
- **Changes:** Add `offset`/`limit` params and a ~1500–2000 line default,
  returning a `[showing lines A-B of N; call again with offset]` footer. Keep
  the 2 MB hard error as a backstop. Update the tool description to instruct
  grep-then-ranged-read.
- **Files:** `src-tauri/src/core/tool_runtime.rs`,
  `src-tauri/src/core/tool_runtime_ssh.rs`,
  `src-tauri/src/core/llm_system_prompt.rs`
- **Effort:** small
- **Expected saving:** 60–80% on read-heavy transcripts. The system prompt
  already says "For large files, grep first, then read just the section you
  need" (`llm_system_prompt.rs:100`) — the schema makes that impossible to obey.
- **Depends on:** none.

#### CE13 — Bash output: 256 KB → 32–48 KB, head+tail retention
- **Changes:** Lower `MAX_OUTPUT_SIZE`; switch from tail-truncation to
  head ~60% + tail ~40% with an elided-bytes marker. Same for SSH.
- **Files:** `src-tauri/src/core/tool_runtime.rs`,
  `src-tauri/src/core/tool_runtime_ssh.rs`
- **Effort:** small
- **Expected saving:** removes the worst tail risk in the system — one runaway
  `cargo build` adds ~65k tokens re-billed across every remaining iteration
  (~1.3M tokens over 20 iterations). Head+tail also fixes a *quality* bug:
  current tail-truncation drops the summary line the model needs.
- **Depends on:** none.

#### CE14 — Targeted edit tool — **DONE 2026-07-31** (`422ab94`)

Shipped ahead of the rest of Phase 2, because output tokens are billed at ~5x
input and caching does nothing for them — this was the largest remaining lever
that CE6 could not touch.

**What shipped.** `edit_file` performs exact-string replacement and is
registered for **all five in-process providers at once** — `api-claude`,
`api-openai`, MiniMax, OpenRouter, and Ollama. `write_file` remains for new
files and whole-file rewrites.

- **Ambiguous matches ERROR.** If `old_string` occurs more than once the call
  fails naming the ambiguity, rather than editing the first occurrence. Silent
  first-match editing is how files get corrupted, and a refusal the model can
  read and retry is cheaper than a corrupted file the user has to find.
- **Same approval gate as `write_file`,** and the gate materialises its preview
  through the **same `apply_exact_edit`** the executor uses — so the diff you
  approve is byte-for-byte what lands, rather than a second implementation that
  can drift.
- **Local only.** The SSH write path (`tool_runtime_ssh.rs`) appends a trailing
  newline via heredoc, so a remote read-modify-write would grow the file by one
  newline per edit. Remote agents keep whole-file writes until that is fixed —
  which is now the highest-value remaining CE item for SSH work.

**Files:** `src-tauri/src/core/tool_runtime.rs` (tool schema, dispatch,
`apply_exact_edit`), `src-tauri/src/core/llm_system_prompt.rs`,
`src-tauri/src/commands/api_agent.rs`.

**Two follow-ups it exposed** (both open, both in the State of the ADE report):

1. **Agent profiles with an explicit `allowedTools` list never get it**
   (F-2.1-14). `allowedTools` is an allow-list, so the shipped read-only
   profile, `SCOUT_ALLOWED_TOOLS`, and any user profile silently exclude
   `edit_file` and fall back to whole-file writes — i.e. they keep paying the
   exact cost this item removed. Every future tool addition has the same defect;
   a capability group (`"edits"`) is the durable fix.
2. **A failed edit still renders a diff row** (F-2.1-15).
   `ToolCallRenderer.tsx:39` routes edit calls into the diff layer on
   `status === "done" || "error"`, and the frontend previews by first match — so
   an ambiguity refusal draws a phantom change the backend declined to write.
   Pre-existing (Claude Code's `Edit` hits the same renderer); `edit_file`'s
   deliberate error just makes it easy to reach.

**Measurement still owed.** The expected 5–10x on editing output spend is
modelled, not observed. `scripts/cache-hit-rate.mjs` covers the input side only;
the output-side proof needs a before/after on a real editing session.

**Ordering:** landed before CE8, as this item asked. CE8 may now freeze.

#### CE15 — Real in-session compaction, wired to `/compact`
- **Changes:** Token-budget check at the top of each loop iteration
  (`api_agent.rs:1762`) that, above a threshold, rewrites the oldest portion of
  `state.histories[session_id]` into one summary message — preserving the first
  user turn, the last N turns verbatim, and `tool_use`/`tool_result` pairing.
  New Tauri command so `/compact` actually compacts; delete the apology string.
  Reuse the budgets already chosen for resume (80 messages / 120k chars / 4k per
  tool result).
- **Files:** `src-tauri/src/commands/api_agent.rs`,
  `src/components/agents/composer/slashCommandHandlers.ts`, `src/lib/tauri.ts`
- **Effort:** large
- **Expected saving:** bounds unbounded sessions. The resume caps imply the team
  already considers ~30k tokens a reasonable working context.
- **Verify:** hit rate recovers within one turn of a compaction event; total
  turn cost after compaction is below the pre-compaction trajectory.
- **Depends on:** CE6 + CE4. **Must be designed against the cache**, not
  independently — compaction rewrites the prefix and therefore costs exactly one
  full-price write. Threshold-driven and infrequent, never per-turn.

#### CE16 — Document `spawn_subagent`; soft-checkpoint the iteration cap
- **Changes:** Add `spawn_subagent` to the Tools section of the system prompt as
  the preferred way to explore unfamiliar code (it exists, is registered at
  `tool_runtime.rs:209`, runs a bounded 8-iteration Haiku loop over read-only
  tools returning one paragraph — and is **not mentioned in the prompt at all**).
  Add an explicit grep-then-ranged-read instruction. Surface a soft checkpoint
  around 40–60 iterations instead of silently allowing 150.
- **Files:** `src-tauri/src/core/llm_system_prompt.rs`,
  `src-tauri/src/commands/api_agent.rs`
- **Effort:** small
- **Expected saving:** delegating one "find where X is handled" exploration to
  Haiku can keep 50–100k tokens out of the Opus transcript for the rest of the
  session. Zero engineering cost for the prompt half.
- **Depends on:** none.

### Phase 3 — Attribution and hygiene

#### CE17 — Per-attempt cost attribution
- **Changes:** Write `Attempt.cost` / `Attempt.tokens` alongside the flight
  rollup in `accumulate_executor_cost` (the DTO fields exist at
  `flight_cost.rs:385-386` and nothing writes them).
- **Files:** `src-tauri/src/commands/flight_cost.rs`,
  `src-tauri/src/commands/agent_sidecar/handler.rs`
- **Effort:** small
- **Expected saving:** $0 — but it unlocks the cleanest possible A/B: one
  flight, N parallel worktree attempts, caching on for some agents and off for
  others, same task, same repo state. A controlled experiment rather than a
  longitudinal comparison.
- **Depends on:** CE1.

#### CE18 — `run_claude` hygiene
- **Changes:** Stop passing `--allowedTools Read,Glob,Grep,Bash(read-only)` for
  the five **pure-text** callers (`memory.rs:28,43,106`, `spec.rs:50,73`).
  **Per-caller, not global** — `memory.rs:11` (scan codebase) and
  `github.rs:1577` (investigate issue) genuinely need those tools. Also pass an
  explicit `--model`: today none of the seven callers do, so they run on
  whatever the user's CLI default is (Sonnet/Opus class) with zero token
  accounting.
- **Files:** `src-tauri/src/claude/binary.rs`,
  `src-tauri/src/commands/memory.rs`, `src-tauri/src/commands/spec.rs`,
  `src-tauri/src/commands/github.rs`
- **Effort:** small
- **Expected saving:** removes the per-call tool-token tax (~496 system tokens
  on Sonnet-class merely for tools being present) and, more importantly, the
  unbounded tail where the model Greps the repo before answering a JSON
  transform. Independent of the whole LM plan.
- **Depends on:** none.

#### CE19 — Per-surface input caps
- **Changes:** Replace the 1 MB global `MAX_INPUT_SIZE` guard on `side_chat.rs`,
  `insights.rs`, `memory.rs`, `spec.rs` with per-surface caps mirroring the
  pattern already used at `code_quality.rs:479` and `github.rs:1597-1598`.
- **Files:** those four
- **Effort:** small
- **Expected saving:** tail risk. 1 MB is ~250k tokens — dollars for a single
  call. Sidecar sites already cap at 50–200 KB.
- **Depends on:** none.

#### CE20 — Retire the routing placebo — **SUPERSEDED 2026-07-31** (`d8fb78e`)

The original item: `resolveForTask` had **zero production callers** (two Vitest
mocks were the only references) and `ProviderRoutingCard` wrote to
`packetade:routing` localStorage that nothing read — so delete it or mark it
"not yet wired", but do not leave it silently inert.

**It was wired instead of retired.** WI-1 of
[`oauth-removal-plan.md`](./oauth-removal-plan.md) needed a routing seam to move
five auxiliary features off subscription credentials, and this card was the
obvious place to expose the choice. What exists now:

- `src/lib/attemptRouting.ts` calls `routingStore.resolveForTask(...)` on the
  Draft-patch path — the first production caller.
- `ProviderRoutingCard` gained an **Auxiliary AI tasks** section covering spec
  import, Code Quality explain/summarize, PR description and PR review, mirrored
  into a Rust `AuxRoutingState` that `core/aux_llm.rs` reads.
- With nothing pinned, `aux_llm` falls back to the cheapest provider holding a
  keyring `api-key-*` credential, priced against a representative aux workload.

**The original objection was half right and worth keeping on record.** The
`TaskType` union really is flight-worktree-shaped and really does default to the
PTY id `"claude-code"`; it could not express auxiliary routing, so auxiliary
routing got its own `AuxTaskClass` enum in Rust rather than being forced through
it. Two vocabularies now live on one settings card. That is the debt this item
turned into — a naming/consolidation cleanup, not a deletion.

**Remaining work:** none that blocks anything. Fold `TaskType` and
`AuxTaskClass` into one vocabulary when LM6 extends routing to the rest of the
auxiliary surfaces.

---

## 4. What we are deliberately NOT doing

### Batch APIs — ruled out for now, with named triggers

Anthropic Message Batches and OpenAI Batch both give a flat 50% discount. We are
not building either. The reasons are structural, not economic:

1. **The flagship async surface is not batch-shaped.** "Async flight" sounds
   like a batch candidate and will keep attracting the idea. It is not:
   `flight_attempts.rs:800` hands off to the *same* `start_api_agent_session`
   used by live conversation tiles; `:820` enables the full local tool set;
   `asyncFlightStore.ts:1284` subscribes a live streaming conversation per
   attempt. "Async" means *unattended by the human*, not *non-interactive*.
2. **"Batch supports tool use" is a trap.** It is true and nearly useless for
   agent loops: batch can *emit* a `tool_use` block but cannot execute a local
   tool and continue. Every round-trip is a fresh batch submission against a
   24-hour worst-case window — days to weeks per attempt.
3. **The addressable base is tiny.** The only genuinely no-tool Messages API
   calls in the whole backend are three: GitHub catch-up, GitHub triage, and
   side chat. All are pinned to `claude-haiku-4-5`; a full 20-issue triage run
   costs roughly **$0.01**. Two of the three stream into a UI the user is
   watching, disqualifying them outright.
4. **`stream: true` is rejected by both vendors**, and the only in-process LLM
   abstraction we have is `LlmProvider::stream_chat` — there is no
   non-streaming completion path anywhere in the Rust core.
5. **No durable job runner exists.** PacketADE is a desktop app the user closes.
   `recover_flights_on_startup` deliberately does *not* resume work (one of its
   own tests is `recover_never_resumes_bounded_autonomy_after_restart`), and the
   legacy scheduler was intentionally removed. A batch integration must first
   ship a persisted job store and restart-safe poller.
6. **Opportunity cost.** Caching requires no new infrastructure, no new UX, no
   job store, and applies to the expensive Sonnet/Opus flight-attempt and
   conversation-tile traffic that batch can never touch. Caching and batch
   *stack*, so caching is strictly the prerequisite.

**Note:** removing subscription OAuth actually *unlocks* batch — the Batches API
is API-key/Workspace-scoped and was never reachable from
`~/.claude/.credentials.json` OAuth. The door opens; the room is still empty.

**Triggers that would flip this decision** (record in `backlog.md`):
(a) a "triage the entire backlog" feature over hundreds of issues instead of the
current 20-at-a-time synchronous drawer; (b) an "explain all failed checks" bulk
mode over a whole quality run; (c) an offline prompt/profile regression-eval
harness. All three are genuine batch shapes — many independent single-turn
no-tool requests, no live viewer, latency-tolerant. Each of (a) and (b) also
requires a UX change from synchronous-wait to fire-and-collect-later *before*
batch becomes usable; the API discount is the easy part.

### Local models for anything with tools

`llm_openai_compat.rs:267` logs `"malformed tool-arg JSON from stream; coercing
to empty object"` — the shim **silently coerces malformed tool arguments to
`{}` and proceeds**. That warn line is direct evidence the failure mode was
already observed. Small local models emit malformed tool-call JSON far more
often than frontier models, so a local route on any tool-using surface would
execute tools with no arguments and report success.

Therefore: **no local routing on `spawn_subagent`, custom agents, codebase
scan, investigate-issue, or PR review** until that coercion is changed to a hard
error. This also settles the LM plan's open question at
`local-model-routing.md:197-199` — subagent and custom-agent tools are
*agentic-lite*, not auxiliary. They already run on the cheapest Anthropic tier;
leave them there.

Local models are additionally not viable *at all* until LM1 lands: the compat
shim sends no `options`/`num_ctx`/`keep_alive`, Ollama's OpenAI-compatible
endpoint has no way to set context size, and the default is 4k on sub-24 GiB
machines — so a 96 KB payload is silently truncated **from the front**, losing
the system prompt first.

### Ollama cost work generally

Billed at $0 (`pricing.rs` `is_local_model` → `ModelPricing::zero()`), and its
runtime does KV prefix reuse locally with no API surface. Out of scope. (Note
`is_local_model` matches on model-name prefixes — `llama`/`qwen`/`deepseek`/
`codellama` — so a local `gemma`/`mistral`/`phi`/`gpt-oss` is missed and a
*cloud* OpenRouter-hosted `qwen` is wrongly zeroed. Re-key on provider as part
of CE2.)

### Sidecar cache plumbing

The Claude Agent SDK's request assembly happens inside the downloaded native
`claude` binary; `cache_control` appears in **zero** of the shipped JS bundles
(`sdk.mjs`/`assistant.mjs`/`bridge.mjs`) and there is no cache knob in the
`Options` object. There is nothing to plumb. See SPIKE-2.

### Auxiliary task-class routing

Owned by [`local-model-routing.md`](./local-model-routing.md) (LM1–LM7). This
doc contributes only the prerequisites LM7 needs to prove its value: CE1/CE2
(a trustworthy rate table), CE18, CE19, and CE20. ~~CE5 (`task_class` on the
ledger)~~ is **CUT** (§0) — so the ~15 auxiliary call sites the routing work
targets stay unmeasured, and LM7 must either carry its own measurement or state
its saving as modelled rather than measured.

> **UPDATE 2026-07-31.** Five of those call sites moved anyway, for a compliance
> reason rather than a cost one: WI-1 of
> [`oauth-removal-plan.md`](./oauth-removal-plan.md) routed spec import, Code
> Quality explain/summarize, PR description, PR review, and Draft patch off
> subscription OAuth and onto the cheapest **configured API-key** provider via
> `core/aux_llm.rs` (LM3/LM5 in the routing plan). That changes this section's
> premise in two ways. **(1)** CE20 is superseded, not owed — see above.
> **(2)** LM7's original framing ("split local vs. metered spend in
> `CostDashboardView` so the saving is visible") targets a view that no longer
> exists, so LM7 must be re-specified against the guardrails or against a
> throwaway script over `usage.jsonl` — the CE3/CE4 pattern. The saving remains
> **modelled, not measured**; nothing here changed that.

---

## 5. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| **Cache writes cost MORE than plain input** — 1.25x (5m) / 2.0x (1h). A one-shot question or immediately-abandoned session becomes ~25% more expensive on input. | Our loop almost always runs multiple iterations, so this should net strongly positive — but **default to 5m TTL, never 1h**. 5m needs ~2 reads to break even; 1h needs ~3+. Cache reads refresh the TTL for free, so 5m survives an entire agent loop provided iterations are <5 min apart. Measure the one-shot population via CE6-PRE before considering 1h. |
| **Savings only materialise on active loops.** An idle session past the TTL pays a full write on its next turn. A user who asks one question, walks away for 20 minutes, and asks another pays two writes and gets one read. | Report hit rate (CE4) rather than assumed savings. If the measured one-shot/idle share is high, CE6's real-world benefit is materially below the modelled 60–80% — accept that finding rather than defending the estimate. |
| **Minimum cacheable prefix is model-dependent and fails SILENTLY.** 1,024 tokens (opus-4-8, sonnet-4-6), 2,048 (opus-4-7), 4,096 (opus-4-6, haiku-4-5). Our static prefix is ~2–5k tokens (researchers disagreed). Anthropic returns **no error** — you only find out by reading usage. | Acceptance test is per-model non-zero `cache_read_input_tokens`, not "it compiled". A message-level rolling breakpoint carries opus-4-6/haiku-4-5 because history exceeds 4,096 quickly; a tools-only breakpoint would be a silent no-op on a bare project. This is a direct argument for CE6 (automatic) over CE11 (explicit) as the first cut. |
| **Prefix drift is invisible.** `build_anthropic_messages` reconstructs JSON from Rust structs every call; any conditional that changes shape costs a full-price re-read with no error and no log. | Add a debug hash-of-serialised-prefix log line (part of CE6/CE7 verification) so drift is observable. Treat non-zero cache reads as the acceptance test, never assume. |
| **Enabling caching breaks the guardrails' view of cost** (restated because it is the highest-probability own-goal). Cache writes priced at $0.00 make budget caps under-trigger during thrash — the failure mode caching itself introduces. | **Mostly mitigated by CE2 (2026-07-31)**: both engines now bill cache read / 5m write / 1h write at published per-model rates. The *reporting* half of this risk evaporated with the dashboard (§0); the *control* half did not. CE3's remainder (sub-agent cache-write bucket) is still a hard prerequisite of CE6, enforced by dependency, not by discipline. |
| **The Codex fix will look like data loss.** Historical Codex totals drop ~half overnight. | Much reduced by the dashboard removal (§0) — no user sees a total halve. It still matters for any before/after capture and for guardrail caps tuned against the old inflated figures, so CE1 keeps its own commit and CHANGELOG note. |
| **Compaction and caching pull against each other.** Rewriting history invalidates the messages cache and forces one full-price re-read. | Design CE15 against the cache: threshold-driven, infrequent, rolling breakpoint placed *after* the compaction boundary. Never per-turn. |
| **Truncating tool results is not free.** Aggressive caps cause the model to re-run the command or re-read the file — costing more than the tokens saved, plus latency. | CE13 uses head+tail with an explicit elision marker, not a hard tail cut. CE12 gives a discoverable `offset` continuation affordance, without which the model fails rather than paginates. |
| **Quality regression from cheaper models.** `structured-extract` outputs feed strict parsers (`issues.rs:81-98` `strip_json_fences`, `src/lib/flightPlanning.ts`), so a model that emits prose around its JSON produces a user-visible failure, not graceful degradation. | Frontier-default, local opt-in — matching the LM plan's own leaning. **Fail loudly** when a cheap route is unavailable; silent escalation to a frontier model recreates the invisible-spend problem precisely when the user believes they are running free. |
| **Sidecar vs in-process split.** *What we know:* the SDK reports `cache_creation_input_tokens`/`cache_read_input_tokens` back (`sdk.d.ts:2383-2384`) and the sidecar forwards them (`anthropic.ts:801-813`); `cache_control` is absent from every shipped bundle; most sidecar sessions pass an **empty** system prompt (`api_agent.rs:906`), so the SDK's own preset and its own caching apply. *What we do not know:* whether hit rates are actually good, and there is a reported upstream gap that Agent SDK **subagents run with caching disabled**. | SPIKE-2. Until it resolves, assume the sidecar path is already cached and do **not** plumb `cache_control` through it. Do consider passing `systemPrompt` as a `string[]` with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` for the profile/memory sessions — the SDK docs say `excludeDynamicSections` "has no effect when systemPrompt is a string". |
| **Cross-provider `cache_control` is not portable.** OpenRouter proxies Anthropic and requires the *same* explicit `cache_control` (it does not auto-cache Anthropic/Gemini) — but we route OpenRouter through `llm_openai_compat.rs`, which uses the OpenAI chat-completions shape. MiniMax and Ollama must **not** receive it. | Gate every caching change on `config.provider_id`, never on a shared code path. This is a hard requirement of CE9. |
| **Concurrency: parallel flight attempts each pay a full write.** A cache entry only becomes available after the first response *begins*. Flight Deck launches N worktree attempts in parallel against the same prompt. | Accept for now; measure via CE17. If material, stagger attempt launch so attempt 1 starts streaming before the rest fire. |
| **Unknown models price at $0.00 rather than erroring** (`pricing.rs:222-224`). A model-id change silently zeroes a provider's cost and looks exactly like a spectacular caching win. | Make a nonzero-token/zero-cost row a loud warning during measurement runs, not just a `PricingStatus::Unknown` advisory. |
| ~~**The rate table is self-described as stale**~~ **Fixed by CE2**: `shared/model-pricing.json` records a per-vendor source URL, fetch date, and a `verified` flag, so an unverified row is visible rather than implied. The Anthropic rows are first-party as of 2026-07-31; OpenAI / Google / MiniMax / Meta rows are explicitly `verified: false`. | Still report savings primarily as a rate-independent token-mix ratio (cache-read share / hit rate); treat dollars as a derived illustration — and note the Claude 4.7+ tokenizer break (SPIKE-1) makes even token counts non-comparable across that model boundary. |
| **`usage.jsonl` is append-only and unversioned.** New fields (`task_class`, `run_id`, TTL) are absent on every historical line. | Any before/after comparison runs only over post-instrumentation data. Phase 0 must land at least one real usage period *ahead* of Phase 1, not in the same release. |
| **`analytics.rs` recomputes Codex cost from the LATEST model in each session file**, so a session that switched models mid-way prices its entire cumulative total at the last model's rates — figures are not stable across reloads. | ~~Fold into CE5~~ — CE5 is CUT (§0) and the vendor-file scrape stays a live primary source. **Accepted, unfixed.** It now only perturbs guardrail inputs, not a displayed total; revisit only if a cap is observed mis-firing because of it. |
| **The sidecar delta accounting re-baselines to zero whenever any cumulative component shrinks** (`handler.rs:571-618`), interpreting it as a process restart. A legitimate decrease (e.g. cache eviction reducing cumulative cached tokens) would re-count the whole session. | ~~Guard it in CE5~~ — CE5 is CUT (§0), but this path still feeds `flight:cost-updated` and therefore the **autonomy cost hard-stop**, so over-counting can stop a flight early. Guard it as part of CE6, when cache eviction first makes the decrease realistic. |
| **MCP tool lists are user-controlled.** Enabling/disabling servers mid-session resets the cache. | Expected behaviour, not a bug — but it makes measured hit rates noisy in MCP-heavy projects. Note it in CE4's instrumentation output so it is not misread. |

---

## 6. Spikes needed before committing

**SPIKE-1 — Anthropic pricing ground truth. ✅ RESOLVED 2026-07-31.**
Source: <https://platform.claude.com/docs/en/about-claude/pricing> (first-party,
fetched 2026-07-31). The `$5/$25` audit was correct; the shipped table was
carrying the deprecated Opus 4.1 rate on every current Opus row. Verified
figures, USD per MTok — base input / output, then cache write 5m / write 1h /
read:

| Model | Input | Output | Write 5m | Write 1h | Read |
| --- | --- | --- | --- | --- | --- |
| Claude Fable 5 | 10 | 50 | 12.50 | 20 | 1 |
| Claude Mythos 5 | 10 | 50 | 12.50 | 20 | 1 |
| Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 | **5** | **25** | 6.25 | 10 | 0.50 |
| Opus 4.1 (deprecated) / Opus 4 (retired) | 15 | 75 | 18.75 | 30 | 1.50 |
| Sonnet 5 — through 2026-08-31 | **2** | **10** | 2.50 | 4 | 0.20 |
| Sonnet 5 — from 2026-09-01 | **3** | **15** | 3.75 | 6 | 0.30 |
| Sonnet 4.6 / 4.5 / 4 | 3 | 15 | 3.75 | 6 | 0.30 |
| Haiku 4.5 | **1** | **5** | 1.25 | 2 | 0.10 |
| Haiku 3.5 (retired) | 0.80 | 4 | 1 | 1.60 | 0.08 |

Multipliers confirmed: cache read = 0.1x base input, 5-minute write = 1.25x,
1-hour write = 2x. Batch API is 50% off **input and output** and stacks with
caching (still not being built — see §4).

"Fable 5" and "Mythos 5" are genuine published models; the researcher who
doubted that fetch was wrong to. We pin neither, but both are now in the table
so a user typing one into a custom model field is priced rather than silently
zeroed.

**Two sub-questions remain open** (they did not block CE2 and are not blocking
anything else):
1. *OpenAI cache multipliers.* No first-party confirmation of the claimed 0.10x
   read / 1.25x write on GPT-5.6+. The shipped 0.50x / 1.0x values were carried
   over into `shared/model-pricing.json` marked `verified: false`. If the claim
   is right, our OpenAI cache-read cost is overstated 5x — worth confirming
   before CE9.
2. *Tokenizer change at Claude 4.7.* **Confirmed enough to act on, and it
   matters for every before/after in this doc.** Claude 4.7 and later use a
   different tokenizer that produces roughly **30% more tokens for the same
   text** than Sonnet 4.6 and earlier. Consequences: (a) any token comparison
   spanning that model boundary is measuring the tokenizer, not the change —
   pin the model for the whole comparison (CE6-PRE's fixture must); (b) a
   per-token rate cut across that boundary is partly given back in token count,
   so per-MTok rates are not directly comparable across it either; (c) prefix
   size estimates in this doc derived from ~4 B/token undercount on 4.7+.

*Was blocking:* CE2 rate rows — now unblocked and shipped.

**SPIKE-2 — Sidecar caching reality.**
Instrument one real `api-claude-oauth` session and read the
`cache_creation_input_tokens`/`cache_read_input_tokens` the SDK already reports
through `anthropic.ts:801-813`. Questions: (a) is the SDK actually achieving
high hit rates, or is it as uncached as our Rust path? (b) does the reported
subagent-caching-disabled gap reproduce, and do we lean on subagents enough for
it to matter? (c) does passing `systemPrompt` as `string[]` with
`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` measurably change cross-session reuse?
*Blocks:* any sidecar caching work, and the honesty of the OAuth-removal
comparison (we are about to compare a cached path against an uncached one).

**SPIKE-3 — Real workload distribution.**
Every savings figure in this doc is modelled from documented multipliers and
byte-count-derived token estimates (~4 B/token), not tokenizer output or
observed traffic. Log `input_tokens` per iteration from the existing
`StreamChunk::Done` path across one week of real use and answer: median and p90
iterations per turn; the one-shot/abandoned-turn share; actual prefix size per
model; the gap between turns (does 5m TTL survive real usage?); how often
attachments and MCP flaps occur.
*Blocks:* committing to CE11 and CE15 (the two expensive items). CE6, CE7, CE12,
CE13 are cheap enough to ship on the current evidence.

**SPIKE-4 — Minimum-cacheable-prefix per model.**
One request per Anthropic model in the catalog with `cache_control` set,
inspecting `usage` to confirm the breakpoint actually fired. Specifically test a
bare project (no CLAUDE.md, no MCP servers) on `claude-opus-4-6` and
`claude-haiku-4-5` — the 4,096-token-minimum cases where the failure is silent.
*Blocks:* claiming CE6 works "for all models". Can run as part of CE6's
verification rather than before it.

---

## Sequencing

**CE1 → ~~CE2~~ → CE3 → ~~CE4~~ → ~~CE5~~ → CE6-PRE → ~~CE6~~ → CE7 → CE8 →
~~CE9~~ → CE12 → CE13 → CE10 → ~~CE14~~ → CE16 → CE11 → CE15 → CE17 → CE18 →
CE19 → ~~CE20~~.**

**CE14 shipped early, ahead of CE7/CE8/CE12/CE13**, with the provider loop
(`422ab94`). Its only sequencing constraint was "land before CE8 freezes the
tools array", and that is satisfied — CE8 may now freeze the final shape. The
pull-forward was deliberate: CE6 cannot reduce **output** tokens at all, and
whole-file rewrites were the dominant output cost. **CE20 was superseded**, not
executed — the routing card was wired by WI-1 rather than retired.

**CE6 and CE9 shipped together, ahead of CE6-PRE, and CE4's instruments came
with them.** They share the provider layer, so splitting them would have meant
touching `llm_openai_compat.rs` twice. The consequence to be honest about:
without CE6-PRE's pinned workload there is no *replayable* before/after, so the
first real measurement will be longitudinal and therefore confounded by
workload drift. That is acceptable for the binary question CE6 actually has to
answer first — "did the breakpoint fire at all, per model?" — which the
per-iteration `CE6-CACHE` log line answers directly. It is **not** sufficient to
claim a percentage saving; do not quote one until CE6-PRE exists.

**CE2 shipped first, ahead of CE1.** The ordering assumed CE1's token-semantics
contract had to land before the tables could be collapsed; in practice the
collapse is independent of it. CE2 left the Rust call sites' superset/disjoint
handling exactly as it found it, so CE1's scope is unchanged apart from the
frontend `Math.max(0, input - cached)` line, which is already deleted. CE1 must
still be **its own commit with a CHANGELOG note** — historical Codex totals will
visibly halve when it lands.

Phase 0 (CE1–CE6-PRE) ships as its own release and must be live for at least one
real usage period before Phase 1. CE7 and CE12/CE13/CE16/CE18/CE19 are
independently useful and can be pulled forward at any time — none of them depend
on caching. (CE14 already was; CE20 is superseded.) CE11 and CE15 are the two items that should not start until SPIKE-3
says they are worth it.

~~The one ordering constraint that is not negotiable: **CE5 (self-owned ledger)
must land before subscription OAuth is removed from the API-agent surface**.~~
**DISSOLVED 2026-07-31 (§0).** That constraint existed solely because removing
subscription OAuth would freeze roughly half the *dashboard's* history with no
PacketADE-side replacement. The dashboard is gone and CE5 is cut, so there is no
history to freeze and no user-visible blind window. **OAuth removal is no longer
gated on any item in this plan.**

What is left of the original worry is smaller and worth naming, and it is now
**shipped state rather than a forecast** (`d8fb78e` for the auxiliary features,
`422ab94` for the provider rows): the vendor CLI files
(`~/.claude/cost-tally.json`, `~/.codex/sessions`) stop accruing from
PacketADE's API surface, so the **guardrails** see less spend from those paths —
but the migrated traffic lands on `api-claude` / `api-openai` / the Agent SDK
row, which *do* write `~/.packetade/usage.jsonl`, so coverage moved rather than
disappeared. Those files keep accruing from PTY CLI panes, which still use
subscription logins deliberately. See
[`oauth-removal-plan.md`](./oauth-removal-plan.md).

**One thing that did change the guardrails materially, and it is not in the
list above:** the stored ledger was repriced (`core/reprice.rs`, `d8fb78e`).
`usage.jsonl` feeds `assertCostGuardrailsAllowLaunch`, and every pre-CE2 record
was priced with deprecated Opus 4.1 / retired Haiku 3.5 rates — **$158.88 →
$52.96** on the real ledger. Caps were tripping at roughly a third of the spend
actually authorized. Repricing recomputes from stored **token counts**, never by
scaling dollars, at each record's **own** date, backs up first, marks rows with
`repricedAt` / `costUsdBefore`, and is guarded against double-application.
Flight rollups were deliberately **not** repriced — they store a collapsed token
sum with no input/output split, so recomputing would mean inventing a ratio, and
`save_flights` merges with `max()` anyway. Filed **P3**: they still carry the
old rates, so a flight-scoped `maxTotalCost` remains overstated.
