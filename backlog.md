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
  public Anthropic endpoint surfaces Claude.ai subscription usage. v1
  shows cumulative tokens only. Revisit if an endpoint appears.
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
