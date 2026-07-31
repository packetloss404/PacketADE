# Cost Efficiency Loop (caching + context discipline)

Status: **PLANNED — not started**
Created: 2026-07-30
Research basis: five independent source audits (prompt caching, context
discipline, task-class routing, batch APIs, cost measurement), 2026-07-30.

Related: [`local-model-routing.md`](./local-model-routing.md) (LM1–LM7 — the
auxiliary-surface routing plan this doc deliberately does **not** duplicate).

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
| **Zero prompt caching on the in-process Anthropic path.** `cache_control` appears in **no** file under `src-tauri/src`, `src`, or `agent-sidecar/src`. The request body is `model`/`messages`/`max_tokens`/`stream` + optional `system` (bare string) / `tools` / `temperature` / `thinking`. | `core/llm_anthropic.rs:153-174`; repo-wide grep returns nothing |
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

1. **Two disagreeing cost engines.** Rust `pricing.rs` (four token buckets,
   per-vendor cache multipliers) is registered as `calculate_turn_cost`
   (`lib.rs:507`) and **the frontend never calls it** — grep for
   `calculate_turn_cost` in `src/` finds only a comment. Everything the user
   sees comes from `src/lib/conversationCost.ts`, which carries its own
   input/output-only table plus one provider-agnostic
   `CACHED_INPUT_RATE_RATIO = 0.25`. The two tables already disagree on three
   shipped models (haiku 25%, gemini-2.5-pro 2x, llama-4-maverick 2x).
2. **Codex cached tokens are double-counted.** `analytics.rs:217-223` and
   `agent_sidecar/handler.rs:627-633` pass `input` **and** `cached` as separate
   arguments into `calculate_cost`, which is purely additive
   (`pricing.rs:227-230`). OpenAI's `cached_tokens` is a *subset* of prompt
   tokens. At a 90% hit rate that is a **2.6x overstatement**. Codex routinely
   runs 90%+ hit rates, so this is the normal case.
3. **The frontend estimator has no cache-write term at all.**
   `estimateTurnCostUsd` takes `{inputTokens, outputTokens, cacheReadTokens,
   reasoningTokens}` — no `cacheWriteTokens` — and `aggregateConversationCost`
   never reads `m.cacheWriteTokens` even though the listener stores it
   (`apiAgentListeners.ts:346`, `:703`). Cache creation is the *most* expensive
   token class (1.25x–2x input).
4. **Two contradictory definitions of `inputTokens` in the same codebase.**
   `conversationCost.ts:109` does `Math.max(0, input - cached)` (assumes input
   *includes* cached); `modelContext.ts:91-105` documents the opposite and adds
   them. Neither branches on provider. Each is right for one vendor and wrong
   for the other.
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
   no cache fields; the dashboard has no cache column and no hit-rate anywhere.
8. **The dashboard's "today" number double-counts in-process turns.**
   `todayCostUsd = todayPersisted + liveSummary.costUsd`, where `liveSummary`
   iterates every `mode === "api"` conversation in a *persisted* store — i.e.
   including conversations from previous app runs already in `usage.jsonl`
   (`CostDashboardView.tsx:537-551`). This number feeds the guardrails.

**Where the researchers disagreed — stated, not papered over:**

- **Anthropic per-MTok rates.** `pricing.rs:106-120` prices opus-4-6/4-7/4-8 at
  `$15/$75` and haiku-4-5 at `$0.80/$4.00`. One researcher asserted the
  published table is `$5/$25` for all three Opus rows and `$1/$5` for Haiku
  (a 3x over-price and a ~20% under-price respectively); others modelled
  savings using `$15/M` for Opus without challenging it. A fourth noted the
  Anthropic pricing page they fetched listed model names ("Fable 5", "Mythos 5")
  that correspond to **nothing PacketADE pins**, which undermines confidence in
  that fetch. **Unresolved. Blocks CE2 — see SPIKE-1.**
- **Prefix size.** Estimates for the static tools+system prefix ranged from
  ~2–3k tokens to ~5k tokens. Both are byte-count-derived (~4 B/token), not
  tokenizer output. This matters only for the minimum-cacheable-length question
  on `claude-opus-4-6` / `claude-haiku-4-5` (4,096-token minimum).
- **Cache multipliers in `pricing.rs`.** All researchers agree
  `ModelPricing::anthropic` (0.10x read / 1.25x write) is correct *for the
  5-minute TTL*; there is no TTL dimension in the type. Agreement that
  `ModelPricing::openai` (0.50x / 1.0x) is stale versus a documented 0.10x read
  and 1.25x write on GPT-5.6+.
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
> The moment CE6 ships, `cache_creation_input_tokens` becomes non-zero. The
> frontend estimator has no write term, so the *most expensive* token class
> renders as **$0.00** in the message pill, the sidebar pill, the dashboard
> live-spend figure, and the daily/session/flight guardrails — which would
> therefore under-trigger precisely during cache thrash, the failure mode
> caching introduces. Simultaneously `CACHED_INPUT_RATE_RATIO = 0.25` would
> overstate Anthropic cache reads by 2.5x, hiding the real saving. **CE3 is a
> hard prerequisite of CE6, not a follow-up.**

### Phase 0 — Make the meter honest (no behaviour change)

#### CE1 — Token-semantics contract + Codex cached-token double-count fix
- **Changes:** Add `input_includes_cache: bool` to `ModelPricing` and branch
  inside `calculate_cost`, so the subset-vs-disjoint distinction lives with the
  vendor rather than at three call sites. Normalise all OpenAI-family payloads
  to the disjoint model at the edge. Delete `Math.max(0, input - cached)` from
  `conversationCost.ts` and make `modelContext.ts` occupancy provider-correct.
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

#### CE2 — Collapse to ONE rate table
- **Changes:** Delete `COST_PER_MTOK` from `conversationCost.ts`. Add a
  `get_model_pricing_table` command returning full `ModelPricing` (all four
  rates); hydrate once at app start. Keep the local per-message math (no
  per-message IPC — that design is right) but source rates from Rust, including
  per-provider cache read/write rates in place of the single 0.25 constant.
  Correct `ModelPricing::openai` to 0.10x read / 1.25x write. Correct the
  Anthropic per-MTok rows **only after SPIKE-1 resolves**.
- **Files:** `src/lib/conversationCost.ts`, `src/lib/api-models.ts`,
  `src-tauri/src/commands/pricing.rs`, `src-tauri/src/lib.rs`,
  `src/lib/tauri.ts`
- **Effort:** medium
- **Expected saving:** $0 — correctness. Removes a 2.5x post-caching error and
  three live rate divergences.
- **Verify:** TS test asserting `estimateTurnCostUsd` agrees with
  `calculate_turn_cost` within tolerance for the same inputs.
- **Depends on:** SPIKE-1 (**blocking** for the Anthropic rate rows only; the
  table-collapse itself can proceed).

#### CE3 — Cache-write term in the frontend estimator + live/persisted de-dup
- **Changes:** `cacheWriteTokens` parameter on `estimateTurnCostUsd`;
  `totalCacheWrite` accumulator in `aggregateConversationCost`; pass
  `cache_creation_input_tokens` at both listener call sites; add the field to
  the `agentStreamingStore` sub-agent bucket. Scope `liveSummary` to
  conversations with an in-flight turn so it stops re-adding turns already in
  `usage.jsonl`.
- **Files:** `src/lib/conversationCost.ts`, `src/stores/apiAgentListeners.ts`,
  `src/stores/agentStreamingStore.ts`,
  `src/components/views/CostDashboardView.tsx`
- **Effort:** small
- **Expected saving:** $0 — but without it CE6 makes the UI actively wrong.
- **Verify:** synthetic turn with known cache-write tokens shows non-zero cost;
  guardrail fires at the right threshold.
- **Depends on:** CE1, CE2. **Blocks CE6.**

#### CE4 — Surface cache tokens end-to-end (the proof artifact)
- **Changes:** Add `cache_read_tokens`/`cache_write_tokens` to `ModelUsage` and
  `AnalyticsData`; populate from the `usage.jsonl` ingest loop (which already
  deserialises and discards them) and the Codex scrape; mirror in
  `analyticsStore`; add three columns to the model table and a headline
  **cache hit rate** tile = `cache_read / (input + cache_read + cache_write)`.
- **Files:** `src-tauri/src/commands/analytics.rs`,
  `src/stores/analyticsStore.ts`,
  `src/components/views/CostDashboardView.tsx`
- **Effort:** small
- **Expected saving:** $0 — this is *the* before/after artifact. Report hit
  rate alongside dollars: the ratio is rate-independent and therefore survives
  the stale-pricing-table problem entirely.
- **Verify:** tile reads ~0% today (correct — caching is off) and jumps after CE6.
- **Depends on:** CE1.

#### CE5 — Self-owned ledger from every path, with attribution
- **Changes:** Call `append_usage_entry` from the sidecar `turn_summary`/`done`
  handler using the deltas it already computes, and from the auxiliary call
  sites. Extend `UsageEntry` with `task_class: Option<String>` and
  `run_id: Option<String>` (serde-default so old lines parse). Actually populate
  `agent_id`. Demote `~/.codex/sessions` and `~/.claude/cost-tally.json` to a
  one-time historical import rather than a live primary source; drop the
  `stats-cache.json` max() override.
- **Files:** `src-tauri/src/commands/usage.rs`,
  `src-tauri/src/commands/agent_sidecar/handler.rs`,
  `src-tauri/src/commands/api_agent.rs`, `src-tauri/src/commands/side_chat.rs`,
  `src-tauri/src/core/tool_subagent.rs`,
  `src-tauri/src/core/tool_custom_agent.rs`,
  `src-tauri/src/commands/analytics.rs`
- **Effort:** medium
- **Expected saving:** $0 — coverage. **This is the item most tightly coupled
  to the OAuth decision:** if subscription OAuth is removed before this lands,
  the vendor CLI files stop accruing and roughly half the dashboard's history
  freezes with no PacketADE-side replacement, creating a blind window across
  exactly the transition we want to measure. **Ledger first, OAuth removal
  second is the only safe order.**
- **Depends on:** CE1.

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
- **Depends on:** CE5 (`run_id`).

### Phase 1 — Caching (the win)

#### CE6 — Anthropic automatic cache breakpoint (one line)
- **Changes:** `body["cache_control"] = json!({"type": "ephemeral"})` in the
  Anthropic request body. This is Anthropic's documented automatic-breakpoint
  mode: the API places the breakpoint on the last cacheable block and advances
  it as the conversation grows. `system` may stay a bare string. **Use the
  default 5-minute TTL — do not default to 1h** (see risks).
- **Files:** `src-tauri/src/core/llm_anthropic.rs`
- **Effort:** small
- **Expected saving:** modelled 60–80% input reduction on multi-iteration
  turns; ~0% (and ~25% *worse* on input) for one-shot abandoned turns. Worked
  example from the audit: 20 iterations, ~5k stable prefix, ~3k/iteration
  growth → ~670k billed input tokens today, of which the ~570k quadratic term
  becomes 0.1x reads.
- **Verify:** `cache_read_input_tokens` is already parsed end-to-end
  (`llm_anthropic.rs:260-267`, `:371-378` → `llm_types.rs:121-130` →
  `api_agent.rs:1861-1867` → `pricing.rs:229`) and reads 0 today. Acceptance =
  the CE4 hit-rate tile goes non-zero and stays high across the CE6-PRE
  benchmark, **per model** — a silent no-op is the documented failure mode on
  short prefixes.
- **Depends on:** CE3 (hard), CE4 (to see the result), CE7 (for
  attachment-bearing sessions to benefit at all).

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

#### CE9 — OpenAI-compat: parse `cached_tokens`, send `prompt_cache_key`
- **Changes:** Parse `usage.prompt_tokens_details.cached_tokens` in the
  streaming loop and report as `cache_read` instead of the hardcoded `0` at
  `llm_openai_compat.rs:451-452`/`:537-538`. Subtract from `prompt_tokens`
  before reporting `input_tokens` (per the CE1 contract). Send a stable
  per-session `prompt_cache_key` **on the OpenAI provider only**.
- **Files:** `src-tauri/src/core/llm_openai_compat.rs`
- **Effort:** small
- **Expected saving:** no new savings — OpenAI/MiniMax/OpenRouter already cache
  automatically with no client opt-in. This makes existing savings **visible**
  and stops over-reporting cached input at full rate.
- **Depends on:** CE1, CE2. **Per-provider gating is mandatory** — see risks.

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

#### CE14 — Targeted edit tool
- **Changes:** Add an `old_string`/`new_string` (or unified-diff apply) tool
  alongside `write_file`; demote `write_file` to new-file creation in the
  system prompt.
- **Files:** `src-tauri/src/core/tool_runtime.rs`,
  `src-tauri/src/core/tool_runtime_ssh.rs`,
  `src-tauri/src/core/llm_system_prompt.rs`,
  `src-tauri/src/commands/api_agent.rs`
- **Effort:** medium
- **Expected saving:** plausibly 5–10x on **output** spend for editing work
  (output is billed at ~5x input). A 2,000-line file edit is ~25k output tokens
  today vs ~500 for a diff, plus ~25k of permanent extra input per iteration.
  Note this changes the tools array — land it before CE8 freezes anything, or
  accept a one-session invalidation.
- **Depends on:** sequence relative to CE8.

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

#### CE20 — Retire the routing placebo
- **Changes:** `resolveForTask` has **zero production callers** — the only
  references are two Vitest mocks. `ProviderRoutingCard` writes to
  `packetade:routing` localStorage that nothing reads. Delete it, or disable the
  controls with an explicit "not yet wired" state. Do not leave it silently inert.
- **Files:** `src/stores/routingStore.ts`,
  `src/components/views/tools/ProviderRoutingCard.tsx`,
  `src/components/views/ToolsView.tsx`, `src/types/routing.ts`
- **Effort:** small
- **Expected saving:** $0 — trust. Its shape (keyed on the flight-worktree
  `TaskType` union, defaulting to the PTY id `"claude-code"`) cannot express
  auxiliary routing, so it is not a foundation for LM6; it is dead weight that
  will be mistaken for one.
- **Depends on:** none. Coordinate with LM6.

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
(a trustworthy rate table), CE5 (`task_class` on the ledger — without it the ~15
auxiliary calls the routing work targets are unmeasured and its headline claim
cannot be substantiated), CE18, CE19, and CE20.

---

## 5. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| **Cache writes cost MORE than plain input** — 1.25x (5m) / 2.0x (1h). A one-shot question or immediately-abandoned session becomes ~25% more expensive on input. | Our loop almost always runs multiple iterations, so this should net strongly positive — but **default to 5m TTL, never 1h**. 5m needs ~2 reads to break even; 1h needs ~3+. Cache reads refresh the TTL for free, so 5m survives an entire agent loop provided iterations are <5 min apart. Measure the one-shot population via CE6-PRE before considering 1h. |
| **Savings only materialise on active loops.** An idle session past the TTL pays a full write on its next turn. A user who asks one question, walks away for 20 minutes, and asks another pays two writes and gets one read. | Report hit rate (CE4) rather than assumed savings. If the measured one-shot/idle share is high, CE6's real-world benefit is materially below the modelled 60–80% — accept that finding rather than defending the estimate. |
| **Minimum cacheable prefix is model-dependent and fails SILENTLY.** 1,024 tokens (opus-4-8, sonnet-4-6), 2,048 (opus-4-7), 4,096 (opus-4-6, haiku-4-5). Our static prefix is ~2–5k tokens (researchers disagreed). Anthropic returns **no error** — you only find out by reading usage. | Acceptance test is per-model non-zero `cache_read_input_tokens`, not "it compiled". A message-level rolling breakpoint carries opus-4-6/haiku-4-5 because history exceeds 4,096 quickly; a tools-only breakpoint would be a silent no-op on a bare project. This is a direct argument for CE6 (automatic) over CE11 (explicit) as the first cut. |
| **Prefix drift is invisible.** `build_anthropic_messages` reconstructs JSON from Rust structs every call; any conditional that changes shape costs a full-price re-read with no error and no log. | Add a debug hash-of-serialised-prefix log line (part of CE6/CE7 verification) so drift is observable. Treat non-zero cache reads as the acceptance test, never assume. |
| **Enabling caching breaks current cost reporting** (restated because it is the highest-probability own-goal). Cache writes render as $0.00 everywhere; guardrails under-trigger during thrash; the 0.25 read ratio hides 2.5x of the Anthropic saving. | CE3 is a hard prerequisite of CE6, enforced by dependency, not by discipline. |
| **The Codex fix will look like data loss.** Historical dashboard totals drop ~half on Codex rows overnight. | Its own commit, its own CHANGELOG entry, and a before/after capture on identical data. Otherwise it contaminates the very measurement it enables. |
| **Compaction and caching pull against each other.** Rewriting history invalidates the messages cache and forces one full-price re-read. | Design CE15 against the cache: threshold-driven, infrequent, rolling breakpoint placed *after* the compaction boundary. Never per-turn. |
| **Truncating tool results is not free.** Aggressive caps cause the model to re-run the command or re-read the file — costing more than the tokens saved, plus latency. | CE13 uses head+tail with an explicit elision marker, not a hard tail cut. CE12 gives a discoverable `offset` continuation affordance, without which the model fails rather than paginates. |
| **Quality regression from cheaper models.** `structured-extract` outputs feed strict parsers (`issues.rs:81-98` `strip_json_fences`, `src/lib/flightPlanning.ts`), so a model that emits prose around its JSON produces a user-visible failure, not graceful degradation. | Frontier-default, local opt-in — matching the LM plan's own leaning. **Fail loudly** when a cheap route is unavailable; silent escalation to a frontier model recreates the invisible-spend problem precisely when the user believes they are running free. |
| **Sidecar vs in-process split.** *What we know:* the SDK reports `cache_creation_input_tokens`/`cache_read_input_tokens` back (`sdk.d.ts:2383-2384`) and the sidecar forwards them (`anthropic.ts:801-813`); `cache_control` is absent from every shipped bundle; most sidecar sessions pass an **empty** system prompt (`api_agent.rs:906`), so the SDK's own preset and its own caching apply. *What we do not know:* whether hit rates are actually good, and there is a reported upstream gap that Agent SDK **subagents run with caching disabled**. | SPIKE-2. Until it resolves, assume the sidecar path is already cached and do **not** plumb `cache_control` through it. Do consider passing `systemPrompt` as a `string[]` with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` for the profile/memory sessions — the SDK docs say `excludeDynamicSections` "has no effect when systemPrompt is a string". |
| **Cross-provider `cache_control` is not portable.** OpenRouter proxies Anthropic and requires the *same* explicit `cache_control` (it does not auto-cache Anthropic/Gemini) — but we route OpenRouter through `llm_openai_compat.rs`, which uses the OpenAI chat-completions shape. MiniMax and Ollama must **not** receive it. | Gate every caching change on `config.provider_id`, never on a shared code path. This is a hard requirement of CE9. |
| **Concurrency: parallel flight attempts each pay a full write.** A cache entry only becomes available after the first response *begins*. Flight Deck launches N worktree attempts in parallel against the same prompt. | Accept for now; measure via CE17. If material, stagger attempt launch so attempt 1 starts streaming before the rest fire. |
| **Unknown models price at $0.00 rather than erroring** (`pricing.rs:222-224`). A model-id change silently zeroes a provider's cost and looks exactly like a spectacular caching win. | Make a nonzero-token/zero-cost row a loud warning during measurement runs, not just a `PricingStatus::Unknown` advisory. |
| **The rate table is self-described as stale** ("approximate published values as of April 2026") while carrying newer entries. Every absolute-dollar claim inherits that. | Report savings primarily as a rate-independent token-mix ratio (cache-read share / hit rate); treat dollars as a derived illustration. |
| **`usage.jsonl` is append-only and unversioned.** New fields (`task_class`, `run_id`, TTL) are absent on every historical line. | Any before/after comparison runs only over post-instrumentation data. Phase 0 must land at least one real usage period *ahead* of Phase 1, not in the same release. |
| **`analytics.rs` recomputes Codex cost from the LATEST model in each session file**, so a session that switched models mid-way prices its entire cumulative total at the last model's rates — figures are not stable across dashboard loads. | Fold into CE5 when demoting the vendor-file scrape to a one-time import. |
| **The sidecar delta accounting re-baselines to zero whenever any cumulative component shrinks** (`handler.rs:571-618`), interpreting it as a process restart. A legitimate decrease (e.g. cache eviction reducing cumulative cached tokens) would re-count the whole session. | Add a guard before this path becomes the primary ledger writer in CE5. |
| **MCP tool lists are user-controlled.** Enabling/disabling servers mid-session resets the cache. | Expected behaviour, not a bug — but it makes measured hit rates noisy in MCP-heavy projects. Note it on the CE4 tile so it is not misread. |

---

## 6. Spikes needed before committing

**SPIKE-1 — Anthropic pricing ground truth. BLOCKING for CE2.**
The researchers disagreed and the one live fetch was untrustworthy. `pricing.rs`
prices opus-4-6/4-7/4-8 at `$15/$75` and haiku-4-5 at `$0.80/$4.00`; one audit
asserted `$5/$25` and `$1/$5` respectively; another observed the fetched pricing
page listed model names corresponding to nothing we pin. Resolve against a
first-party source (or an actual invoice) before touching the rate rows. A 3x
error on Opus inverts the signal that the entire programme is judged on. Also
confirm the current OpenAI cache multipliers (0.10x read, 1.25x write on
GPT-5.6+) and whether newer tokenizers really produce ~30% more tokens for the
same text — if so, every ROI model built on Sonnet-4.6-era counts understates
frontier cost.
*Blocks:* CE2 rate rows. Does not block CE1, CE3, CE4.

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

**CE1 → CE2 → CE3 → CE4 → CE5 → CE6-PRE → CE6 → CE7 → CE8 → CE9 → CE12 → CE13
→ CE10 → CE14 → CE16 → CE11 → CE15 → CE17 → CE18 → CE19 → CE20.**

Phase 0 (CE1–CE6-PRE) ships as its own release and must be live for at least one
real usage period before Phase 1. CE7 and CE12/CE13/CE16/CE18/CE19/CE20 are
independently useful and can be pulled forward at any time — none of them depend
on caching. CE11 and CE15 are the two items that should not start until SPIKE-3
says they are worth it.

The one ordering constraint that is not negotiable: **CE5 (self-owned ledger)
must land before subscription OAuth is removed from the API-agent surface**, or
roughly half the dashboard's history freezes with no PacketADE-side replacement
across exactly the transition being measured.
