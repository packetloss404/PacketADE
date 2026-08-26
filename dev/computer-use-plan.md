# Computer Use — Design and Phasing Plan

Status: **PAUSED by owner decision 2026-08-16** (same day it was designed).
Read-only research + owner decisions are complete; no implementation has begun
and none is scheduled. §8 is the pause record and pickup runbook — read it
first when resuming. This document remains the canonical design; item-level
scheduling lives in [`../backlog.md`](../backlog.md).

## 1. What this feature is

Agent-driven screen interaction for API-agent conversations: the agent takes
screenshots and issues mouse/keyboard actions, in a tool loop, to test and
operate UIs. Two tiers, shipped in this order:

1. **Browser tier (v1):** a dedicated Chromium instance driven over CDP,
   pointed at the user's dev server. Zero OS permissions, safest, and matches
   the ADE's core "test my web app" workflow.
2. **Desktop tier (v2):** full-desktop control of the local machine using
   Anthropic's native computer-use tool, with a frontmost-app guardrail and a
   kill switch.

## 2. Owner decisions (settled 2026-08-16)

| Decision | Choice |
| --- | --- |
| V1 scope | Both tiers, **browser (CDP) first**; desktop second on the same scaffolding |
| Backend | **In-process Rust** (`LlmProvider` path). Native `computer_20251124` passthrough for Anthropic providers at the desktop tier; plain JSON-schema tools for other providers. Not the sidecar. |
| Safety model v1 | **Approval-gated + kill switch**: blocking approval tier per action, Syndicate-pattern opt-in, frozen per-session grant, abort on physical mouse movement. Per-app grants/action tiers deferred to a later phase. |
| Platforms v1 | **Windows only.** macOS and Linux follow after the shape is proven. |

Do not re-litigate these without a new owner decision.

### Why not the sidecar first

The Claude Agent SDK has **no native computer-use tool**. That path requires
hand-rolled MCP tools (`createSdkMcpServer`), forfeits Anthropic's trained
computer-use behavior and the prompt-injection classifier that runs on
computer-use requests, works for only one provider row, and still needs a
sidecar protocol bump for image-bearing tool results. The Rust path is more
work up front but is the durable home. Sidecar support is Phase 3.

## 3. External facts the design depends on

- **Anthropic tool:** `computer_20251124`, beta header `computer-use-2025-11-24`;
  supported on Opus 5 / Sonnet 5 / Opus 4.6–4.8 / Opus 4.5. Actions:
  `screenshot`, `left_click`, `type`, `key`, `mouse_move`, `scroll`,
  `left_click_drag`, `right_click`, `middle_click`, `double_click`,
  `triple_click`, `left_mouse_down/up`, `hold_key`, `wait`, modifier-clicks,
  and `zoom` (behind `enable_zoom: true`). Screenshots return as base64 image
  blocks inside `tool_result`.
- **Resolution contract:** screenshots must match the declared
  `display_width_px`/`display_height_px`; 1024×768 (or downscaled 1080p) is the
  recommended accuracy/cost point. Higher-res capture must be downscaled with
  coordinate mapping back to physical pixels.
- **Companion tools:** Anthropic recommends pairing with text-editor and bash
  tools; PacketBench already has both.
- **Compliance:** third-party products must use API-key auth (PacketBench already
  does, exclusively) and must **inform users of computer-use risks and obtain
  consent before enabling** (Anthropic Usage Policy, eff. 2025-09-15). The
  opt-in toggle's confirm dialog is the consent surface.
- **Crates:** `xcap` for capture (the maintained cross-platform option; the
  `screenshots`/`scap` alternatives are deprecated/stale). `enigo` for
  injection — **already a dependency**, currently Windows-gated in
  `src-tauri/Cargo.toml:71-73` and used only by dictation paste
  (`commands/dictation/delivery.rs:13-36`). `rdev` only as the global
  kill-switch hotkey listener. Wayland input is immature; Linux ships
  X11-first, Wayland later via portals/libei.
- **Single-window scoping is a guardrail, not a boundary.** No OS reliably
  targets input at a background window. The honest design (used by Claude's
  own desktop app): focus the target, clamp coordinates to its bounds, verify
  the frontmost process before every injected event, reject on mismatch.
- **OS limits to document:** Windows cannot drive elevated (admin) windows or
  the UAC secure desktop (UIPI) — a feature, not a bug. macOS (later) needs
  Screen Recording + Accessibility TCC grants and Developer ID signing even
  for test builds (Sequoia/ScreenCaptureKit).

## 4. Codebase constraints and seams (from the 2026-08-16 research pass)

### 4.1 The prerequisite: image-capable tool results

Tool results are strings end-to-end today. Until this is fixed, screenshots
can reach neither the model nor the user:

- `ToolResult.content` and `ContentBlock::ToolResult.content` are `String`
  (`core/llm_types.rs:107-113`, `:59-65`). `ContentBlock::Image` exists
  (`:66-70`) but is never constructed.
- `build_anthropic_messages` drops non-text blocks in the tool-role arm
  (`core/llm_anthropic.rs:135-147`); the only inbound image path is user
  attachments inlined into the last user message.
- The MCP client's `extract_text_content` (`core/mcp_client.rs:365-380`) keeps
  only `type == "text"` — **MCP servers returning images are silently dropped
  today**; fixing this seam fixes that too.
- Sidecar: `SidecarEvent.tool_result` carries `output: string` only
  (`agent-sidecar/src/protocol.ts:285-292`); `stringifyToolResultContent`
  (`providers/anthropic.ts:177-201`) and `handler.rs:217-221` both flatten
  content. Outbound images need a protocol v12 event or `tool_result.images`
  field (Phase 3 only).
- UI: the transcript renders no images anywhere; the CSP blocks `data:` URIs
  (`src-tauri/tauri.conf.json:28` → `img-src 'self' asset: https://asset.localhost`).
  The sanctioned route is a temp file + `convertFileSrc`. The cleanest
  additive UI channel is the `tool-output-extended` merge-by-id seam
  (`src/stores/apiAgentListeners.ts:726-753`).
- Persistence: never store image bytes on the conversation
  (`src/types/agent-conversation.ts:61-63` precedent) — persist a provenance
  envelope + file path.

### 4.2 Tool family seam (Rust)

- Definitions append in `tool_definitions_with_mcp_trust`
  (`core/tool_runtime.rs:117-253`); dispatch is the flat match in
  `execute_tool_with_mcp_trust` (`:268-393`). The `mcp__` / `gh_` / `agent_`
  prefix arms (`:355/:364/:369`) are the precedent for a `computer_*` family.
- Computer-use tools are **host-agnostic in the code sense but local-only in
  the product sense**: they must run in the PacketBench process (the pattern of
  `web_fetch`/`gh_*`: `let _ = target;`) and must **refuse outright when the
  session's execution target is SSH or Syndicate** — "the screen" is
  unambiguously the local machine. Frontend gate: `isRemoteConversation`
  (`src/lib/remoteConversation.ts`); the `edit_file`-on-SSH fail-closed arm
  (`tool_runtime.rs:298`) is the backend precedent.
- Native Anthropic tool blocks: `ToolDefinition` (`core/llm_types.rs:91-97`)
  has no `type` passthrough; the desktop tier adds an optional `tool_type`
  field so `build_anthropic_tools` (`core/llm_anthropic.rs:163-174`) can emit
  `{"type":"computer_20251124", ...}` for Anthropic providers while other
  providers get an ordinary JSON schema.

### 4.3 Permissions and gating

- Backend gates: add the family to `RISKY_TOOLS` and **not** to
  `PLAN_MODE_ALLOWED` (`commands/api_agent.rs:1840-1846`). The ask path
  (oneshot parked in `pending_permissions`, `api-agent:permission-request`,
  300s timeout-deny, AllowOnce/AllowAlways/Deny) is reused unchanged.
- Frontend tiering: unknown tools classify as `blocking` by design
  (`src/lib/approvalTiers.ts`), so the family prompts by default even before
  explicit wiring.
- **Session authority rides a frozen snapshot, not `allowedTools`.** Model it
  on `McpTrustSnapshot` (`src/types/mcp.ts:37`, frozen at session start so
  later Settings edits cannot broaden a running session).
- **Opt-in follows the Syndicate pattern** (commits `121aee26` → `f1972732` →
  `53f98f83`): dedicated preference module (`src/lib/syndicateIntegration.ts`
  shape), fail-closed `AtomicBool` + `require_integration_enabled()` in Rust,
  bootstrap `syncNative()` mirror in `App.tsx`, consumers check
  `enabled && nativeReady`, confirm dialogs in both directions (the enable
  dialog doubles as the Usage-Policy consent surface), typed
  `INTEGRATION_DISABLED` error code so "off" is distinguishable from
  "broken", and settings-search keywords in `settingsNavigation.ts`.
- Settings surface: a new card in `src/components/views/tools/` + a
  `SettingsSection` key, next to `SyndicateMachinesCard`. The Modules registry
  is **not** the right home (modules are view-shaped; this is tool authority).
- **Flights are excluded in v1**: attempts are unattended (nobody to answer a
  blocking prompt) and a local attempt would fight the user for the mouse.
  `AutonomyPolicy` is the future home for a policy-level grant (Phase 3+).
- Screenshots are untrusted evidence: wire them into the existing
  `ProvenanceEnvelope` tainting so `provenanceNeedsRiskGate` can force prompts.

### 4.4 Approval UX

- `PermissionPrompt.tsx` dumps raw JSON args; `{"x":840,"y":312}` is
  unjudgeable. Add a computer-use branch (the bash parsed-command branch at
  `:133-158` is the precedent) rendering the current screenshot with the
  target coordinate highlighted.
- Multi-action turns need rollup: reuse `PendingApprovalsSection`'s
  collapse-at-3 and pane-scoped keyboard arming, and consider approving small
  action batches rather than one prompt per click.
- Kill switch: `rdev` global hotkey + "any physical mouse movement aborts the
  in-flight action sequence". Surfaced persistently while a computer-use turn
  is running.

## 5. Phases

### Phase 0 — image-capable tool results (prerequisite, independently valuable)

1. `ToolResult`/`ContentBlock::ToolResult` content becomes structured
   (text + image blocks); `build_anthropic_messages` emits image blocks inside
   `tool_result`; OpenAI-compat path gets the equivalent (or a text
   placeholder where a provider cannot accept tool-result images).
2. `extract_text_content` in the MCP client preserves image blocks (fixes the
   existing silent drop).
3. Transcript rendering: screenshot thumbnails on tool cards via temp file +
   `convertFileSrc`; `toolRowMeta.ts` entries; persistence stores path +
   provenance envelope, never bytes.

### Phase 1 — browser tier (CDP), Windows

1. Dedicated Chromium driven over CDP (`chromiumoxide` is the default
   candidate; spike WebView2's `--remote-debugging-port` CDP endpoint as a
   Windows-only alternative). Lifecycle owned by a new
   `src-tauri/src/commands/computer_use/` module.
2. `computer_*` tool family in `tool_runtime.rs`: navigate, screenshot, click,
   type, scroll, read-page (a11y-tree text extraction first, pixels as
   fallback — cheaper and more reliable than pure pixel clicking).
3. Full governance from day one: Syndicate-pattern toggle + native gate +
   typed errors + settings card; frozen session grant snapshot; `RISKY_TOOLS`;
   plan-mode exclusion; SSH/Syndicate/remote refusal; flights excluded;
   kill-switch scaffolding.
4. Approval prompt computer-use branch (screenshot + highlighted target).

### Phase 2 — desktop tier, Windows

1. `xcap` capture + `enigo` injection (un-gate `enigo` from the
   Windows-only dictation block when other platforms arrive; v1 stays gated).
   1024×768-equivalent scaling with coordinate mapping.
2. Native `computer_20251124` + `computer-use-2025-11-24` beta header for
   Anthropic providers (`tool_type` passthrough); JSON-schema equivalents for
   OpenAI/MiniMax/OpenRouter/Ollama rows.
3. Frontmost-app guardrail before every injected event; kill switch fully
   armed (hotkey + physical-mouse-movement abort).
4. Document the UIPI limitation (cannot drive elevated windows).

### Phase 3 — reach (each item separately scheduled)

- Per-application grants and read/click/full action tiers (Cowork-style).
- macOS: Developer ID signing, TCC onboarding flow (Screen Recording +
  Accessibility), ScreenCaptureKit capture. Depends on
  [`macos-release-plan.md`](./macos-release-plan.md) signing work.
- Linux X11; Wayland behind a feature flag via portals/libei.
- Sidecar backends: protocol v12 image-out event (`tool_result.images` or a
  new event), `stringifyToolResultContent`/`handler.rs` image preservation,
  computer tools via `createSdkMcpServer` for the Claude Agent SDK row.
- Flights/`AutonomyPolicy`: screen/app allowlist vocabulary and policy-level
  grants for unattended runs — only after the interactive path has real usage.
- Optional: Windows Sandbox "untrusted task" mode.

## 6. Explicitly out of scope

- Computer use over SSH/Syndicate targets (refused, typed error).
- Flight attempts driving the local desktop.
- Wayland input in v1.
- Any auto-allow default: the family never auto-allows without an explicit
  per-session grant plus per-action (or per-batch) approval in v1.

## 7-PAUSE. Pause record and pickup runbook (2026-08-16)

> Numbered `7-PAUSE` to sit ahead of the provenance section without renumbering
> links elsewhere. This is the section a future session reads first.

### What the pause means

The owner paused this plan on 2026-08-16, hours after ratifying its design
decisions, as part of a portfolio-wide sequencing pass (the same session
paused Remote Agents — see `remoteagents/10-pause-record.md` for the sibling
record). Scope of the pause:

- **No Phase 0.** The image-plumbing prerequisite is not scheduled, and no
  `computer_*` tool family, CDP module, settings toggle, or dependency change
  gets created.
- **The §2 owner decisions stand.** Nothing was reversed: browser-first,
  Rust in-process, approval-gated + kill switch, Windows-only v1 remain the
  ratified shape. Do not re-litigate them at pickup without a new owner
  decision; do re-*verify* the facts under them (below).
- The backlog entry stays in "Proposed later products," annotated as paused.

### Why

Same reason as the rest of the 2026-08-16 sequencing: the portfolio's
bottleneck is packaged, real-environment proof of already-built work, and the
owner rejected the v1.0.0 definition in favor of continuing the 0.10.x
cadence. Computer use is a large new surface (Phase 0 alone touches the
tool-result content model across every provider). The pause is sequencing,
not doubt — the research validated both the demand and the design.

### Exact state at pause

- **Zero implementation.** No code, no dependencies added (`xcap` not in
  `Cargo.toml`; `enigo` present but Windows-gated for dictation paste only),
  no settings surface, no protocol changes.
- **Design complete** (§§1–6 of this doc), grounded in a four-agent research
  fan-out (backend seams, frontend/safety surfaces, Anthropic docs, OS/crate
  landscape) — summarized in §3–§4 with file:line references.
- **Registered** in `dev/README.md` (active-plans table, "Designed, not
  started" → now paused) and `backlog.md` (P2 under Proposed later products).
- A session-memory note of the decisions exists in the owner's Claude memory
  (`computer-use-design-decisions`), updated to reflect the pause.

### Staleness map — what ages while this sits

| Fact class | Risk while paused | Re-verify how |
| --- | --- | --- |
| **Anthropic tool version** (`computer_20251124`, beta header `computer-use-2025-11-24`, model support list, `zoom`/`enable_zoom`) | High — tool versions and beta headers rotate with model launches | Fetch the computer-use tool doc (URL in §7 provenance) before writing any request code; do not trust §3 verbatim after a model generation ships |
| **Usage-policy consent requirements** | Medium — the consent/disclosure obligations could tighten | Re-read the usage policy page; the opt-in confirm dialog copy must satisfy whatever is current |
| **Crate landscape** (`xcap` maintained, `scap` dead, `enigo` 0.6.x, Wayland/libei maturity) | Medium — 6–12 month half-life; Wayland input was the fast-moving edge | Re-check crates.io/GitHub activity for xcap + enigo; re-assess Wayland via portals/libei only if Linux is in scope at pickup |
| **Codebase seams** (every file:line in §4: `tool_runtime.rs` dispatch, `RISKY_TOOLS` at `api_agent.rs:1840`, `stringifyToolResultContent`, CSP line, `tool-output-extended` merge, protocol version) | **Certain to drift** — the repo moves fast; line numbers and even seam shapes will rot | Re-run a scoped read-only explorer over §4's claims before Phase 0; treat §4 as a map of *where to look*, not current truth |
| **Phase 0 may partially exist by pickup** | Real possibility — image-capable tool results serve other tracks (MCP image results, Ten Empty Lanes' Flight Recorder fidelity) and could get built independently | Grep for structured `ToolResult` content / image blocks in `llm_types.rs` and the sidecar protocol version (>11 means something changed) before redoing any of it |
| **Sidecar protocol** (v11 at pause) | Any bump changes the Phase-3 sidecar path assumptions | Check `PROTOCOL_VERSION` in `agent-sidecar/src/protocol.ts` |
| **Competitive context** | Cursor cloud agents already ship computer use in VMs; first parties may ship desktop control natively | 15-minute sweep; affects urgency/positioning, not the design |

### Invariants that survive the pause

1. The §2 decision table (browser-first, Rust in-process, approval-gated,
   Windows v1) — owner-ratified 2026-08-16.
2. Local-only: SSH/Syndicate/remote conversations refuse computer use with a
   typed error; flights excluded until a policy-level grant design exists.
3. The family joins `RISKY_TOOLS`, never `PLAN_MODE_ALLOWED`, and never
   auto-allows without an explicit per-session grant in v1.
4. Consent before enablement (usage-policy requirement) via the
   Syndicate-pattern opt-in confirm dialog.
5. Session authority rides a frozen snapshot (McpTrustSnapshot pattern), not
   the mutable `allowedTools` list.
6. Screenshots are untrusted evidence: provenance-enveloped, tainting, bytes
   never persisted on the conversation.

### Pickup runbook (ordered)

0. Read this section, then §§1–6.
1. **Confirm the §2 decisions still fit** the product moment (one-line owner
   check — especially Windows-only and browser-first, which were sequencing
   choices as much as design ones).
2. **Refresh external facts**: current Anthropic computer-use tool
   version/header/models; usage-policy consent language; crate health
   (staleness map above).
3. **Re-verify the codebase seams**: run a read-only explorer over §4's
   claims (tool dispatch, permission gates, image chokepoints, CSP, protocol
   version) and check whether any of Phase 0 already exists.
4. **Re-scope Phase 0 against whatever now exists** — it remains the
   prerequisite for both tiers and stays independently valuable (MCP image
   results, transcript fidelity).
5. **Then execute the phases in §5 order**: Phase 0 → Phase 1 (CDP browser
   tier, Windows) → Phase 2 (desktop tier) → Phase 3 (reach).
6. On starting Phase 1, un-annotate the backlog entry and flip this doc's
   status back to ACTIVE.

## 7. Research provenance

Four-agent research fan-out on 2026-08-16 (backend seams, frontend/safety
surfaces, Anthropic docs, OS/crate landscape). Key external references:

- Computer-use tool docs: `https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool`
- Reference implementation: `https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo`
- Usage policy (consent requirement): `https://www.anthropic.com/news/usage-policy-update`
- Crates: `https://github.com/nashaofu/xcap`, `https://github.com/enigo-rs/enigo`
