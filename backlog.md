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
