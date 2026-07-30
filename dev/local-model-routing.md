# Local Model Routing (Ollama-first)

Status: **PLANNED — not started**
Created: 2026-07-30
Owner decision recorded: 2026-07-30

## Decision record

The prompt behind this doc was: *should PacketADE build a Cursor-style
hosted-model stack (API gateway + our own inference + our own trained model),
or invest in local models instead?*

Three separable layers were considered:

| Layer | Description | Verdict |
| --- | --- | --- |
| **A. API gateway** | Auth, routing, key custody, billing in front of someone else's inference | **OUT** — commodity; makes us a worse OpenRouter and puts us in the uptime/billing/abuse path for no differentiation |
| **B. Own inference hosting** | vLLM/SGLang/llama.cpp on owned or rented GPUs | **OUT as a product.** Available for free as a *config* via layer A of this plan (a custom OpenAI-compatible base URL) |
| **C. Own trained model** | RL/fine-tune against our own harness traces (Cursor's actual moat) | **OUT** — revisit only if a large corpus of PacketADE harness traces with outcome labels ever accumulates |

**Chosen direction:** neither "be Cursor" nor "run the main coding agent
locally". Instead: **per-task-class routing.** PacketADE makes ~15 distinct
auxiliary LLM calls across the product (commit messages, issue triage, PR
descriptions, code-quality explanations, memory ops, spec parsing, side chat).
These are short-context, single-shot, structured-output tasks that a 7–14B
local model handles fine. The agentic coding loop stays on frontier models.

The differentiator is *"PacketADE spends real money only on the hard agentic
turns and runs the other twenty calls an hour on your own hardware"* — offline,
zero marginal cost, no data egress. No competitor in `dev/competitors.md` does
per-task-class routing.

Running the *main* agentic loop on a local model remains out of scope. Long
tool loops with MCP, subagents, and worktree attempts punish small models
exactly where they are weakest.

## Audit: how auxiliary surfaces currently reach a model

Performed 2026-07-30 against `src-tauri/src`. **This audit invalidated the
initial scoping assumption** that routing was a one-argument change to
`get_provider`. There are three independent mechanisms, and only one of them
passes through that seam.

### Mechanism 1 — in-process `LlmProvider`

Dispatch: `core/llm_provider.rs:35` `get_provider(name)`.
Credential: OS keyring `api-key-{provider}`.

| Call site | Surface | Provider / model |
| --- | --- | --- |
| `commands/api_agent.rs:1697,1793` | User conversation tiles | **dynamic** — session-selected |
| `commands/side_chat.rs:19-20,105` | Side Chat | `anthropic` / `claude-haiku-4-5` |
| `commands/github.rs:2193-94,2564,2761` | GitHub catch-up (2 sites) | `anthropic` / `claude-haiku-4-5` |
| `core/tool_subagent.rs:18,266` | Subagent tool | `anthropic` / `claude-haiku-4-5` |
| `core/tool_custom_agent.rs:15,151` | Custom-agent tool | `anthropic` / `claude-haiku-4-5` |

`api_agent.rs` is already fully routable. The other four are hardcoded.

### Mechanism 2 — sidecar one-shot

Dispatch: `SidecarManager::forward_start(...)` with a `claude-oauth` provider
string. **Never touches `get_provider`.**
Credential: `~/.claude/.credentials.json` OAuth (Claude Pro/Max subscription).

| Call site | Surface | Provider / model |
| --- | --- | --- |
| `commands/code_quality.rs:484-85` | Explain error, summarize | `claude-oauth` / `claude-sonnet-4-6` |
| `commands/github.rs:1601-02` | PR description, PR review | `claude-oauth` / `claude-sonnet-4-6` |
| `commands/issues.rs:75,79` | Spec import | `claude-oauth` / `claude-sonnet-4-6` |

These deliberately draw on the subscription rather than metered API credit.
Any routing design must preserve that as an option, not silently move these
onto a metered key.

### Mechanism 3 — Claude CLI shell-out

Dispatch: `claude/binary.rs::run_claude` (`claude -p --output-format text`),
or `claude_command()` directly for streaming. **No provider abstraction at
all** — a hard runtime dependency on the `claude` binary being on `PATH`.

| Call site | Surface |
| --- | --- |
| `commands/memory.rs:11,28,43,106` | Four memory operations |
| `commands/insights.rs:72-93` | Agent chat stream (streaming variant) |
| `commands/spec.rs:4,54` | Parse spec → flight, parse spec → tickets |
| `commands/github.rs:1577` | Investigate issue |

This is the weakest tier: no streaming for `run_claude`, no token accounting,
no cost attribution, and it silently fails on machines without the CLI. These
sites are also the *easiest* to migrate — they are pure text-in/text-out.

### Summary

~15 auxiliary call sites. **4 sit behind `get_provider`; 11 do not.**
Task-tier routing therefore requires a unifying auxiliary entry point first —
it is not a signature change.

## Known defects blocking local-model viability

1. **No `num_ctx`.** `core/llm_openai_compat.rs::stream_chat_compat` sends only
   `messages` / `max_tokens` / `stream`. Ollama's OpenAI-compatible endpoint
   defaults to a small context (historically 4096, model-dependent) and
   **silently truncates the front of the conversation** rather than erroring.
   This presents as "the local model forgets the system prompt" or "loops on
   tools" and is almost certainly a config fault, not a model-quality one.
   `contextWindow` in `src/lib/api-models.ts:13,163` is display metadata only
   and is never sent.
2. **No `keep_alive`.** Every call risks a multi-second model reload.
3. **No tool-capability detection.** Many Ollama models ship without a tools
   template. The picker currently allows selecting one for an agent tile, which
   fails at the first tool call. `/api/show` reports capability.

Fixing (1) and (2) requires Ollama's native `/api/chat` route or an `options`
passthrough; neither fits the OpenAI-compat shim, so `core/llm_ollama.rs`
(currently a 40-line passthrough) grows a real second code path.

## Phased plan

### LM1 — Ollama fundamentals

Native `/api/chat` path in `core/llm_ollama.rs` with `num_ctx` and
`keep_alive`; per-model tool-capability probe via `/api/show` surfaced through
`commands/ollama.rs`; picker gating for non-tool models; a visible warning when
a request would exceed the negotiated context rather than silent truncation.

**Do this first.** Everything downstream is worthless if local inference
silently truncates.

### LM2 — Custom OpenAI-compatible endpoint

New provider row + `CustomCompatProvider` wrapping `stream_chat_compat` with a
user-supplied `base_url`, optional keyring key, and manual model list. Touches
`core/llm_provider.rs` dispatch, a new provider file, `src/lib/api-models.ts`,
the `AgentCli` union in `src/stores/agentTaskStore.ts`, and the auth-status
probe.

One row covers vLLM, LM Studio, LiteLLM, Together, Fireworks, an SSH-tunnelled
box, and any future endpoint — including a self-hosted gateway, which is how
layer B above stays available without being built as a product.

### LM3 — Unified auxiliary LLM entry point

New `core/aux_llm.rs` exposing something like
`run_aux(task_class, prompt, opts) -> stream`, which internally selects
mechanism (in-process / sidecar), provider, and model from settings.
`TaskClass` enumerates the auxiliary surfaces (commit message, PR description,
code-quality explanation, memory op, spec parse, side chat, catch-up,
subagent).

This is the load-bearing phase. It is what the initial scoping missed.

### LM4 — Migrate mechanism-3 sites

Move `memory.rs`, `insights.rs`, `spec.rs`, and `github.rs:1577` off
`run_claude` onto `aux_llm`. Removes the hard `claude`-on-PATH dependency and
brings four surfaces into token accounting for the first time. Easiest
migration; do before LM5.

### LM5 — Migrate mechanism-2 sites

Move `code_quality.rs`, `github.rs` PR commands, and `issues.rs` spec import
onto `aux_llm`, with the sidecar `claude-oauth` path retained as a selectable
route so subscription-funded operation stays the default.

### LM6 — Routing settings

New `modelRoutingStore` plus a persisted settings slice mapping task class →
provider/model, with a frontier default. **Not** `orchestrationSettingsStore`,
which is flight/worktree-scoped (auto-commit trailers, autonomy policy) and
hydrates from `OrchestratorSettings` in Rust. Settings UI under the existing
six-group IA.

### LM7 — Cost surfacing and gates

Split local vs. metered spend in `CostDashboardView` so the saving is visible
and quantified — this is the feature's proof. Note that
`src/lib/api-models.ts:159` already has a zero-rate guard for Ollama/free
models. Plus the usual local/SSH/packaged gates.

## Sequencing

**LM1 → LM2 → LM3 → LM4 → LM5 → LM6 → LM7.**

LM1 proves local inference is viable at all; LM2 generalises the endpoint;
LM3 builds the seam that LM4/LM5 migrate onto; LM6 exposes the choice; LM7
proves the value.

LM1 and LM2 are independently shippable and useful on their own. LM3 onward is
the differentiated feature and should not start until LM1 has demonstrated a
local model completing a real auxiliary task correctly.

## Open questions

- Which task classes get a local default out of the box, versus frontier-by-
  default with local opt-in? Leaning frontier-default to avoid a quality
  regression on first run.
- Do subagent and custom-agent tools (`core/tool_subagent.rs`,
  `core/tool_custom_agent.rs`) count as auxiliary or agentic? They are
  currently Haiku, which suggests auxiliary, but they run tool loops.
- Fallback policy when the local endpoint is down mid-task: fail, or silently
  escalate to the frontier route? Silent escalation has a cost-surprise
  failure mode.
