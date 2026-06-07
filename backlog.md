# Backlog

Master source for outstanding work in PacketADE. When an item ships, move it
to the matching version section in [`CHANGELOG.md`](./CHANGELOG.md) and remove
it from here.

Priority: **P1** = real bug or major user-facing gap · **P2** = correctness/UX
· **P3** = cleanup.

## Remote Agents (current flagship)

Canonical plan: [`dev/remoteagents/README.md`](./dev/remoteagents/README.md).
This is the next major product bet: PWA first, Packet account sign-in, Packet
Cloud relay, desktop-owned providers/secrets/tools, and no generic remote Tauri
bridge.

- **P1 — Packet Cloud relay MVP.** Implement the Worker/Durable Object relay,
  desktop connector, host/session routing, reconnect semantics, and relay
  observability described in `02-architecture.md` and `03-protocol.md`.
- **P1 — Account sign-in + desktop device trust.** Ship Packet account auth,
  device enrollment, desktop-side approval, revocation, and audit trail. QR is
  optional later; it is not the primary flow.
- **P1 — PWA conversation shell.** Build the mobile conversation list, chat
  stream, provider/model/profile picker, permission/edit approval sheets, and
  reconnect/offline states from `05-pwa.md`.
- **P1 — Secure remote command envelope.** Implement only the narrow remote
  command set: list hosts/workspaces/providers/models/profiles/conversations,
  start/continue API-agent conversations, stream `api-agent:*`, respond to
  prompts, cancel/retry/change model/close, and observe cost/status summaries.
- **P1 — E2EE gate before external beta.** Add protocol fixtures, sequence
  validation, replay protection, device-key handling, and end-to-end encryption
  checks from `04-security.md` / `08-testing.md`.
- **P2 — Web Push attention loop.** Foreground traffic stays WebSocket; push is
  only for attention-needed events such as permission requests, pending edits,
  errors, and done summaries.
- **P2 — Native iOS/TestFlight spike.** Defer until the PWA proves the relay,
  auth, push, and phone UX.

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
- **P3 — Rust bash/ssh tools orphan grandchildren on timeout.** The
  abnormal-termination PR added `kill_on_drop(true)` to `tool_runtime.rs`
  (`execute_bash`) and `tool_runtime_ssh.rs` (`ssh_run`), but that only reaps
  the direct child (the `sh -c` / `cmd /C` shell or the local `ssh` client) —
  not the grandchildren it spawned (build, `node`, dev server) or the remote
  process. The sidecar bash tool now does a full process-group / `taskkill /T`
  kill (`agent-sidecar/src/providers/openai-agents.ts::killTree`); the Rust
  paths should reach parity (POSIX process-group kill, Windows `taskkill /T`,
  and `ssh -tt`/`RequestTTY` so the remote command gets SIGHUP on disconnect).
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
- **P3 — Remote file tools require `realpath` (fail-closed).** The symlink-
  escape confinement added to the remote read/list/grep/write_file scripts
  (`src-tauri/src/core/tool_runtime_ssh.rs::confine_prelude`) resolves paths
  with `realpath` and FAILS CLOSED (exit 9 → error) when the remote lacks it.
  This deepens the POSIX-sh dependency: remotes without `realpath` (some
  BusyBox builds, Windows OpenSSH) lose the file tools entirely. Follow-up:
  a portable fallback (`command -v realpath || readlink -f` probe) and/or a
  Windows-OpenSSH-aware remote tool layer. Pairs with the Windows-OpenSSH
  item above. `bash` is intentionally left unconfined on both transports.

## Agents pane

- **P3 — AgentModeChip "Default" label is now inaccurate for OpenAI Agents.**
  The shared chip (`src/components/agents/AgentModeChip.tsx`,
  `agentModeChipUtils.ts` `deriveMode`) labels `permissionMode: "auto"` (no
  approveWrites) as "Default — full tools, no per-tool prompts". After the
  approval-gating fix, an `api-openai-agents` session in `auto` now DOES
  prompt before `bash`/`write_file`. The chip is shared across all API
  providers and only OpenAI Agents changed, so the fix needs provider-aware
  labeling (or a tooltip note) rather than a blanket relabel. Make the chip
  truthful per provider.

## Platform & distribution (from `dev/`)

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
## GitHub pane v0.9+ (from v0.8 deferrals)

- **P2 — Authored PR line comments + reply threads.** v0.8 shipped read-only
  viewing of existing review comments via `PullRequestReviewsPanel`. Adding
  new threads requires `POST /repos/{o}/{r}/pulls/{n}/comments` + reply
  support + the in-diff composer UI. Right place: extend `DiffViewer` with
  per-line gutter affordances; backend command pair
  `github_post_pr_review_comment` + `github_reply_to_pr_review_comment`.
- **P2 — Notifications inbox.** `GET /notifications` integration with a
  dedicated tab listing unread items, with mark-as-read and link-back to the
  source issue / PR. Significant work — own state, polling cadence, and
  badge wiring across the app.
- **P3 — Issue → Mission auto-mirroring (bidirectional).** v0.8 has one-way
  Plane / Mission spec handoff. A "mirror this mission to GitHub issues"
  toggle would create + update issues automatically. Two-way sync is risky
  (collision, conflict resolution); requires a dedicated design pass.
- **P3 — Releases / gists / Actions runs view.** Out of scope for v0.8;
  worth picking up if the pane grows into a fuller GitHub client.
- **P3 — Native `gh` CLI device-flow auth.** Token paste still works in
  v0.8; OAuth device-flow would smooth onboarding.
- **P3 — Windows hook shim.** v0.8's `prepare-commit-msg` hook is a POSIX
  shell script that relies on Git for Windows' bundled MSYS sh. If a user
  runs vanilla Windows OpenSSH with no sh on PATH, the hook silently
  no-ops. Add a `prepare-commit-msg.cmd` shim or detect and warn.
- **P3 — SSH attempt draft-PR publishing.** v0.8's "Publish attempts as
  draft PRs" Flight option skips SSH attempts (logged as `errorMessage`).
  Add support for running git push from the remote worktree host.

## Memory v0.9+ (from v0.8 deferrals)

- **P2 — Embedding / RAG over memory.** Today's pattern retrieval is
  keyword/recency-based. An embedding layer (sqlite-vss or LanceDB)
  would enable semantic context injection for the Mission Planner
  decomposition phase and the executor brief.
- **P2 — Pre-execution memory brief for executor sessions.** When an
  attempt launches, compose a short "what we know about this codebase"
  brief from project-scoped patterns and inject it into the first
  user turn.
- **P3 — Recurring-error detector.** Pattern-extraction pipeline could
  watch for repeated failure modes and surface a "this looks familiar"
  hint at the next agent launch.
- **P3 — "Ask your project" memory chat tab.** A chat surface that
  queries memory directly (with the RAG layer above this is trivial;
  without it, fall back to keyword search).
- **P3 — Confidence auto-rerating on outcome.** When a pattern is
  referenced and the resulting attempt succeeds/fails, bump or decay
  the pattern's confidence score.
- **P3 — Manual capture "+ Add to memory" button** in more surfaces
  beyond the GitHub investigation. Anywhere the user encounters
  insight (mission journal, agent transcript, code review thread)
  should have a single-click capture affordance.
- **P3 — Project-scoped filter chips in TimelineTab.**
- **P3 — Provenance linking on event cards** (clickable
  `sessionId`/`taskId`/`flightId` jumps to the originating surface).
- **P3 — Export / import memory** as JSON+Markdown.
- **P3 — Date-range scope chips.**
- **P3 — 30-day memory digest.**

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

## Rust audit follow-ups (from v0.9.2 / v0.9.3 Phase C+D waves)

Items surfaced by the Phase C `core/` library audit that didn't ship in
Phase D. Backend is 100% audit-covered now; these are the next-tier
hardening passes worth doing when context allows.

### LLM provider stack

- **P2 — `let _ = tx.send(...)` backpressure swallow.**
  ~20 sites across `core/llm_anthropic.rs` and `core/llm_openai_compat.rs`
  silently keep parsing the upstream HTTP stream after the consumer
  receiver has dropped. Convert each to a check-and-return so a dropped
  receiver short-circuits the parser loop.
- **P3 — Tool-args JSON parse coerced to `{}` at 4 sites.**
  `llm_anthropic.rs:326` and three sites in `llm_openai_compat.rs`
  (`:301`, `:354`, `:378`) silently mask malformed tool argument JSON
  from a truncated stream. At minimum log; ideally emit
  `StreamChunk::Error` so malformed-stream bugs are visible.
- **P3 — `llm_openai_compat.rs:349-352` finish_reason "stop" branch
  flushes tool_use.** May emit a spurious `ToolUseEnd` for an
  incomplete/malformed tool stream — `stop` typically means the
  assistant message ended *without* a tool call. Verify intent.
- **P3 — Brand violation in `core/llm_system_prompt.rs:57`.**
  `BASE_SYSTEM_PROMPT` hardcodes `"PacketADE"` instead of using
  `brand::APP_NAME`. Switch to `format!`.
- **P3 — `include_usage` not gated for MiniMax/Ollama.**
  `llm_openai_compat.rs:178` enables `include_usage` only for OpenAI
  and OpenRouter; MiniMax and Ollama get zero token counts unless
  they happen to include `usage` by default.

### Tool runtime

- **P2 — `core/tool_web.rs` body-size cap before `.text().await`.**
  No content-length cap today — a malicious 10 GB response can OOM
  the process before the post-fetch `truncate` runs. Switch to
  `bytes_stream()` with an early-abort threshold.
- **P2 — Wrap `tool_web.rs` fetched content in an untrusted-content
  envelope before returning to the model.** Today the agent receives
  raw HTML-stripped plain text with no provenance marker, which is a
  known prompt-injection footgun.
- **P3 — `tool_web.rs:103-106` recompile 4 regexes per fetch.**
  Use `once_cell::sync::Lazy` (or `regex::OnceLock`). Perf, not
  correctness.
- **P3 — `tool_subagent.rs` + `tool_custom_agent.rs` ~80 LoC dedupe.**
  Both files share ~80% structure (collect_response, message-loop,
  build/exec/dispatch). Extract a shared `agent_loop(provider, tools,
  system_prompt, model, max_tokens, parent_target)` helper.
- **P3 — `tool_pull_request.rs:124` orphan PR body tempfile on cancel
  or crash.** `gh pr create` killed mid-flight leaves
  `.pkt-pr-body-*.md` files behind. Switch to
  `tempfile::NamedTempFile` so the file is dropped on scope exit.
- **P3 — `tool_pull_request.rs:301-314` duplicates
  `pick_heredoc_terminator` from `tool_runtime_ssh.rs:136-149`** —
  hoist into `core::shared` (already pairs with the existing
  `PACKETCODE_EOF_` rename backlog item).
- **P3 — `tool_custom_agent.rs:173` silent SSH `project_path` → empty.**
  `ExecutionTarget::Ssh { .. } => String::new()` silently degrades
  to "home-dir agents only"; document or guard with an explicit
  comment.

### MCP / workspace / runtime

- **P2 — `core/worktree.rs:507` unconditional `git worktree remove
  --force`.** No uncommitted-changes guard. Same path that bit us mid-
  session when the classifier blocked discarding agent work. Add a
  pre-flight check that the worktree is clean unless the caller passes
  an explicit "force-anyway" flag.
- **P3 — `worktree.rs` ~120 LoC dedup.** 1,033 LoC file;
  `install_prepare_commit_msg_hook` and
  `install_prepare_commit_msg_hook_for_issue` are ~95% duplicated
  (settings load, hooks-dir resolution, dir create, chmod, write).
  Extract a shared `write_hook_script(worktree_path, script_body)`
  helper.
- **P3 — `worktree.rs:463` dead `_title_unused` binding.** Wire it in
  or delete; the "reserved for future" comment is now stale.
- **P3 — `worktree.rs` `attempt_id` ASCII sanitization.** Today the
  callers always pass UUIDs from `orchestrator.rs` / `commands/git.rs`,
  but the public function has no defence-in-depth. Tighten to
  ASCII-alphanumeric + `-_`.
- **P3 — `core/mcp_bridge.rs::resolve_mcp_name` per-call server
  re-spawn.** Every `mcp__*` tool call re-spawns every enabled MCP
  server and re-runs `tools/list`. Cache the advertised-name →
  (server, tool) map at agent-session start.
- **P3 — `core/hooks.rs:205` payload-serialize fallback.** Now logs
  before falling back to `b"{}"` (landed in v0.9.3), but consider
  whether `serde_json::Value` failing to encode is recoverable at
  all — could promote to error.
- **P3 — `core/pty.rs:253-263` reader-thread error spin.** Only
  `BrokenPipe` exits the loop; a persistent OS-level error retries
  silently. Log once per error kind to make the spin visible.
- **P3 — `core/pty.rs:217` transcript-init `let _ = fs::write(...)`.**
  If `data_dir` is unwritable the user gets empty transcripts with no
  log line. Add `warn!`.
- **P3 — `commands/mcp.rs::write_mcp_server` non-atomic save.** Today
  it's a direct `fs::write`; consider a tmp+rename atomic pattern so a
  crash mid-write doesn't corrupt the user's `mcp-servers.json`.

### Storage / orchestration / prompts

- **P3 — `core/migration.rs` cross-volume copy fallback can strand the
  user on a partial `new_dir`.** The copy-fallback added with the storage
  durability work copies the legacy dir to the new dir when `rename` fails
  (cross-volume), and on copy failure best-effort `remove_dir_all`s the
  partial copy. But if that cleanup also fails — or the process crashes
  mid-copy — a partially-populated `new_dir` survives; the next startup's
  `data_dir()` prefers `new_dir` (`.exists()`) and reads an empty/missing
  `state.v1.json` instead of the intact legacy dir. Legacy data is never
  deleted so nothing is lost, but the app shows empty. Harden by copying to
  a temp dir then atomically renaming it into place, and verify/log the
  cleanup result instead of discarding it with `let _`.
- **P3 — `core/orchestrator.rs:415` `unwrap()` after `is_none()` guard
  in the `tick()` hot loop.** Idiomatic `if let Some(agent) = ... {}
  else { continue; }` reads cleaner and removes the hazard signal.
- **P3 — `core/mission_planner_prompts.rs` LoC bloat (1,656).**
  Mostly long `r#"..."#` system-prompt strings, which is the right
  place for them, but the file deserves extraction into per-section
  sub-modules (decomposition prompt, reactive replan prompt,
  wake-message builders) for review-ability.

### Test gaps (carried from earlier in the session)

- **P3 — `InvestigationPanel` Draft-patch error path missing test.**
- **P3 — `PendingApprovalsSection` Y/N keyboard edge cases missing
  test** (e.g., focused inside an input — should not consume).
- **P3 — `forkAndResend` should clear `agentPlanStore`.** 1-line
  follow-up from the v0.9.0 S1 refactor.
- **P3 — `IssueCommentList.tsx` duplicate `timeAgo` helper.**
  Surface caught during the v0.9.1 T2c dedup pass; not addressed
  because it lives outside the GitHubView surface that owned T2c.

## Triple-agent review 2026-06-07 (83 confirmed findings)

Full report, evidence, and fix detail: [`dev/code-review-2026-06-07.md`](./dev/code-review-2026-06-07.md).
Methodology: 10 area + 10 lens reviewers → 59 canonical (52 confirmed / 6 refuted / 1
uncertain) → gap-fill refill of 5 subsystems → 37 G-findings through a 3-vote panel (31
confirmed / 6 refuted). Severities below are **post-debate**. Priority map: high→P1,
medium→P2, low→P3. Two duplicate pairs merged: **F26≡G04**, **F36≡G32**. As each ships it
moves to `CHANGELOG.md`. Some items overlap pre-existing backlog entries above (e.g. F21,
F34, G17, G19) — dedupe on fix.

### P1 — confirmed high

- **F02 — one invalid UTF-8 byte freezes a terminal forever** (unbounded `pending`) — `core/pty.rs:55-76`. Use `Utf8Error::error_len()`.
- **F13 — deploy run stuck "running" forever on EIO** — `commands/deploy.rs:288-325`. Dedicated wait thread; break loop on EIO.
- **F19 — MCP write clobbers shared `~/.claude/settings.json` on parse failure** — `commands/mcp.rs:42-55,139,167`. Bail Err on parse; atomic write.
- **F20 — MCP server edit drops `disabled`/`type`/`url`/`headers` (corrupts SSE/HTTP)** — `commands/mcp.rs:148-160`. Read-modify-merge.
- **F40 — `web_fetch` is an unrestricted SSRF primitive** — `core/tool_web.rs:38-98`. Block private/link-local IPs; re-validate after redirects.
- **F50 — duplicate pane IDs collide after hydration** — `stores/workspaceStore.ts`. `crypto.randomUUID()` or reconcile `wsCounter`.
- **F53 — cross-arch build bundles the wrong native sidecar binary** — `scripts/prune-sidecar.js:171-193`. Target-aware prune + release-gate assert.
- **G01 — sidecar + grandchildren orphaned on app exit** (no `kill_on_drop`/shutdown) — `agent_sidecar/supervisor.rs:559-573`, `lib.rs:418`.
- **G02 — sidecar restart silently bricks live sessions** (no error fan-out, stale ownership) — `agent_sidecar/supervisor.rs:419-512`.
- **G09 — Codex `respondPermission` writes to a stdin `codex exec` ignores → turn hangs** — `providers/openai-codex.ts:895-929`.
- **G16 — OpenAI-compat parallel tool calls collapse/cross-contaminate (`index` ignored)** — `core/llm_openai_compat.rs:226-343`. _(panel severity split)_
- **G23 — orchestrated PTY task success uses exit reason, not exit code → failures = Done** — `useTerminalSession.ts:290-293`, `pty.rs:334`.
- **G25 — async attempt has no terminal transition on done/error → stuck running** — `flights/AttemptTile.tsx:59-92`.
- **G33 — Stop with a queued message re-sends it (cancel emits `done` → drain)** — `agentTaskStore.ts:1227-1249`, `apiAgentListeners.ts:216-261`.

### P2 — confirmed medium

- **F01 — `kill_pty`/`kill_sessions` leak zombie children on Unix** — `commands/pty.rs:393-410,117-128,329-331`.
- **F06 — keyring password forwarded to remote stdin on ControlMaster-reused SSH** — `core/tool_runtime_ssh.rs:106-138`.
- **F09 — keyring migration deletes legacy cred even when new write fails** — `api_keys.rs:55-61`, `ssh_keys.rs:38-44`.
- **F10 — Gemini key migration deletes localStorage in `finally` even when keyring throws** — `tools/GeminiApiKeyCard.tsx:24-33`.
- **F11 — password auth writes to ssh stdin OpenSSH doesn't read** — `core/tool_runtime_ssh.rs:128-138`.
- **F16 — leading-edge auth-watcher debounce drops the authoritative cred write** — `auth_watcher.rs:201-211`.
- **F23 — `DeployConfig.env` typed end-to-end but never applied to the command** — `deploy.rs:9-15,220-264`.
- **F24 — deploy runs cannot be cancelled (no kill handle / `kill_deploy`)** — `deploy.rs:266-327`.
- **F28 — `send`/`retry` overwrite the in-process cancel sender, cancelling a running turn** — `api_agent.rs:701-724,1015-1037`.
- **F32 — failed API `sendMessage` leaves the bubble spinning forever** — `agentTaskStore.ts:1072-1098`.
- **F33 — orchestration scheduler silently swallows backend tick failures** — `orchestrationSchedulerStore.ts:47`.
- **F34 — `update_task` `target_spec` reported landed but silently dropped** — `mission_planner_tools/update_task.rs:135-144`. _(see existing P3 entry)_
- **F38 — `useVoiceInput` never stops recognition/native recording on unmount** — `hooks/useVoiceInput.ts:63-153`.
- **F44 — `migrateLegacyStorage` mutates localStorage while iterating by index → loses keys** — `lib/storage-migration.ts:19-31`.
- **F46 — streamed UTF-8 multibyte corrupted when split across chunks (both streamers)** — `llm_anthropic.rs:213`, `llm_openai_compat.rs:234`.
- **F48 — FlightDetail unlink clears `issue.flightId` but not `flight.issueIds`** — `flights/FlightDetail.tsx:173`.
- **F49 — flight status never recomputes when an issue changes** — `FlightList.tsx`, `MissionsView.tsx`.
- **F51 — `flightStore.hydrateFromBackend()` clobbers in-flight optimistic mutations** — `flightStore.ts:688-698`.
- **F52 — `issueStore` localStorage-authoritative, never hydrated, lossy backend mirror** — `issueStore.ts:203-237`. Minimal fix: reconcile `flightStore.issueIds` on hydrate.
- **F55 — `FlightStatus` contract test asserts a hand-kept length, missing `spec`** — `__tests__/contract.test.ts:167-180`.
- **F56 — SSH-target→serverStore migration untested, deletes legacy keys before save lands** — `lib/sshTargetMigration.ts:80-106`.
- **G03 — `truncate()` panics on a multibyte UTF-8 boundary, killing the reader loop** — `agent_sidecar/handler.rs:933-939`.
- **G08 — Codex cancel surfaces a spurious `error` banner instead of clean cancellation** — `providers/openai-codex.ts:458-483`. _(panel: high→medium)_
- **G10 — Codex `agent_message_delta` + `agent_message` duplicate assistant text** — `providers/openai-codex.ts:543-560`.
- **G11 — Anthropic `respondEdit` resolves ALL pending edits on one response** — `providers/anthropic.ts:1029-1071`.
- **G17 — token/cost always zero for MiniMax & Ollama (`include_usage` gated)** — `llm_openai_compat.rs:178-180`. _(see existing P3 entry)_
- **G18 — empty assistant message persisted → Anthropic 400s the next turn** — `api_agent.rs:1429-1460`.
- **G24 — backend-initiated PTY kill reported to frontend as successful completion** — `orchestration.rs:131-136,190-195`.
- **G26 — worktree leak when API session fails to start after attempt persisted** — `flight_attempts.rs:646-685`.
- **F36/G32 — `deleteConversation` leaks all 12 api-agent listeners for done/failed convs** — `agentTaskStore.ts:1142-1182`. _(panel: high→medium)_

### P3 — confirmed low

- **F03** onSessionEnded double-fire on kill — `useTerminalSession.ts:406-425`.
- **F04** transcript-replay dedupe unsound — `useTerminalSession.ts:245-319`.
- **F05** `resolve_windows_command` fabricates `.cmd` on `where` failure — `pty.rs:82-84`.
- **F12** remote `mkdir -p` before symlink confine — `tool_runtime_ssh.rs:255-266`.
- **F15** `write_with_backup` no fsync of backup/parent — `core/storage.rs:651-662`.
- **F17** first-ever login badge miss (non-recursive $HOME watch) — `auth_watcher.rs:84-128`.
- **F18** locked cred store reported as "missing key" — `api_keys.rs:119-123`.
- **F21** MCP writes non-atomic — `commands/mcp.rs:167-168,195-197`. _(see existing P3 entry)_
- **F22** DeployTerminal misses early output — `deploy.rs:288-305`.
- **F25** deploy output array unbounded in memory — `deployStore.ts:110,179-185`.
- **F26/G04** `owns_session()` `try_lock` misroutes follow-up messages → dropped — `supervisor.rs:131-145`. _(panel: med→low)_
- **F27** `cancel_pending_tools` drains across all in-process sessions — `api_agent.rs:941-968`.
- **F29** `provider_stats` lost-update race — `provider_stats.rs:134-157`.
- **F35** usage/cost write failures `let _ =` swallowed ×4 — `api_agent.rs:1248,1348,1492,2002`.
- **F37** `close_api_agent_session` orphans pending oneshots — `api_agent.rs:1042-1072`.
- **F39** DeployTerminal listener leak on fast unmount — `DeployTerminal.tsx:92-119`.
- **F41** commit-trailer template → shell injection in generated hook — `core/worktree.rs:351-375`.
- **F42** Whisper model download has no checksum/signature — `dictation/models.rs:125-212`.
- **F43** `active_form` snake_case vs `activeForm` (blank in-progress todos) — `agent_sidecar/events.rs:115-124`.
- **F47** final SSE line without trailing newline dropped — `llm_anthropic.rs:215`, `llm_openai_compat.rs:237`.
- **F54** `release-gate.mjs` hardcodes the Windows Node triple — `scripts/release-gate.mjs:105-109`.
- **F57** SSH pinning branch in `baseSshArgs` untested — `lib/ssh.ts:19-63`.
- **F58** Mission Planner rate-limit backoff clamp untested — `mission_planner.rs:910-912`.
- **G05** sessions forgotten on transient writer-closed error during restart — `agent_sidecar/protocol.rs:181-186,281-286`. _(panel: med→low)_
- **G06** cancelled sidecar sessions leak ownership + remote ssh procs — `agent_sidecar/protocol.rs:361-370`.
- **G07** unbounded writer channel + stdout line buffer (no backpressure/cap) — `supervisor.rs:598,679,779-808`.
- **G13** Codex `tool_result` can carry empty `toolUseId`, orphaning it — `providers/openai-codex.ts:623-645`.
- **G14** `rate_limited` + `error` race two `drain_chunk_buffer` tasks (fragile) — `anthropic.ts:689-703`, `handler.rs:668-749`.
- **G15** `injectUserTurn` `maxOutputTokens` accepted but silently dropped — `anthropic.ts:943-958`.
- **G20** cancellation during tool execution not honored until next iteration — `api_agent.rs:1217-1219,1938`.
- **G21** Anthropic non-stream HTTP error double-surfaces — `api_agent.rs:1408-1426`.
- **G29** scheduler ignores flight priority → starvation — `orchestrator.rs:384-450`.
- **G30** attempt user-message display diverges from prompt sent — `asyncFlightStore.ts:411-454`.
- **G31** orphaned running task permanently consumes a parallel slot — `orchestrationSchedulerStore.ts:142-160`.
- **G34** auto-failover system notice deleted by `retryLastTurn` truncation — `apiAgentListeners.ts:281-298`. _(panel: med→low)_
- **G35** late tool-result after turn end silently dropped — `apiAgentListeners.ts:156-189`.
- **G36** done notification + queue drain fire even on user cancel — `apiAgentListeners.ts:251-265`.

**Refuted (do not action):** F07, F08, F14, F30, F31, F45 (F-series) · G12, G19, G22, G27, G28, G37 (G-series). Reasons in the report §1.
