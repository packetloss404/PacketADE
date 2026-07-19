# PacketADE Codebase State — main @ ca2e248 (2026-07-16)

> Compiled from read-only subsystem surveys of a pinned detached worktree of `main @ ca2e248`. All paths below are repo-relative. Note: the environment's gitStatus "recent commits" block (MiniMax catalog, startup-perf c3bb58a) is a **stale mid-June snapshot** — those commits are ~150 commits *behind* ca2e248. Actual `main == ca2e248`; the primary checkout currently sits on branch `fix/g33-stop-requeue` at the same commit.

---

## 1) TL;DR — what's new since this machine was last used

The pulled range `a6021cf..ca2e248` is **94 commits (2026-07-06 → 07-16)**, net-negative in lines because it contains two large amputations alongside heavy feature work. The headlines:

- **The "Tile program" landed: the standalone Agents tab is gone.** PacketADE is now a single-surface app. `AgentsView`/`AgentSidebar`/`AgentInputArea` are deleted; API-agent chats render as **ConversationTiles** inside the workspace mosaic. `FleetSidebar` replaced `WorkspaceSidebar` (now on the left edge), and a new **AgentInspectorPane** (Inspector/Plan/Preview/Diff/Files tabs) mounts on the right (`e357e91`). The two engines — `agentTaskStore` (conversations) and `workspaceStore` (placement) — are bridged solely by `src/stores/sessionGlue.ts`, enforced by eslint.
- **Flight Planner backend amputated** (2026-07-11, ~13,300 lines deleted): `commands/flight_planner.rs` and `flightPlannerStore.ts` are gone; the money path survives as `commands/flight_cost.rs`. Sidecar protocol bumped to **v7**.
- **Sidecar protocol is now v8** (CLAUDE.md still says 6). v8 = S8-Phase-B "stdio MCP over SSH via remote-owned config": remote sidecars source their *own* MCP config from the remote filesystem (`sourceMcpFromFs` flag, new `mcp_sources` event, new `agent-sidecar/src/mcp-config.ts`). **Behavior change:** remote sessions no longer inherit local MCP config.
- **PacketADE is now itself an MCP server** (N3): new `src-tauri/src/mcp_server/` module (rmcp, Streamable HTTP at `/mcp`, bearer/Origin auth, 5 read tools + 7 `packetade://` resources, opt-in append-only `append_handoff`/`escalate` writes).
- **Sidecar-over-SSH is real**: the supervisor spawns a dedicated per-session Node sidecar *on the remote host* with OAuth preflight (exit codes 91/96/97); remote git write actions, remote worktrees, and Codex-over-SSH all shipped.
- **Deploy view, Ideation module, orchestrationStore, NewFlightModal/FlightChatPanel all deleted** (P2-20 state pruning); orchestration converged onto `asyncFlightStore`. Flights launch as parallel worktree-bound **Attempts** via `LaunchAsyncFlightModal`.
- **N2 swarm escalation** (suggests-not-acts, `src/lib/flightCoordination.ts`), **N4 review packets**, **N5 cost-threshold notifications**, GitHub PR line comments + notifications inbox, memory injection restored and on-by-default.
- **CLAUDE.md was removed from the repo and gitignored** (commit `21a6242`) — the copy on this machine is untracked and substantially stale (see §5).
- HEAD `ca2e248` itself is a **repo-wide LF renormalization** (172 files, ±40k lines of noise) — blame across it with `--ignore-rev ca2e248` or `-w`.
- **A launch-ready P1/P2 fix-loop plan was committed "not started"** (`ef3d833`) and its first slice (`fix/g33-stop-requeue`) has since been kicked off — see §6.

---

## 2) Architecture map

### App shell & routing (frontend)
- `src/App.tsx` — shell: TitleBar → Toolbar → [LeftRail | FleetSidebar (workspace view) | main | AgentInspectorPane] → StatusStrip. Lazy views; **WorkspaceView is always-mounted** (display:none when inactive) so PTY sessions survive navigation. Hosts login-modal listeners, sessionGlue init, MCP write bridge.
- `src/stores/appStore.ts` — `CoreView = "welcome" | "issues" | "flights" | "history" | "tools" | "github" | "memory" | "workspace" | "cost_dashboard" | "dictation"` plus `mod:${string}`. `normalizeView()` remaps legacy persisted `"agents"` → `"workspace"`. No `"deploy"`, no `"missions"`.
- `src/lib/viewHotkeys.ts` — Ctrl+Shift+1..5 etc.; `src/components/layout/` = TitleBar, Toolbar, LeftRail, StatusStrip, SidecarStatusChip, RunningAgentsChip, LiveSpendChip.
- Modules: `src/modules/registry.ts` — only `quality` and `dictation` remain.

### Workspace tiling & sessions
- `src/types/workspace.ts` — `WorkspacePane.kind?: "terminal" | "conversation"` is the sole discriminant (absent ⇒ terminal). Agent slots: terminal/claude-code/codex/gemini/opencode/**packetcode**.
- `src/components/workspace/WorkspaceMosaicContainer.tsx` — react-mosaic tree per workspace; `WorkspacePane.tsx` (terminal/PTY, local + SSH), `ConversationTile.tsx` (chrome around unforked `agents/AgentChatPane.tsx`), `DraftTile`.
- `src/components/workspace/FleetSidebar.tsx` — unified fleet list (workspaces + virtual rows for unplaced conversations via `src/lib/fleetRows.ts`); status from `src/lib/sessionStatus.ts`.
- `src/components/agents/AgentInspectorPane.tsx` — right rail: Inspector / Plan / Preview / Diff / Files.
- `src/stores/sessionGlue.ts` — the ONE bridge between `agentTaskStore` ↔ `workspaceStore`: one-directional conversation→pane GC, reconciliation, `openSession()` (deterministic `ws-wrap-<convId>` wrapper workspaces).
- `src/stores/layoutStore.ts` — legacy-thin shim; `projectPath` mirrors the active workspace (canonical source: workspaceStore).
- Login CTAs (`packetade:open-claude-login` / `open-codex-login`) open a floating `src/components/auth/LoginPtyModal.tsx` — no workspace pane.

### Frontend state (43 Zustand stores, two persistence planes)
- **Plane 1 (Rust `PersistedState`)** — `~/.packetade/state.v1.json`, hydrated by `src/lib/bootstrap.ts`, written via per-slice commands (`saveFlightsSlice`, `saveIssuesSlice`, …). Backend-truth stores: flightStore, serverStore, workspaceStore (+ localStorage cache), memoryStore, issueStore (dual-writes).
- **Plane 2 (localStorage)** — `packetade:*` prefix (`src/lib/brand.ts`), one-shot `packetcode:` migration.
- **Conversations** — per-conversation JSON files via `agentConversationPersistence.ts` (debounced); this record is also `agentPlanStore`'s *only* persistence.
- `src/stores/agentTaskStore.ts` (1,402 lines) — hub; defines `AgentCli`/`ApiAgentCli` unions, `canonicalizeAgentCli()` (`api-minimax-api` → `api-minimax` alias). Satellite stores split for churn isolation: agentApprovalStore, agentPlanStore, agentStreamingStore, agentDraftStore, editBaselineStore, reviewStore.
- `src/stores/apiAgentListeners.ts` — installs **14** per-session `api-agent:{kind}:{sessionId}` listeners (event names in `src/lib/events.ts`): the documented 9 plus `edit-baseline`, `plan-block`, `tool-output-extended`, `turn-summary`, `mcp-sources`.
- Flights: `flightStore.ts` (legacy milestone/task flights) + `asyncFlightStore.ts` (parallel worktree Attempts, draft-PR publishing, swarm escalation). Planner state = fields on `Flight` (plannerSessionId/Status/Cost/Tokens/Provider).
- `src/lib/tauri.ts` (2,830 lines) — the entire invoke surface. A generated ts-rs schema also exists at `src/generated/tauri-schema.ts` (kept honest by `pnpm check:tauri-schema`).
- Catalogs: `src/lib/api-models.ts` (API providers, **8 rows**, single minimax row) vs `src/lib/models.ts` (PTY CLI `--model` flags) — intentionally different.

### Rust command layer (`src-tauri/src/commands/`, ~45 modules, ~200 commands)
- `lib.rs` — strict startup order: `fix_path_for_gui_launch()` **first statement** → tracing → `migrate_data_dir()` (~/.packetcode → ~/.packetade) → panic hook → PTY orphan reap. Managed state incl. SidecarManager, ApiAgentState, McpServerState.
- `commands/api_agent.rs` — `start_api_agent_session` branches on `is_sidecar_provider` (SIDECAR_PROVIDERS = claude-oauth, openai-codex, openai-agents, echo); everything else runs the in-process `LlmProvider` loop (MAX_TOOL_ITERATIONS=150), Local or Ssh. Local sidecar MCP config merged from global+project; remote sessions get `remote_mcp_directive()` (empty map + `sourceMcpFromFs=true`).
- `commands/agent_sidecar/` — **directory module** (mod/supervisor/handler/events/protocol/status). `EXPECTED_PROTOCOL_VERSION = 8`; local supervision (≤3 restarts/60s, `sidecar-status:changed`) plus per-session **remote sidecars over SSH** with POSIX preflight.
- `commands/provider_auth.rs` — statuses `ready | login_required | missing_key | service_down` (no more `coming_soon`); refresh-token-aware OAuth probes; new `sign_out_provider`. `auth_watcher.rs` — 500ms *trailing-edge* debounce, `$HOME` fallback.
- `commands/mcp.rs` — global (`~/.claude/settings.json`) + project (`.mcp.json`) scopes; lenient reads, strict atomic writes; `raw_config` round-trip.
- `commands/state.rs` / `orchestration.rs` — slice savers; bulk save *ignores* issues/retrospectives; orchestrator lock held across `update_state` by design.
- `commands/flight_attempts.rs` — async "one prompt → N agents" engine (local/SSH worktrees per attempt).
- `src-tauri/src/mcp_server/` — N3 PacketADE-as-MCP-server. `src-tauri/src/api/` — ts-rs DTO layer (**replaces the deleted `src-tauri/src/session/`**).

### Rust core (`src-tauri/src/core/`)
- `brand.rs` — all identity constants (APP_NAME, DATA_DIR `.packetade`, KEYRING_SERVICE `packetade` + legacy fallbacks).
- LLM layer: `llm_provider.rs` trait + registry (anthropic | openai | minimax/minimax-api | openrouter | ollama); `llm_anthropic.rs` native SSE; everything else through `llm_openai_compat.rs`. MiniMax base URL is `https://api.minimaxi.chat/v1` (the extra "i" is correct).
- `execution.rs` — `SshConfig` + `ExecutionTarget`; host-fingerprint pinning (StrictHostKeyChecking=yes + app-managed known_hosts) vs TOFU fallback when fingerprint absent; ControlMaster unix-only.
- `storage.rs` — `PersistedState`; two-level lock discipline (ASYNC_STATE_LOCK before STATE_LOCK), `write_with_backup`, quarantine-first read-only recovery ladder.
- `orchestrator.rs`, `worktree.rs` (auto-commit trailer hook), `mcp_client.rs`/`mcp_bridge.rs` (in-process MCP: real JSON-RPC stdio client; tools named `mcp__<server>__<tool>`), `tool_runtime_ssh.rs`, `migration.rs`, `llm_system_prompt.rs` (still uses `PACKETCODE_DONE` sentinel — load-bearing).
- `src-tauri/src/claude/binary.rs` — Claude CLI discovery + headless `run_claude()` with retry.

### Node agent-sidecar (`agent-sidecar/`, separate pnpm package v0.5.0)
- `src/protocol.ts` — **PROTOCOL_VERSION = 8** (source of truth). `src/index.ts` stdio dispatcher; `src/session-registry.ts` per-session promise queues + SSH-workspace guard (`PACKETADE_REMOTE_SIDECAR=1`); `src/mcp-config.ts` (v8, never-throws FS loader).
- Providers: `echo` (smoke), `anthropic.ts` (claude-oauth, single long-lived Agent SDK `query()`), `openai-codex.ts` (one-shot `codex exec --json` per turn, dual 0.121/0.135+ schema, stdin closed — sandbox flags are the safety boundary), `openai-agents.ts` (BYOK, 5 project-confined tools, RunState approvals).
- 10 smoke tests; `pnpm sidecar:check` chains 9 (codex-0142-schema-smoke is manual-only).

### Build & tooling
- **Not a pnpm workspace** — root (`packetade` v0.10.1, pnpm@9.15.4) + `agent-sidecar/` stitched via `pnpm -C`.
- Release: `prebundle` = clean:dmg-scratch → `scripts/fetch-node.js` (pinned Node 24.15.0, 5 triples, SHA-verified, → gitignored `src-tauri/binaries/`) → sidecar install/build → `scripts/prune-sidecar.js` (**destructive** hoisted prod-only reinstall). `tauri.conf.json` embeds node as externalBin + sidecar dist/node_modules as resources.
- Quality ladder (all local, **intentionally no CI** — no `.github/`): `pnpm preflight` → `pnpm check` → `pnpm release:gate[:strict]` → `pnpm release:readiness` (see `dev/local-quality-gates.md`). macOS: use `pnpm build:macos` (DMG retry wrapper).
- Rust builds a vendored patched `portable-pty` (`src-tauri/vendor/portable-pty`) — do not upgrade back to crates.io.

### Docs & planning
- `ROADMAP.md` (updated 07-16): Now = R0 Remote Agents / R1 docs / R2 signing; entire Next table (N1–N5, S8) **Shipped**. `backlog.md` = master ledger (incl. 83-finding F/G review register). `CHANGELOG.md` [0.10.1] holds the whole 07-13→07-16 wave. `dev/README.md` = planning index; `dev/remoteagents/` = canonical R0 plan (blocked on 3 stale Sprint-0 decisions).

---

## 3) Recent change themes

1. **Conversation-as-tile program** (~20 commits): pane kind schema across TS+Rust, sessionIndex/sessionGlue, ConversationTile, FleetSidebar, AddAgentPicker, `merge_conversation_branch`, WorktreeLifecycleBar, then outright deletion of the Agents tab. Layout polish at `e357e91` (Fleet left, inspector right).
2. **MCP expansion in three waves**: HTTP/SSE MCP over SSH → N3 PacketADE-as-MCP-server (5 slices) → S8-Phase-B remote-owned stdio MCP config (protocol v8).
3. **Remote/SSH parity**: per-session remote sidecars with OAuth preflight, remote git writes, remote worktrees, ServerConfig-driven host-key pinning, Codex-over-SSH.
4. **Amputations**: Flight Planner backend (v7), Agents tab, Deploy/Ideation/orchestrationStore/goal state (P2-20). Net range delta is −1,771 lines excluding the LF commit.
5. **Hardening batches**: P2 Rust + sidecar/frontend passes, F40 SSRF block in `tool_web.rs`, G16 parallel tool calls, F02 UTF-8 PTY freeze, storage lock discipline + corruption recovery ladder.
6. **Memory rewire**: injection restored for tile launches, task-relevant retrieval, provenance links, on by default.
7. **GitHub surface growth**: PR line comments + thread replies, notifications inbox, review packets in GitDashboard.
8. **Docs truth passes**: repeated ROADMAP/backlog/dev reconciliation (`c3482dd`), 0.10.0/0.10.1 cuts, launch-ready fix-loop plan committed (`ef3d833`).
9. **LF renormalize** at HEAD — pure noise, poisons naive blame.

---

## 4) Gotchas & non-obvious constraints

**Frontend**
- Never conditionally unmount WorkspaceView — PTY xterm sessions die. It toggles via `display:none`.
- `agentTaskStore` ↔ `workspaceStore` must never import each other (eslint-enforced); all wiring through `sessionGlue.ts`. Closing a tile never deletes a conversation; deleting a conversation GCs tiles.
- All view routing must pass `normalizeView()` — a persisted `"agents"` value bypassing it blank-screens.
- `agentPlanStore` has no storage of its own — the persisted conversation record's `plan`/`planApproved` fields *are* its persistence.
- Route agent ids through `canonicalizeAgentCli()` (legacy `api-minimax-api` alias); `apiAgentProvider()` defaults unknown `api-*` ids to `anthropic`, which mis-bills.
- Escape layering: while `reviewStore.open`, zoom-exit no-ops so Escape closes review first.
- Use per-slice save commands, never a whole-state save; `issueStore` dual-writes localStorage + backend while flight/server/memory stores are backend-only.
- `ServersView.tsx` exists but is unrouted (likely dead); servers live in ToolsView's ServersSettingsCard.
- OS notification permission must stay on first user gesture (macOS WKWebView rejects non-gesture requests).
- OpenCode agent slot has no bypass flag on purpose (it would print `--help` and exit).
- Despite the "never hardcode `packetade:`" rule, ~20 stores hardcode the literal prefix — a future rename will churn.

**Rust**
- `fix_path_for_gui_launch()` must remain the literal first statement of `run()` (pre-threads env mutation).
- `SshConfig.host_fingerprint = None` silently downgrades to TOFU accept-new — always copy `hostFingerprint` (and `authMethod`) through from `ServerConfig`.
- storage.rs lock order is strict (ASYNC_STATE_LOCK before STATE_LOCK); re-entering `with_state_lock` from its own closure deadlocks. `load_state` recovery is deliberately read-only; quarantine-before-recovery ordering matters.
- Orchestrator mutations go through `with_orchestrator_and_flights` (lock held across `update_state` by design); never take the PTY lock while holding the orchestrator lock.
- `save_persisted_state` silently drops issues/retrospectives (slice-owned).
- MCP: project-scope `disabled:true` *shadows* a same-named enabled global entry; write path must stay strict + atomic (no pre-remove).
- Expired OAuth access token + present refresh token = `ready`, not `login_required`. Auth-watcher debounce must stay trailing-edge.
- Rust wire provider ids are unprefixed (`claude-oauth`, `anthropic`); frontend `AgentCli` carries the `api-` prefix. `minimax-api` survives in Rust as a legacy id only.
- `stream_options.include_usage` intentionally NOT sent to Ollama. Ollama base URL is now configurable.
- `data_dir()` prefers `~/.packetade` only if it exists, else falls back to `~/.packetcode`.
- Keyring: `api-key-{provider}` and `ssh-<ServerConfig.id>` under service `packetade` with legacy-service read fallback.

**Sidecar**
- Stdout is protocol-only — any `console.log` corrupts the NDJSON stream; log to stderr.
- Remote sessions deliberately send workspace `kind:"local"` to the remote sidecar — do not "fix". Local sidecar refuses `kind:"ssh"` unless `PACKETADE_REMOTE_SIDECAR=1`.
- Sidecar-over-SSH requires key/agent auth (password rejected — stdin carries the protocol), Unix remote, Unix-style absolute remote path; preflight sentinel exits 91/96/97.
- Codex: stdin closed immediately, so interactive approvals can never fire (permission plumbing in openai-codex.ts is retained dead code); `stream_error` is transient, not terminal; overlapping turns rejected; mcpServers/allowedTools logged-and-ignored.
- Anthropic provider: never break the long-lived `query()` pump on first `result`; `edit_response` with `mergedContent` writes then *denies* the SDK write.
- `sourceMcpFromFs` fully replaces `req.mcpServers`; per-session enabled-server filtering does not apply to FS-sourced servers; `mcp_sources` emits even if provider start fails; `loadMcpFromFs` must never throw.
- Version negotiation is warn-only. Echo provider intentionally lacks cancel_pending_tools/inject_user_turn (smoke asserts the error).
- Tests import from `dist/` — run `pnpm sidecar:build` first.

**Build**
- `sidecar:prune` (run by every `pnpm tauri build`) destroys sidecar devDeps — re-run `pnpm sidecar:install` before sidecar dev work.
- Fresh clone can't `pnpm tauri build` until `pnpm fetch-node` runs (`src-tauri/binaries/` is gitignored). Cross-target builds need `TAURI_TARGET`/`--target`.
- Blame/diff across `ca2e248` (LF renormalize): use `--ignore-rev ca2e248` or compare against `ca2e248~1`.

---

## 5) CLAUDE.md / docs drift worth fixing

**CLAUDE.md itself is not in the repo** (gitignored at `21a6242`) — it exists only untracked in the primary checkout, so fresh clones/worktrees have no project instructions. It predates the Tile program and is wrong in most structural claims:

- **Sidecar protocol**: says v6; code is **v8** (v7 = planner amputation, v8 = sourceMcpFromFs + mcp_sources). `agent-sidecar/README.md` is also stale (says 7).
- **Agents Pane**: AgentsView/AgentSidebar/AgentInputArea deleted; chat is ConversationTile + `agents/composer/`. The 8-row table is coincidentally right again post-MiniMax-remerge, but auth statuses lost `coming_soon` and gained `sign_out_provider`.
- **CoreView**: no `"deploy"`, no `"missions"` literal — Flights route is `"flights"`; Deploy view/deployStore/Ideation module/IdeationView all deleted (only dead `commands/deploy.rs` remains backend-side, pending the deploy-P2 decision).
- **Stores**: flightPlannerStore, orchestrationStore, deployStore, ideationStore gone; ~25 existing stores undocumented (asyncFlightStore, sessionGlue, reviewStore, agentPlanStore, serverStore, costGuardrailStore, …).
- **Flight creation**: NewFlightModal/FlightChatPanel/useFlightChat deleted; actual flow is LaunchAsyncFlightModal + AsyncFlightGrid/AttemptTile. `flight-chat:*` helpers in `events.ts` are orphaned dead code.
- **api-agent events**: 9 documented, **14** real (add edit-baseline, plan-block, tool-output-extended, turn-summary, mcp-sources).
- **File-structure drift**: `agent_sidecar.rs`, `statusline`, `dictation` are directory modules; `src-tauri/src/session/` replaced by `src-tauri/src/api/` (ts-rs DTOs); `src-tauri/src/mcp_server/` entirely undocumented; layout/ contents wrong (no PaneContainer/SessionTabBar); AgentCli lives in `agentTaskStore.ts`, not the types file; sidecar tests are 10 (protocol-v8-smoke, not v6); `scripts/` has 6 undocumented scripts; missing core modules (llm_openai_compat, execution, worktree, mcp_bridge/client, migration).
- **Sidecar-over-SSH** (per-session remote sidecars + preflight) is a whole undocumented execution mode; sidecar entry-point section describes only local.
- **Build docs**: real gate ladder is preflight/check/release:gate/release:readiness (dev/local-quality-gates.md); generated ts-rs schema pipeline unmentioned.
- **Login CTAs** now open LoginPtyModal, not a workspace PTY.
- Smaller doc bugs: `dev/README.md` still says cost alerts "not yet implemented" (they shipped, N5 — trust ROADMAP/backlog); CHANGELOG [0.10.1] header is dated 07-13 but accumulated entries through 07-16 with no version bump; the "Insights" streaming example event (`insights:chunk`) is now `agent-chat:*`.

**Recommendation:** regenerate CLAUDE.md against ca2e248 (or re-commit a maintained version) — nearly every section needs rewriting, and its absence from git means new machines start blind.

---

## 6) Active work & what's next

**Currently running: the P1/P2 launch-ready fix loop** (`dev/p1-p2-fix-loop-spec.md` + `dev/p1-p2-fix-loop.workflow.js`, committed `ef3d833` as "not started" — but the primary checkout is now on **`fix/g33-stop-requeue`** and a stash references an unreachable commit `c2f1320` ("W3 — orchestrationStore split + 3 catch fixes"), so the loop's first slice is in flight **on separate branches**. Expect one branch per item; don't collide with it on main.)

Six pinned slices, in order:
1. **G33** — Stop-while-queued re-sends the queued message (sync store update in `agentTaskStore.cancelActiveConversation` before the cancel invoke). *Started.*
2. **deploy-P2** — **blocking USER DECISION**: delete the dead `commands/deploy.rs` family (Option A, closes F22/23/24/25/39) vs re-surface UI (Option B). The workflow *skips* it unless launched with `args:{deploy:"delete"}`.
3. **F53** — cross-arch builds bundle host-arch claude-agent-sdk platform package; fix via `pnpm.supportedArchitectures` in package.json (the `--config.` CLI form is confirmed non-functional in pnpm 9.15.4) + `scripts/target-triple.js` + release-gate asserts.
4. **G01** — sidecar process tree orphaned on app exit; use tokio `Command::process_group(0)` (explicitly NOT pre_exec/setsid — macOS fork-safety) + RunEvent::Exit hook in lib.rs.
5. **sshpw-P2** — SSH password auth silently no-ops on Unix; SSH_ASKPASS self-exe helper (`core/ssh_askpass.rs`), 0600 secret file, no sshpass.
6. **G09** — codex `respondPermission` writes to closed stdin + live crash (codex-cli 0.144.5 rejects `-a` in `codex exec`): drop `-a` from modeToCodexFlags, amputate dead approval plumbing, add per-turn idle watchdog, gate codex smokes.

Fix-loop execution notes: the spec pins exact file:line anchors ("do not re-derive"), forbids prettier on src/ and running preflight/format:check per-slice; G09's registry-smoke failure is pre-existing for every slice except G09. The workflow file hardcodes a macOS path (`/Users/ianwalmsley/projects/PacketADE`) and a nonstandard co-author trailer — both wrong for this WSL machine.

**Roadmap after the loop:**
- **R0 Remote Agents** (P0, planning complete — `dev/remoteagents/README.md`: PWA + Packet Cloud relay, desktop-owned execution, narrow audited command envelope reusing the api-agent contract) — **blocked** on three Sprint-0 decisions in `09-open-decisions.md` (auth provider, E2EE timing, code location), all Open and ~4 weeks stale. Unblocking these is the highest-leverage non-code action.
- **R1** docs consolidation (in progress — this drift list feeds it).
- **R2** distribution/signing — blocked on acquiring Windows + macOS code-signing certs.
- Later: Codex app-server transport (A6), Send-to-Monitor (paused), native iOS, plugins, multi-model A/B.
- Only open remote-parity verification item: live Codex-over-SSH smoke (`dev/sidecar-over-ssh-verification.md` step 12).

**Local machine notes:** the primary checkout has uncommitted modifications to `scripts/fetch-node.js` and `docs/index.html` — reconcile or stash before branching. Version is 0.10.1 across package.json / tauri.conf.json / Cargo.toml.