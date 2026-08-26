# PacketBench Two-Team Code Review — 2026-05-31

> Method: two independent subagent review teams (Backend = Rust/Tauri + Node sidecar; Frontend = React/TS) fanned out across 15 subsystems. Every finding was adversarially verified by an independent skeptic prompted to *refute* it; only findings that survived refutation are recorded here. **Backend: 21 verified findings. Frontend: 22 verified findings.** 76 agents, ~3.7M tokens.

---

## Executive Summary

PacketBench is **structurally sound and functionally mature**. Both teams independently converged on the same root cause: **failure-path and async-lifecycle discipline is the weak link, not architecture.** The happy paths are well-built; what breaks is what happens on timeout, cancel, rejection, crash, or hostile input.

No critical steady-state data-corruptor was found. The backend surfaced a genuine **data-durability hole** (persisted-state reset-to-default), and the frontend surfaced a genuine **correctness lie** (failed deploys shown green). Severity skews medium/low — but the *recurrence* of the same defect class across independent modules is the real signal: these are systemic patterns, not isolated bugs.

A notable strength: **almost every finding has a correct sibling pattern already in the same codebase** (`kill_on_drop` in `hooks.rs`, `saturating_add` in the rollup, dual-keyring delete in `delete_ssh_password`, the fingerprint gate in `WorkspaceCreationModal`, `sendMessage`'s catch block). The fixes are largely "apply the pattern you already wrote, at the site that forgot it." **No architectural rework needed** — the work is propagation and failure-path discipline, best done as ~5 themed PRs rather than 43 individual patches.

---

## Fix These First (prioritized across both teams)

Ranked by **user-visible blast radius × likelihood of trigger**.

| # | Item | File | Sev | Why first |
|---|------|------|-----|-----------|
| 1 | **Dead/cached MCP client never evicted** — one flaky server breaks itself for the whole session until app restart | `src-tauri/src/core/mcp_client.rs:403` | high | Largest blast radius; self-perpetuating outage on lazy respawn. Evict on connection error. |
| 2 | **OpenAI Agents `auto` mode auto-execs bash/write_file with no approval** | `agent-sidecar/src/providers/openai-agents.ts:744` | high | Breaks the safety contract every other provider honors; arbitrary in-project exec/write silently. |
| 3 | **Failed migration / parse error / crash silently wipes persisted state** and overwrites recoverable data; `.bak` never read | `storage.rs:146`, `:169`, `:519` | med (data-loss) | Only data-loss cluster. Add legacy fallback, quarantine bad file, read the `.bak`. |
| 4 | **Failed deploys render as green success** (hardcoded exit 0 races real exit channel) | `src/components/views/DeployTerminal.tsx:100-104` | med (correctness) | A correctness *lie* — user trusts a broken deploy. Rely solely on numeric `deploy:exit:{id}`. |
| 5 | **Optimistic streaming UI strands forever on backend rejection** — retry & new-conversation | `src/stores/agentTaskStore.ts:1463`, `:951` | med | Reached automatically via auto-failover (no user action). Wrap awaits in try/catch, clear `isStreaming`. |
| 6 | **Codex `stream_error` dead-coded** — mid-stream failure never surfaces, turn hangs | `agent-sidecar/src/providers/openai-codex.ts:809` | med | Backend half of the "turn hangs forever" pair with #5. Remove `stream_error` from the ignore branch. |
| 7 | **Tool-runtime children orphaned on timeout** (no `kill_on_drop`) + sidecar bash leaks grandchildren | `tool_runtime.rs:462-491`, `tool_runtime_ssh.rs`, `tool_pull_request.rs`; `openai-agents.ts:877` | high/low | Every timed-out command leaks a live process holding ports/dirs. Propagate the `hooks.rs` fix; process-group kill in Node. |
| 8 | **SSH pinning bypass (silent TOFU)** — UI permits launch, backend skips remote symlink check | `LaunchAsyncFlightModal.tsx:41-50` + `execution.rs:238-266` | med | MITM on first connect + workspace-escape via remote symlink. Gate unpinned hosts in UI; `realpath` re-check on remote. |
| 9 | **`delete_api_key` leaves legacy keyring entry — deleted keys resurrect** | `src-tauri/src/commands/api_keys.rs:127` | med | "Deleted" credentials silently re-migrate. Mirror `delete_ssh_password`'s dual-entry delete. |
| 10 | **Sidecar ReDoS + O(n²) truncation stall ALL sessions** (shared event loop) | `openai-agents.ts:924`, `:116` | med | Single hostile/large input freezes every multiplexed session. Cap pattern length + wall-clock budget; Buffer-slice truncation. |
| 11 | **Deploy output/exit lost in startup race — run stuck "running" forever** | `src/stores/deployStore.ts:128` | med | Reproducible for any quick command. Register listeners on the client-minted run id *before* `invoke`. |
| 12 | **In-process stream task detached on cancel** — leaks HTTP connection + pushes into closed channel | `src-tauri/src/commands/api_agent.rs:1299-1357` | low | One leaked provider connection per cancelled turn; `stream_handle.abort()` on both cancel arms. |

**Second tier** (same pass — same patterns, lower trigger probability): global `SUBAGENT_DEPTH` (`tool_subagent.rs:113`), `set_ssh_password` empty-password (`ssh_keys.rs:53`), token-counter overflow (`api_agent.rs:1389`), wrong Gemini npm package (`ssh.ts:118`), `useTransientPty` leak (`useTransientPty.ts:228`), auth-watcher leading-edge debounce (`auth_watcher.rs:201`).

**Cleanup pass** (low risk, high consistency): brand-string drift (`StatusStrip.tsx:160`, `tauri.ts:1440`, `mcpProviderStore.ts:90`, `layoutStore.ts:74`, `SessionTabBar.tsx:15`) and dead/redundant code (`asyncFlightStore.ts:439`, `tauri.ts:2457`, `SessionTabBar` dead `+`).

---

## Cross-Cutting Themes (spanning both teams)

### 1. The shared `api-agent:*` event contract is only as strong as its terminal events
The contract's promise — frontend is agnostic to in-process vs. sidecar transport because both emit identical `chunk/done/error` — **breaks precisely when an event is dropped or never fires:**
- **Backend** swallows terminal events: Codex `stream_error` dead-coded (`openai-codex.ts:809`); in-process stream task detached on cancel pushes into a closed channel (`api_agent.rs:1299`).
- **Frontend** assumes the terminal event always arrives: `retryLastTurn`/`createApiConversation` optimistically render a streaming bubble, then await a backend call with no rejection handling — a *rejected* start emits no `done`/`error`, so the spinner runs forever (`agentTaskStore.ts:1463`, `:951`).

These are the **same bug from opposite ends of one contract.** Fix them together (PR #2 below).

### 2. Resource cleanup on abnormal termination is omitted everywhere, in both languages
Spawned children (bash, ssh, gh/git, MCP) and async tasks leak because `kill_on_drop(true)`/`abort()` is missing. Node twin: sidecar bash kills only the shell, orphaning grandchildren (`openai-agents.ts:877`); frontend leaks PTYs when listener setup throws (`useTransientPty.ts:228`). The `hooks.rs` fix landed and was never propagated. ~6 instances across Rust, Node, TS.

### 3. Error-handling discipline: silent collapse vs. silent hang
- **Silent collapse to default/empty** — the storage trio (`storage.rs:146/169/519`) resets to empty state on migration failure, parse error, or crash, then overwrites recoverable data on next save. A `.bak` is written but never read.
- **Silent hang** — optimistic UI with no `catch`, dead-coded error branches, detached cancel tasks. The user sees a spinner or a "running" pill that never resolves.

### 4. Secret/credential handling is asymmetric and leaks across stores
- `delete_api_key` deletes only the new keyring entry → legacy copy resurrects deleted credentials via migration (`api_keys.rs:127`).
- `set_ssh_password` accepts an empty password, silently flipping to interactive auth with a blank credential (`ssh_keys.rs:53`).

### 5. Security-posture asymmetry: local is hardened, remote/sidecar is not
- OpenAI Agents `auto` mode auto-executes bash/write_file with no approval (`openai-agents.ts:744`).
- Remote SSH tools skip the symlink canonicalization local tools enforce (`execution.rs:238`).
- Async-launch SSH permits silent TOFU against unpinned hosts (`LaunchAsyncFlightModal.tsx:41`) — `WorkspaceCreationModal` blocks this exact case.

### 6. Shared single-threaded / global state causes cross-session interference
The Node sidecar multiplexes all sessions through one event loop, so per-session pathology becomes a **global stall**: model-supplied regex with no ReDoS guard (`openai-agents.ts:924`) and O(n²) truncation (`:116`) block *every* session. On the Rust side, a process-global `SUBAGENT_DEPTH` conflates concurrent conversations (`tool_subagent.rs:113`).

### 7. Brand/storage-prefix convention drift (frontend, low risk, easy)
The `brand.ts` one-file-rename guarantee is violated in ~5 sites. Individually trivial; collectively they defeat the centralization mandate.

---

## Recommended Sequencing

1. **"Abnormal-termination" PR** — propagate `kill_on_drop`/`abort()`/process-group-kill across #7, #12, and the Node bash leak. One theme, one fix.
2. **"Terminal-event contract" PR** — #5 + #6 together (frontend optimistic-UI catch + backend dead error branch), two ends of one hang.
3. **"Storage durability" PR** — #3's three sites as a unit (legacy fallback + quarantine + `.bak` read).
4. **Standalone high-priority** — #1 (MCP eviction), #2 (OpenAI Agents approval), #4 (deploy success lie) ship independently.
5. **Security pairing** — #8 (SSH pinning, coordinated FE+BE), #9 (keyring delete).
6. **Cleanup pass** — brand drift + dead code, batched.

---

## Team A — Backend (Rust + Node sidecar) · 21 verified findings

**Synthesis:** Functionally rich but consistent weak failure-path hygiene. Dominant class = resource leaks on abnormal termination (children + async tasks never reaped because `kill_on_drop`/`abort()` omitted — the `hooks.rs` fix was not propagated). Second = state-store durability fragility (failed migration/torn write/parse error all collapse to empty default and then overwrite recoverable JSON; `.bak` written but never read). Third = security-posture asymmetry between in-process and sidecar/SSH paths. Most findings align the offending site with an existing correct pattern elsewhere.

| Sev | Title | File |
|-----|-------|------|
| high | Dead/cached MCP client never evicted (breaks server until restart) | `core/mcp_client.rs:403` |
| high | OpenAI Agents `auto` runs bash/write_file with no approval | `agent-sidecar/.../openai-agents.ts:744` |
| high | Tool-runtime children orphaned on timeout (no `kill_on_drop`) | `core/tool_runtime.rs:462-491` (+ `tool_runtime_ssh.rs`, `tool_pull_request.rs`) |
| med | Failed MCP handshake leaks spawned server child | `core/mcp_client.rs:120` |
| med | grep tool compiles model-supplied regex, no ReDoS guard (stalls all sessions) | `openai-agents.ts:924` |
| med | Failed data-dir migration silently discards all persisted state | `core/storage.rs:146` |
| med | Parse failure resets to default, then persisted over recoverable JSON | `core/storage.rs:169` |
| med | Non-atomic state replace can lose state on crash; `.bak` never read | `core/storage.rs:519` |
| med | Global `SUBAGENT_DEPTH` shared across concurrent conversations | `core/tool_subagent.rs:113-135` |
| med | Remote SSH tool paths not protected against symlink escape | `core/execution.rs:238-266` |
| med | `delete_api_key` leaves legacy keyring entry — keys resurrect | `commands/api_keys.rs:127` |
| med | Codex `stream_error` dead-coded, never surfaced | `openai-codex.ts:809` |
| med | `truncateToLimit` O(n²) byte-length recompute on large output | `openai-agents.ts:116` |
| low | Wake into Awake planner resets per-tick cap + double-injects | `commands/flight_planner.rs:1658` |
| low | Oneshot summarizer waiter leaked when `forward_start` fails | `commands/flight_planner_compaction.rs:149` |
| low | In-process stream task detached (not aborted) on cancel | `commands/api_agent.rs:1299-1357` |
| low | Auth-watcher leading-edge debounce drops trailing/final state | `commands/auth_watcher.rs:201` |
| low | bash tool kills only shell, leaks grandchildren on timeout | `openai-agents.ts:877` |
| low | `set_ssh_password` accepts empty password → blank interactive auth | `commands/ssh_keys.rs:53` |
| low | Token counters use unchecked `+=` (overflow/wrap on hostile usage) | `commands/api_agent.rs:1389-1392` |
| low | `decode_terminal_chunk` grows `pending` unbounded on invalid UTF-8 | `core/pty.rs:55` |

---

## Team B — Frontend (React + TS) · 22 verified findings

**Synthesis:** Structurally sound but a consistent class of latent defects clustered in async lifecycle and the in-process/sidecar event contract. Highest-impact: failure-path gaps in agent/deploy pipelines that optimistically render active state then await a backend call with no rejection handling (perpetual spinner / pinned "running"); plus failed deploys shown green from a last-writer race. One real security gap (async SSH silent TOFU) and one functional bug (wrong Gemini npm package). Remainder is convention drift and small race/leak cleanups. 7 medium, 15 low.

| Sev | Title | File |
|-----|-------|------|
| med | DeployTerminal hardcodes exit 0 → failed deploys marked success | `views/DeployTerminal.tsx:100-104` |
| med | Deploy output/exit lost in startup race (stuck "running") | `stores/deployStore.ts:128` |
| med | Async launch permits SSH to unpinned hosts (silent TOFU) | `flights/LaunchAsyncFlightModal.tsx:41-50` |
| med | `retryLastTurn` permanent spinner if backend retry rejects | `stores/agentTaskStore.ts:1463` |
| med | `createApiConversation` failure leaves empty streaming bubble | `stores/agentTaskStore.ts:951` |
| med | `runTransientPty` leaks PTY if listener setup throws | `hooks/useTransientPty.ts:228` |
| med | Wrong npm package for remote Gemini CLI install | `lib/ssh.ts:118` |
| low | Auto-pick provider probe overwrites manual selection | `views/AgentsView.tsx:99` |
| low | PendingEdit Apply overwrites from stale snapshot, clobbers external edits | `agents/PendingEditPrompt.tsx:190` |
| low | PR diff renders under wrong PR header on fast switches | `stores/githubStore.ts:595-609` |
| low | Async launch displays raw prompt but sends memory-augmented one | `stores/asyncFlightStore.ts:450` |
| low | NewFlightModal drops forward-reference task dependencies | `flights/NewFlightModal.tsx:58-69` |
| low | Hardcoded "PacketBench" in StatusStrip | `layout/StatusStrip.tsx:160` |
| low | Hardcoded brand string in autoCommitTrailerFormat default | `lib/tauri.ts:1440` |
| low | Tab "+" dispatches events with no listener (dead control) | `layout/SessionTabBar.tsx:15` |
| low | mcpProviderStore writes localStorage directly, bypasses brand helpers | `stores/mcpProviderStore.ts:90` |
| low | layoutStore hardcodes `packetbench:` workspaces-cache key | `stores/layoutStore.ts:74` |
| low | PromptLibrary clipboard write unhandled, no failure feedback | `workspace/PromptLibrary.tsx:86-88` |
| low | failoverGuard Set entries never removed on deleteConversation | `stores/agentTaskStore.ts:318` |
| low | Redundant SSH workspace payload built then discarded by both backends | `lib/tauri.ts:2457` |
| low | Redundant no-op branch in attempt worktree path selection | `stores/asyncFlightStore.ts:439` |
| low | (+1 minor dead-code cleanup) | — |

---

*Full per-finding evidence and adversarial-verification verdicts are in the workflow transcript:* `C:\Users\IANWAL~1\AppData\Local\Temp\claude\D--projects-PacketBench\8ce5ddab-...\tasks\w5qcvnl5p.output`
