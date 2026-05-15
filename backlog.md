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
- **P3 — Cold-start "active → paused" enforcement.** The DTO now
  persists `plannerStatus`, but nothing inspects it at boot. Belongs
  in E6 (safety rails); flag if E6 doesn't cover it.
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
- **P3 — Planner status sticks at Awake after wake done.** `dispatch_wake`
  flips `PlannerStatus` to `Awake` but nothing flips it back to `Idle` after
  the sidecar emits `done` for the wake turn. UI may surface "Awake"
  indefinitely. Add a per-session `done` listener (E6 watchdog candidate).
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
