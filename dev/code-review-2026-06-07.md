# PacketADE — Multi-Agent Code Review & Remediation Plan (2026-06-07)

> **How this was produced.** Three-round subagent review: 10 subsystem deep-passes
> + 10 cross-cutting lens passes generated 61 raw findings → deduped to **59 canonical**.
> Each was then put through an adversarial "debate" (a verifier opened the cited code and
> tried to *refute* it). A second throttled run refilled the 5 subsystem passes that the
> first run lost to rate-limiting, surfacing **37 additional findings**.
>
> **Result: 52 of 59 (F-series) confirmed, 6 refuted, 1 uncertain. The 37 new G-series
> findings then went through a full 3-vote panel: 31 confirmed, 6 refuted.**
> **~83 real defects total.** Severities below are **post-debate** (some downgraded once a
> verifier checked real-world impact).

---

## 0. Why scans kept saying "fine" — the systemic root causes

These are the patterns that recur across the codebase. Fixing the *pattern* matters more
than any single finding — every one of these produced multiple independent bugs.

1. **Spawn-and-forget: subprocesses are never reaped and exit codes are never captured.**
   PTY children (F01), the Node sidecar (G01), and the deploy child (F13) are all dropped
   without `wait()`/`kill_on_drop`. Worse, **orchestration decides task success by *whether*
   a process exited, not *how* it exited** (G23, G24) — so a crashed/failed agent rolls the
   milestone up to **Done**. This is the single biggest blind spot: *the app cannot tell
   success from failure of a child process.*

2. **Migrations that delete the old data before the new write is confirmed durable.**
   F09 (keyring), F10 (Gemini key), F44 (localStorage), F56 (SSH targets). Same shape four
   times → permanent secret/data loss on any write hiccup.

3. **Cancellation reuses the `done` event with no "cancelled" marker.** G08, G33, G36, F27.
   Stop is indistinguishable from natural completion, so cancelling re-sends queued messages,
   fires "completed" notifications, and surfaces spurious errors.

4. **`try_lock` / best-effort routing that silently drops on contention.** F26 / G04 / G05 —
   sidecar-owned sessions get misrouted to the in-process path and the user's message
   vanishes with "No active session".

5. **Stream parsers assume one-at-a-time, well-formed input.** F02 (one bad byte freezes a
   terminal forever), F46 (UTF-8 split across chunks), G16 (parallel tool calls collapse),
   G18 (empty assistant message poisons Anthropic history), G10 (Codex text duplicated).

6. **Shared-file writes are non-atomic and clobber on partial failure.** F19/F20/F21 (the
   shared `~/.claude/settings.json`), F15 (no fsync of backup or parent dir).

7. **State authority is split between localStorage and the backend.** F48/F49/F52 (flight↔issue
   refs drift, status never recomputes), F50 (duplicate pane IDs collide), F51 (hydrate
   clobbers optimistic writes).

8. **Listeners/resources not cleaned up on terminal states.** F36 / G32 (12 listeners leaked
   per finished conversation — the *common* case), F37, F38 (mic), G06, G26 (worktrees).

9. **Security: validate-but-don't-enforce, or unescaped interpolation.** F40 (web_fetch is an
   open SSRF), F41 (commit-trailer template → shell injection), F42 (model download has no
   checksum). *(Note: F07/F08 SSH host-key pinning were **refuted** — pinning is genuinely
   enforced.)*

---

## 1. Refuted — do NOT spend time on these

The debate confirmed these are *not* real bugs (or are intended/protected behavior):

| ID | Claim | Why it's refuted |
|----|-------|------------------|
| F07 | API-agent SSH skips host-key pinning | Pinning **is** applied on these paths; fail-closed holds. |
| F08 | `host_fingerprint` is decorative | The fingerprint is genuinely compared at connect, not just `.is_some()`. |
| F14 | Bulk save wipes `mission_approvals` | Approvals are preserved like issues/retros. |
| F30 | `with_state_lock` deadlock foot-gun | No live caller holds the guard across a real await. |
| F31 | Chunk listeners corrupt two coexisting streams | Two streaming assistant bubbles don't actually coexist in practice (see G37 — latent only). |
| F45 | Migration guard blocks future migrations | The `getItem(newKey)` check already makes it idempotent. |
| F59 | prune-sidecar "symlink-free" wording | **Uncertain** — wording nit only; low value. |
| G12 | Sidecar `emit()` ignores stdout backpressure | Only 1/3 verifiers found it real; bounded in practice. |
| G19 | `finish_reason "stop"` in tool-call finalization | 0/3 — harmless given the `!current_tool_id.is_empty()` guard. |
| G22 | Cache-token cost double-counted | 0/3 — `pricing::calculate_cost` already applies the cache-read rate. |
| G27 | Cross-milestone task deps never resolve | 1/3 — deps are resolved against the full task set, not just the milestone. |
| G28 | Attempt status overrides task status on hybrid flights | 0/3 — flights don't actually mix attempts + milestones in practice. |
| G37 | No single-flight guard on `AgentChatPane.handleSend` | 0/3 — two streaming bubbles don't coexist (same root as F31). |

---

## 2. Confirmed HIGH-severity (fix first)

| ID | Title | Location | Fix |
|----|-------|----------|-----|
| **F02** | One invalid UTF-8 byte freezes a terminal forever (unbounded `pending` growth) | `core/pty.rs:55-76` | Use `Utf8Error::error_len()`: emit U+FFFD + advance on `Some(n)`; only carry on `None`; cap `pending`. |
| **F13** | Deploy run stuck as "running" forever on a non-broken-pipe read error (EIO) | `commands/deploy.rs:288-325` | Move `child.wait()` + `deploy:exit` into a dedicated thread; break the read loop on EIO. |
| **F19** | MCP write clobbers the **entire shared** `~/.claude/settings.json` on a transient parse failure | `commands/mcp.rs:42-55,139,167` | Bail with `Err` on parse failure on the write path; distinguish absent vs unparseable; atomic write. |
| **F20** | Editing an MCP server drops `disabled`/`type`/`url`/`headers` — re-enables disabled, corrupts SSE/HTTP | `commands/mcp.rs:148-160` | Read-modify-merge preserving `disabled` + unknown keys; round-trip transport fields. |
| **F40** | `web_fetch` is an unrestricted SSRF primitive (no private-IP/metadata block, follows redirects) | `core/tool_web.rs:38-98` | Reject loopback/link-local/ULA/RFC1918 (incl. `169.254.169.254`); re-validate after redirects; consider approval gate. |
| **F50** | `wsCounter` pane-id generator not reconciled after hydration → duplicate pane IDs collide | `stores/workspaceStore.ts` | Use `crypto.randomUUID()` for pane ids, or reconcile `wsCounter` to max-existing after hydrate. |
| **F53** | Cross-arch builds bundle the **wrong native sidecar binary** → sidecar crashes on target | `scripts/prune-sidecar.js:171-193` | Make prune target-aware (read triple, pass `supportedArchitectures`/`--os`/`--cpu`); release-gate assert the native pkg exists. |
| **G01** | Sidecar child (+ its MCP/Codex/Claude grandchildren) **orphaned on app exit** (no `kill_on_drop`, no exit handler) | `agent_sidecar/supervisor.rs:559-573`; `lib.rs:418` | `kill_on_drop(true)` on local+remote spawns; add `RunEvent::ExitRequested` → `SidecarManager::shutdown()`; Windows Job Object. |
| **G02** | Transient sidecar restart silently loses in-flight turns & **bricks existing sessions** (no fan-out, `owned_sessions` not cleared) | `agent_sidecar/supervisor.rs:419-512` | On every child exit, fan out a recoverable `api-agent:error` to owned sessions and clear them before restarting. |
| **G09** | Codex `respondPermission` writes approvals to a stdin `codex exec` doesn't read → approval hangs the turn | `providers/openai-codex.ts:895-929` | Verify the real codex-exec approval protocol; if unsupported, disable on-request approvals for Codex or add a deny-and-continue watchdog. |
| **G16** | OpenAI-compat **parallel tool calls collapse/cross-contaminate** (`index` field ignored) — affects openai/minimax/openrouter/ollama _(panel split severity high/med/low; real bug, impact depends on how often parallel tool calls fire)_ | `core/llm_openai_compat.rs:226-343` | Accumulate tool calls keyed by streamed `index`; flush all on finish in index order (mirror Anthropic block tracking). |
| **G23** | Orchestrated PTY task success decided by **exit reason, not exit code** → failed agents recorded as Done | `useTerminalSession.ts:290-293` + `pty.rs:334` | Capture child exit status in `pty.rs`, include it in `pty:exit`; map non-zero → `success=false` before `onTaskComplete`. |
| **G25** | Async Flight attempt has **no terminal transition** on agent done/error → stuck "running" forever, blocks future launches | `flights/AttemptTile.tsx:59-92` | Subscribe to `api-agent:done`/`:error`: done-without-sentinel → `reviewing`, error → `failed`. Don't rely on in-text sentinel only. |
| **G32** | `deleteConversation` **leaks all 12 api-agent listeners** for done/failed conversations (the common case) | `stores/agentTaskStore.ts:1142-1182` | Detach listeners unconditionally for `mode==="api"`; gate only the cancel/close backend calls on active/idle. *(supersedes F36)* |
| **G33** | Clicking **Stop** with queued messages re-sends them (cancel emits `done`, which drains the queue) | `agentTaskStore.ts:1227-1249` + `apiAgentListeners.ts:216-261` | Clear `queuedMessages` in `cancelActiveConversation`, or carry a `cancelled` flag so the drain is skipped. |

---

## 3. Confirmed MEDIUM-severity

| ID | Title | Location |
|----|-------|----------|
| F01 | `kill_pty`/`kill_sessions` leak zombie children on Unix (never reaped) | `commands/pty.rs:393-410,117-128,329-331` |
| F06 | Keyring host password forwarded to remote stdin on ControlMaster-reused SSH | `core/tool_runtime_ssh.rs:106-138` |
| F09 | Keyring migration deletes legacy credential even when the new write fails | `api_keys.rs:55-61`; `ssh_keys.rs:38-44` |
| F10 | Gemini key migration deletes localStorage in a `finally` even when keyring write throws | `tools/GeminiApiKeyCard.tsx:24-33` |
| F11 | Password auth writes to ssh stdin, which OpenSSH does not read | `core/tool_runtime_ssh.rs:128-138` |
| F16 | Leading-edge auth-watcher debounce drops the authoritative cred write → badge stuck `login_required` | `auth_watcher.rs:201-211` |
| F23 | `DeployConfig.env` is typed end-to-end but **never applied** to the spawned command | `deploy.rs:9-15,220-264` |
| F24 | Deploy runs cannot be cancelled (no kill handle, no `kill_deploy`) | `deploy.rs:266-327` |
| F28 | `send`/`retry` overwrite the in-process cancel sender, silently cancelling a running turn | `api_agent.rs:701-724,1015-1037` |
| F32 | Failed API `sendMessage` leaves the bubble spinning forever (`isStreaming` never cleared) | `agentTaskStore.ts:1072-1098` |
| F33 | Orchestration scheduler silently swallows backend tick failures | `orchestrationSchedulerStore.ts:47` |
| F34 | `update_task` `target_spec` patch reported as landed but silently dropped (false success to planner) | `mission_planner_tools/update_task.rs:135-144` |
| F38 | `useVoiceInput` never stops recognition/native recording on unmount (mic leak) | `hooks/useVoiceInput.ts:63-153` |
| F44 | `migrateLegacyStorage` mutates localStorage while iterating by index → can lose keys | `lib/storage-migration.ts:19-31` |
| F46 | Streamed UTF-8 multibyte chars corrupted when split across network chunks (both streamers) | `llm_anthropic.rs:213`; `llm_openai_compat.rs:234` |
| F48 | FlightDetail unlink clears `issue.flightId` but not `flight.issueIds` → status desync | `flights/FlightDetail.tsx:173` |
| F49 | Flight status never recomputes when an issue changes (no `issueStore` subscription) | `FlightList.tsx`, `MissionsView.tsx` |
| F51 | Event-driven `flightStore.hydrateFromBackend()` clobbers in-flight optimistic mutations | `flightStore.ts:688-698` |
| F52 | `issueStore` is localStorage-authoritative, never hydrated, writes a lossy subset to backend | `issueStore.ts:203-237` |
| F55 | `FlightStatus` contract test asserts a hand-kept length, missing `spec` variant | `__tests__/contract.test.ts:167-180` |
| F56 | SSH-target→serverStore migration is untested and deletes legacy keys before the async save lands | `lib/sshTargetMigration.ts:80-106` |
| G03 | `truncate()` can panic on a multibyte UTF-8 boundary, killing the reader loop | `agent_sidecar/handler.rs:933-939` |
| G08 | Codex cancel surfaces a spurious **error** banner instead of clean cancellation _(panel: high→medium)_ | `providers/openai-codex.ts:458-483` |
| G10 | Codex treats `agent_message_delta` and `agent_message` identically → duplicated assistant text | `providers/openai-codex.ts:543-560` |
| G11 | Anthropic `respondEdit` resolves **all** pending edits on one response (wrong target, `mergedContent` to all paths) | `providers/anthropic.ts:1029-1071` |
| G17 | Token/cost always **zero** for MiniMax & Ollama (`include_usage` gated to openai/openrouter) | `llm_openai_compat.rs:178-180` |
| G18 | Empty assistant message persisted to history → Anthropic 400s on the next turn (poisons session) | `api_agent.rs:1429-1460` |
| G24 | Backend-initiated PTY kill (pause/cancel flight) reported to frontend as a **successful** task completion | `orchestration.rs:131-136,190-195` |
| G26 | Worktree leak when API session fails to start after the attempt is persisted | `flight_attempts.rs:646-685` |
| G32 | `deleteConversation` **leaks all 12 api-agent listeners** for done/failed conversations (the common case) _(panel: high→medium; supersedes F36)_ | `stores/agentTaskStore.ts:1142-1182` |

---

## 4. Confirmed LOW-severity (batch when touching the area)

F03 (onSessionEnded double-fire on kill) · F04 (transcript-replay dedupe unsound) ·
F05 (`resolve_windows_command` fabricates `.cmd`) · F12 (remote `mkdir -p` before symlink
confine) · F15 (`write_with_backup` no fsync) · F17 (first-ever login badge miss) ·
F18 (locked cred store → "missing key") · F21 (MCP writes non-atomic) · F22 (DeployTerminal
misses early output) · F25 (deploy output array unbounded) · F26 (owns_session race — see G04) ·
F27 (cancel_pending_tools cross-session drain) · F29 (provider_stats lost-update) ·
F35 (usage write `let _ =` swallow ×4) · F37 (close session leaves orphaned oneshots) ·
F39 (DeployTerminal listener leak on fast unmount) · F41 (commit-trailer → shell injection) ·
F42 (Whisper model no checksum) · F43 (`active_form` snake_case vs `activeForm`) ·
F47 (final SSE line dropped) · F54 (release-gate hardcodes Windows triple) ·
F57 (ssh pinning branch untested) · F58 (rate-limit backoff clamp untested) ·
G04 (owns_session try_lock misroute, _panel: med→low_) · G05 (session forgotten on transient writer error, _panel: med→low_) ·
G06 · G07 · G13 · G14 · G15 · G20 · G21 · G29 · G30 · G31 ·
G34 (auto-failover notice truncated, _panel: med→low_) · G35 · G36
(see appended JSON for full detail on each).

---

## 5. Recommended fix order

**Batch A — Data-loss & corruption (do immediately):**
F19, F20 (shared settings.json), F09, F10, F44, F56 (migration delete-before-confirm),
F48/F52 (state authority), G18 (poisoned Anthropic history).

**Batch B — "It silently failed" (orchestration trust):**
G23, G24 (exit-code vs exit-reason), G25 (stuck attempts), F13 (stuck deploy), F33/F34
(swallowed failures), G02 (sidecar restart bricks sessions).

**Batch C — Cancellation semantics (one root fix):**
Add a `cancelled` marker to the done/cancel path, then G33, G36, G08, F27, F28 mostly fall out.

**Batch D — Streaming correctness:**
F02, F46, G16, G10, G17.

**Batch E — Leaks & lifecycle:**
G32/F36, G01, F01, F37, F38, G26, F25.

**Batch F — Security hardening:**
F40 (SSRF), F41 (injection), F42 (checksum), F06 (password-on-reuse).

**Batch G — Build/release & tests:**
F53, F54, F55, F57, F58, F43, F47.

---

## 6. Caveats on this review

- The first run's adversarial debate was destroyed by API rate-limiting; the severities and
  refutations above come from the **second, throttled** run (1 verifier per finding, sequential
  batches of 6). Single-verifier verification is less robust than a 3-vote panel — treat the
  6 refutations as "high-confidence not-a-bug" but spot-check before discarding if cheap to verify.
- The 37 G-findings **have** now been through a full 3-vote panel (reachability / refutation /
  severity lenses). 31 confirmed, 6 refuted (G12, G19, G22, G27, G28, G37 — see §1). The strongest
  highs (G01, G02, G09, G23, G25, G33) were confirmed 3/3 with severity held; G08 and G32 were
  downgraded high→medium; G16's severity was split (real bug, impact scales with parallel-tool-call
  frequency).
- Full evidence/reasoning for every finding is in the workflow output JSON
  (`tasks/w1us3uxbo.output`, `tasks/wzk2vbobc.output`, `tasks/wpsddw4i9.output`).
