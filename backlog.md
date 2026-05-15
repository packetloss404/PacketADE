# Backlog

Master source for outstanding work in PacketADE. When an item ships, move it
to the matching version section in [`CHANGELOG.md`](./CHANGELOG.md) and remove
it from here.

Priority: **P1** = real bug or major user-facing gap · **P2** = correctness/UX
· **P3** = cleanup.

## SSH & remote workspaces

- **P1 — Remote-workspace consumer sweep.** `workspace.projectPath` is
  overloaded to hold either a local or remote path (for label-compat).
  Several consumers still treat it as a local FS path: Scout in
  `IdeaCard.tsx:26` and `IdeaDetail.tsx:25` currently rely on upstream
  `IdeationView` gating. Either type the union properly
  (`projectPath` vs `remoteProjectPath`) or guard every consumer with
  `if (!workspace.serverId)`.
- **P1 — Sidecar-over-SSH (Phase 4.1).** Biggest remaining user-facing gap.
  The stdio JSON protocol in `agent-sidecar/src/protocol.ts` is
  transport-agnostic by design; in
  `src-tauri/src/commands/agent_sidecar.rs::forward_start`, swap local
  `node` for `ssh <host> /path/to/bundled-node
  /path/to/bundled-sidecar/index.js`. Payoff: Anthropic (Subscription) and
  OpenAI (ChatGPT) providers work against remote codebases. Currently
  hard-blocked by the Phase 1.1 error gate.
- **P2 — Misleading "Path will be created" copy.** `WorkspaceCreationModal`
  promises the path will be created on workspace start; nothing actually
  `mkdir -p`s it. Either add the mkdir over SSH on first launch, or revise
  the copy.
- **P2 — `ssh_check_remote_path` doesn't use saved keychain password.** For
  password-auth servers the probe fails unless the FE retrieves the password
  first. Fix: pull from keyring by `target_id` when auth method is
  `password` and no inline password is supplied.
- **P2 — Password-auth migration silently downgrades to "agent".**
  `src/lib/sshTargetMigration.ts:67-70` forces
  `authMethod: keyPath ? "key" : "agent"`. Legacy users with
  keyring-stored SSH passwords lose that method. Fix: also call
  `getSshPasswordExists(id)` during migration.
- **P2 — Read-only remote git dashboard.** Phase 3.3 disabled commit / push /
  pull / branch. Add `git_commit_remote`, `git_push_remote`,
  `git_pull_remote`, `git_create_branch_remote`. The `validate_branch_name`
  helper in `src-tauri/src/core/git.rs` is reusable.
- **P2 — MCP servers over SSH (Phase 4.2).** `build_mcp_config_for_sidecar`
  hardcodes local paths.
- **P3 — Consolidate duplicate `CloneServerConfigDto` and
  `GitServerConfigDto`** (byte-identical;
  `src-tauri/src/commands/scaffold.rs:23-32` vs
  `src-tauri/src/commands/git.rs:120-129`).
- **P3 — `clone_repo_remote` has no frontend caller.** Surface a "Clone to
  remote workspace" action in `WorkspaceCreationModal` / ServersView, or
  remove the binding.
- **P3 — Sidecar-providers list drift.** Frontend `SIDECAR_AGENTS`
  (`src/components/agents/AgentInputArea.tsx:116`) is hand-mirrored from
  backend `SIDECAR_PROVIDERS`
  (`src-tauri/src/commands/agent_sidecar.rs:36`). Codegen or expose via a
  `list_sidecar_providers` Tauri command.
- **P3 — Dead Tauri commands.** `set_ssh_password`, `delete_ssh_password`,
  `get_ssh_password_exists`, `ssh_test_connection` have no remaining TS
  callers. Either remove or repurpose for the password-auth probe above.
- **P3 — Rename `target_id` → `server_id` across the wire.** Field name
  kept for in-flight back-compat (see `src/lib/tauri.ts:1331-1336`).
- **P3 — `resumeApiConversation` partial live-config lookup.** Resolves
  `port` / `keyPath` / `hostFingerprint` from live `ServerConfig` but uses
  persisted `host` / `user` / `remotePath`. If a user renames or repoints
  the server, resume hits the old host.
- **P3 — Sentinel rename.** `src-tauri/src/commands/pty.rs:498`
  `PACKETCODE_SSH_OK` and `src-tauri/src/core/tool_runtime_ssh.rs:132`
  `PACKETCODE_EOF_*` still use the old brand.
- **P3 — `cancel_flight_attempt` fingerprint asymmetry**
  (`src-tauri/src/commands/flight_attempts.rs:330-342`) — cleanup deferred
  to FE, which carries fingerprint correctly.
- **P3 — No unit test for `sshTargetMigration.ts`.**
- **P3 — Heredoc terminator predictability** — use random hex suffix
  instead of unix-nanos.
- **P3 — `keyPath` argv hygiene** — reject paths with non-printable / shell
  metacharacters at `ServerFormModal` save.
- **P3 — SFTP / port-forward / file size cap (Phase 4.3).** Files currently
  cap at 2 MB (`src-tauri/src/core/tool_runtime_ssh.rs:10`).
- **P3 — Windows-OpenSSH remote hosts.** `ssh_check_remote_path` and the
  remote git commands use POSIX `[ -e ... ]` / `git -C` — fine on Unix
  remotes, breaks on Windows OpenSSH targets.

## Platform & distribution (from `docs/`)

Deferred items called out in `dev/multi-platform-build.md` and
`dev/updater-setup.md`. These are ops/release tasks, not feature work.

- **P2 — Auto-updater (full)** — Tauri v2 updater is intentionally not wired
  up. Requires a signing keypair (offline), an HTTPS-hosted signed
  `latest.json` manifest + release pipeline, and a UI surface for the update
  prompt. Runbook in [`dev/updater-setup.md`](./dev/updater-setup.md).
  Until then, PacketADE remains a manual-install app.
- **P2 — macOS code signing + notarization.** Apple Developer ID required;
  unsigned local builds need `xattr -cr` workaround per
  `dev/multi-platform-build.md:101-104`. Pairs with `notarytool` for
  distribution-grade DMGs.
- **P2 — Windows Authenticode signing.** Same shape as macOS — unsigned
  installers throw SmartScreen warnings on first run.
- **P3 — Snap and Flatpak packaging for Linux.** Today Linux ships AppImage
  + DEB only. Snap/Flatpak would broaden distro reach.
- **P3 — Cross-compile Windows from macOS / Linux** (or macOS from non-Mac).
  Not supported by the current setup — use native runners. Track as a
  "won't-fix until release matrix demands it" item.

## Mission Planner v1.1 (deferred from `dev/mission-planner-plan.md`)

- **P2 — Helper planner escalation.** Primary planner can call
  `spawn_helper_planner(scope, reason)` to delegate heavy decomposition
  to a one-shot Opus 4.7 session. Cap: 1 successful spawn per mission;
  failed-to-start doesn't count. Helper output ingested back into the
  primary's next turn as `<helper_output>…</helper_output>`. Stub in v1
  returns `"deferred to v1.1"`; full implementation belongs to v1.1
  alongside any "scope too big" missions that surface the need.
- **P3 — Back-port milestone-gating + file-collision detection to the
  async-attempts path.** v1 routes planner-emitted tasks through
  `asyncFlightStore.launchAsync` (worktrees + `claude-oauth` API-agent
  sessions). The PTY orchestrator's pause-between-milestones and
  collision-block features in `src-tauri/src/core/orchestrator.rs`
  don't exist on the async path; bring them across so planner-owned
  flights get the same coordination safety.
- **P3 — Predictive quota awareness.** v1 quota safety is reactive:
  catches `RateLimitError` and pauses. If `@anthropic-ai/claude-agent-sdk`
  ever exposes the `anthropic-ratelimit-*` response headers, switch to
  predictive — pause *before* the cap.
- **P3 — Subscription-% display for OAuth planner cost.** Currently no
  public Anthropic endpoint surfaces Claude.ai subscription usage. E8
  partially addresses this by surfacing the cumulative planner token
  count on the StatGrid Planner cell (sub-line `≈Nk tokens` when
  `plannerProvider === "claude-oauth"`), but there is still no
  percentage-of-quota readout. Revisit if/when Anthropic exposes an
  endpoint.
- **P3 — Crash-resilient planner sessions.** v1 planner sessions are
  ephemeral; on app restart, `active` missions flip to `paused` and
  require a user click to resume. Persist `lastResumeToken` and
  rehydrate on cold start.
- **P3 — Rollback optimistic transcript on `injectTurn` failure.**
  `missionPlannerStore.injectTurn` optimistically appends a user
  transcript entry before the backend call. If the invoke errors, the
  phantom message stays on screen. Add a rollback on rejection.
- **P3 — Replace `try_sidecar_session_for` async lock.** Currently
  uses `try_lock` and returns `None` silently on contention. Cheap
  E2 footgun. Switch to the async lock or remove until needed.
- **P3 — Cap wake-debounce total drain time.** `WAKE_DEBOUNCE_MS` is
  a per-burst window; a steady drip can keep the window open
  indefinitely. E6 should add a hard ceiling on total drain time so
  the planner can't be starved by adversarial event cadence.
- **P3 — Escape `</wake_trigger>` literal in content body.** Sidecar
  sanitizes the `kind` attribute but not the wrapped content; a user
  typing literal `</wake_trigger>` in a journal message could break
  the envelope. Non-exploitable today (frontend path uses
  `source="user"` which doesn't wrap), but harden when the path
  exists.
- **P3 — `now_millis()` duplicated across 6 tool files.** Hoist to a shared
  helper in `commands::mission_planner_tools::mod.rs` or reuse the one in
  `mission_planner.rs`.
- **P3 — `PersistedStateDto → core::PersistedState` round-trip drops
  `mission_approvals`.** Fine today (settings-only path), but a debug_assert
  or stronger guard would prevent future silent loss if a different code
  path uses the round-trip.
- **P3 — Milestone DTO bump.** E2-MILE stashes the tool's `goal` field in
  `Milestone.description` and `dependencies` in `Milestone.validation_criteria`
  because no proper fields exist. Add `goal: String` and `dependencies: Vec<String>`
  to `Milestone` and migrate.
- **P3 — `update_task` `target_spec` patch acked-but-not-persisted.**
  Handler accepts the key, reports it in `updated_fields`, but no Task field
  carries it. Either persist on the Task or reject the key.
- **P3 — `update_task` re-queue doesn't re-launch attempt.** A planner that
  flips a task back to Queued has no way to actually re-run it. Either
  reject the Queued transition or wire it to spawn a new attempt.
- **P3 — `complete_mission` schema strictness mismatch.** Sidecar zod
  requires `summary.min(1)`; Rust accepts empty via `#[serde(default)]`.
  Tighten Rust or relax zod.
- **E3 prereq — `get_mission_approvals(missionId)` Tauri command for
  cold-start hydration.** Frontend store populates `pendingApprovals` only
  via event listeners installed at startPlanner. If a mission has pending
  approvals before the listener attaches (paused mission resume, page
  reload), they're invisible. E3 must add this command before mounting
  MissionSpecPane.
- **P3 — `read_conversation_tail` whole-file load.** Currently
  `core::mission_planner_prompts::read_conversation_tail` reads the entire
  conversation file into memory before slicing the last N lines. For
  long-running sessions accumulating megabytes of JSONL chunks this is
  wasteful. Stream-and-tail via `Seek::seek` from end + back-scan for
  newlines would be safer.
- **P3 — Planner `replanCount` data source mismatch.**
  `core::mission_planner_prompts::render_task_failed` displays "Replan
  budget: X/3 used" by reading `replanCount` off the Task DTO. The
  authoritative counter lives in `MissionPlannerSession.replans_per_task`
  on the registry, NOT on the DTO. E5 must either mirror the count onto
  the Task DTO before firing the TaskFailed wake, or change the renderer
  to take the count as an explicit argument from `build_wake_payload`.
  Currently the readout always shows `0/3`, defeating cap awareness.
- **P3 — Tighten `session_id` path-escape guard.** Today's regex allows
  Windows drive-relative paths like `C:foo`. Tighten to UUID-only:
  `session_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')`.
- **P3 — Focus textarea on starter-prompt click.** `MissionSpecPane`
  pills populate the input but don't focus the textarea. One-line fix.
- **P3 — Tighten async-approval prompt-content test.** The current test
  accepts "continue" as a "don't-block" token; "continue" appears often
  in any 2000+ char prompt and is false-positive-prone. Require
  `"pending_approval"` AND ("don't block" OR "do not block" OR
  "immediately") for a more reliable assertion.
- **P3 — Surface `replan_count` in wake payload directly.** Today the
  wake builder reads from the snapshot. Plumbing the count explicitly
  through `PlannerWakeEvent.payload` would decouple the renderer from
  DTO mirroring assumptions.
- **P3 — Rate-limit auto-resume doesn't re-fire the dropped wake.**
  When a `rate_limited` event arrives mid-wake, the wake content is
  dropped on the floor and the auto-resume timer only flips status to
  Idle. The planner sits Idle until another orchestration event fires.
  For "rate-limited mid-decomposition" the mission stays half-planned.
  Re-emit the most recent dropped wake on resume.
- **P3 — 529 Overloaded not detected as rate-limit.**
  `isLikelyRateLimitError` matches 429 / `rate_limit_error` / name=
  `RateLimitError`. Anthropic's 529 Overloaded passes through as a
  generic error — planner sees error + no QuotaPaused. Worth handling
  in v1.1; acceptable v1.
- **P3 — `on_planner_done` + `on_rate_limited` auto-resume don't emit
  `mission-planner:status-changed` events.** E6 Fix 3 added
  `set_status_and_emit` helper but only opted-in `pause_mission_planner`,
  `resume_mission_planner`, and `inject_planner_turn`. The Awake→Idle
  transition (watchdog) and Idle-after-quota-resume mutate
  `session.status` directly inside the sessions mutex without firing
  the Tauri event, so the frontend `runtime.status` lags those flips
  until another emission triggers a refresh. Swap those two call sites
  to also emit. (Note: the watchdog mutation runs INSIDE the mutex —
  factor the emit so it fires AFTER the lock is released.)
- **P3 — Tool-call cap counter message ergonomics.**
  After breaching, every subsequent rejected call increments the
  counter, so the planner sees `count={n}` growing. Either clamp to
  `count=cap+1` in the rejection message or stop bumping on rejection.
- **P3 — Journal entry incremental fetch.** Today every `journal-appended`
  event causes `JournalTab` to refetch the whole file. On a chatty planner
  turn (~5-20 events), that's 5-20 full reads. Add a `read_journal_after(
  mission_id, last_entry_id) -> Vec<JournalEntry>` Tauri command that
  parses the HTML-comment headers to find the cut point. Use it in
  JournalTab to append-only the new content.
- **P3 — Journal file size cap.** `read_journal` loads the whole file
  into memory each fetch. Pair with the incremental-fetch follow-up to
  add a max-bytes safeguard or pagination so very long missions don't
  pin megabytes in RAM.
- **P3 — Journal path-convention drift.** `mission_journal::journal_path`
  produces `F-<shortId>_<mission_id>.md`; locked spec says `<shortId>.md`.
  The drift was for collision-resistance (4-char shortId has 65k slots).
  Confirm with owner whether to trim to spec or amend the spec doc.
- **P3 — `format_timestamp` could format in Rust.** Today journal headers
  emit raw unix-millis and JournalTab post-processes via JS Date(). If
  another consumer (CLI viewer, external markdown processor) opens the
  file directly, they see raw millis. Adding `chrono` (~10 lines) or
  hand-rolling YYYY-MM-DD HH:MM:SS in Rust would make the file readable
  in any markdown viewer.
- **P3 — Markdown injection from tool args.** Tool-call entries serialize
  `args` as JSON inside markdown blocks. If a tool arg contains
  `<!-- entry id:fake -->`, a future structured parser of the journal file
  could be confused. `MarkdownRenderer` doesn't enable raw HTML so the
  UI is safe, but the on-disk parser invariant is fragile. Escape
  HTML-comment-looking content inside body strings.
- **P3 — Approval-resolution journal entry.** `resolve_mission_approval`
  currently emits a `SystemNote`. Could be `ApprovalRequest` updated
  in-place, or a dedicated `ApprovalResolution` kind. For v1 the
  SystemNote is fine; for v1.1 consider promoting.
- **P3 — Cost-split implicit invariant (`totalCost ≥ plannerCost`).**
  After E8 the StatGrid derives `executorCost = totalCost - plannerCost`
  and clamps to zero via `Math.max(0, …)`. The clamp protects the UI
  but hides a backend bug if the invariant ever inverts. Two options:
  (a) explicitly store `executorCost` on the Flight DTO so subtraction
  isn't load-bearing, or (b) add a debug-assert / log when the
  invariant breaks. Today neither side enforces it.
- **P3 — Cost dashboard planner/executor split.** The `CostDashboardView`
  aggregates cost across missions but does not distinguish planner spend
  vs executor spend. Post-E8 the data is present on every Flight
  (`plannerCost` + derived `executorCost`); surface the split in the
  dashboard so a user can see how much of the bill is the planner.
- **P3 — Export `StatGrid` from `MissionsView` for direct unit tests.**
  E8-TESTS currently mounts `MissionsView` end-to-end (mocking six
  stores and five child components) to assert the cost-split cells.
  Exporting `StatGrid` would let those tests drop most of the mock
  surface and render the helper directly. Same applies to
  `FlightDetailPane` if more cell-level tests appear.
- **P3 — Executor cost accumulator error-spam.** E8 fix #1 lands an
  executor turn_summary hook that calls `accumulate_executor_cost`.
  Like the planner accumulator, it errors on missing flight, and the
  caller downgrades to warn-log. After a mission delete while
  executor sessions are still running, every turn produces a warn —
  potentially many per minute. Either silently no-op like
  `persist_planner_state_on_flight` does, OR ensure mission-delete
  reliably kills associated sessions first.
- **P3 — Cost-update event verbosity.** Both planner and executor
  `turn_summary` events trigger `mission-planner:cost-updated:<id>`,
  which fires `flightStore.hydrateFromBackend()` in the frontend.
  During decomposition with 10-20 turns/min, that's 10-20 full
  hydrations/min. Patch just the affected flight (read its persisted
  state, replace the entry in the in-memory store) instead of full
  re-read.
- **P3 — Token-vs-cost drift on planner-session race.** If
  `stop_mission_planner` removes the registry entry between
  `mission_id_for_sidecar_session` (step 2) and `get_by_mission`
  (step 3) in the sidecar `turn_summary` async-spawn, `model` falls
  back to `""` and `calculate_cost` returns 0. The handler still
  bumps `planner_tokens` but not `planner_cost`. Mild drift; bounded
  by how often a planner is mid-turn at stop time.
- **P3 — Compaction summarization burns OAuth quota.** Each compaction
  fires a one-shot Sonnet call (~80K input chars truncated, ~2K output)
  against the user's Claude subscription. On long-running missions this
  could happen multiple times per day. Consider caching previous
  summaries and only re-summarizing the delta since the last
  compaction. Also consider exposing a user-configurable threshold
  (today hardcoded at 150K tokens).
- **P3 — Compaction does not preserve in-flight tool calls.** If the
  planner is mid-turn (awaiting a tool result) when the threshold
  crosses, the session swap drops the in-flight tool. v1 acceptable
  — the planner re-decides on next wake. Worth a code comment.
- **P3 — Compaction summary not surfaced in the journal-as-context
  feedback loop.** After compaction, the new planner session has the
  summary as priming context, but subsequent wake messages don't
  reference it. If the planner needs to recall something pre-
  compaction (e.g., "did I already create milestone X?"), it has to
  rely entirely on the priming summary's completeness. Mitigation:
  the wake-message builder could include the latest summary verbatim
  in every wake until the next compaction. Worth considering for
  v1.1 quality.
- **P3 — Compaction event UX is minimal.** Today the indicator is a
  small "Compacting" pill. A more informative inline message in the
  Journal tab ("Session compacted at <timestamp>; <N> entries
  summarized into <M> chars") would help users understand the
  intervention.
- **P3 — App-shutdown mid-compaction edge case.** If the user quits
  between `swap_sidecar_session_after_compaction` (registry swap)
  and `persist_planner_state_on_flight` (DTO write), the registry
  has the new id but the DTO has the old. Cold-start enforce flips
  active missions to Paused on reboot, so the user resumes manually
  — but they'll see "Paused" instead of the live planner state.
  Acceptable v1; consider write-DTO-first in v1.1.
- **P3 — `OneshotWaiter` GC for hung sessions.** If a sidecar session
  emits chunks then goes silent, the `OneshotWaiter` entry stays in
  `SidecarManager::oneshot_waiters` forever. Crash fan-out covers
  the hard-crash case; `done`/`error` covers the normal completion
  case. The "hang" case needs a periodic sweep — every minute, drop
  entries where the receiver was already dropped by the caller's
  timeout.
- **P3 — `wait_for_oneshot` HashMap insert silently drops prior
  sender.** Defensive: replace `HashMap::insert` with `entry().or_insert_with(...)`
  + log warning if a duplicate session_id is registered.
- **P3 — Move src/agents/* cleanup out of E10 commit.** The
  pre-existing modifications to `src/agents/claude-code.ts` and
  `src/agents/index.ts` (removing `createClaudeCodeAdapter`) are
  unrelated to mission planner work and have been excluded from
  every mission-planner commit. Land them in their own
  chore/cleanup commit when convenient.

## Product tracks (from `dev/README.md`)

- **P2 — Cost dashboard alerts** (`dev/moat/cost-dashboard-plan.md`).
- **P2 — Swarm orchestration Phase 4 escalation** — auto-reassignment
  (`dev/bridgemind/swarm-orchestration-plan.md`).
- **P2 — PacketADE MCP provider transport** —
  `dev/mcp-provider-transport.md` Phases 2-3;
  `dev/bridgemind/packetade-mcp-server-plan.md`.
- **P3 — Workspace UX gaps** — git review packet ties
  (`dev/zen-workspace/features-git-workspace.md` Phase 3); command-palette
  integration of prompt library
  (`dev/zen-workspace/features-prompt-library.md`).
