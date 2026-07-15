# Backlog

Master source for outstanding work in PacketADE. When an item ships, move it
to the matching version section in [`CHANGELOG.md`](./CHANGELOG.md) and remove
it from here.

Priority: **P1** = real bug or major user-facing gap · **P2** = correctness/UX
· **P3** = cleanup.

## Shipped 2026-07-13 — P2 hardening batch (see `CHANGELOG.md` `[0.10.1]`)

A verify-then-fix pass over the "ready and unblocked" P2 work. Each candidate was
re-checked against current code (many predated the single-surface refactor) and the
changes were 2-agent peer-reviewed before commit. **Shipped** (remove the matching
lines below as they are reconciled): backpressure-swallow short-circuit (RA1),
`tool_web` body-size cap + untrusted-content envelope + regex hoist (RA2/RA3),
UTF-8-across-chunks in both LLM streamers (F46), SSH stdin-password leak
(F06/F11), auth-watcher trailing-edge debounce (F16), worktree leak on
session-start failure (G26), `truncate` multibyte panic (G03), Codex duplicate
text (G10), spinning-bubble on send failure (F32), `deleteConversation` listener
leak (F36/G32), `hydrateFromBackend` optimistic-merge (F51), FlightStatus contract
test vs generated schema (F55), and cost-threshold notifications (ROADMAP N5).

**Verified ALREADY-FIXED during the pass** (obsolete backlog entries — safe to drop):
F01 (pty reaps children via `exit_child.lock().wait()`), G08 (Codex signal-kill
exit treated as `done`), plus the H4-wave items F50, F38, and the "Path will be
created" copy.

**Deferred with cause (NOT done — do not treat as ready):**
- **F28 — send/retry cancel-sender overwrite.** Not a clean fix: `cancel_senders`
  is keyed only by `session_id`, so a surgical patch hits a chain of hazards
  (busy-spin on a completed receiver, post-loop `senders.remove` ripping out the
  *newer* turn's sender, `Ok(())` real-cancel vs `Err` supersede-drop being
  indistinguishable). Needs per-turn cancel keying — a small concurrency redesign,
  not a P2 patch.
- **G11 — `respondEdit` resolves all pending edits.** The correct fix threads a
  `toolUseId` through the `edit_response` wire protocol (TS + Rust); low impact
  today (guarded by "one edit in flight"), so deferred to a deliberate protocol change.
- **RA4 — `worktree.rs` force-remove guard.** Every current caller is an
  intentional discard that would pass `force=true`, so the guard is pure churn +
  risk with no live-caller benefit today. Revisit if a non-discard caller appears.
- **S6 / SSH password on Unix (F11 follow-up).** `ssh_check_remote_path` ignoring
  the saved keychain password is real, but password-over-stdin only functions on
  Windows OpenSSH — on Unix the whole path is non-functional regardless (see the
  new "SSH password auth on Unix" item below). Fixing S6 in isolation only helps
  Windows and needs a new command param + FE wiring; folded into that larger item.
- **S8-Phase-B (stdio MCP-over-SSH + remote config ownership):** blocked on a
  decision-gated transport build. (N3 PacketADE-as-MCP-server read-only —
  SHIPPED 2026-07-15, see below; N2 swarm escalation — SHIPPED 2026-07-14;
  S7 remote git commands — SHIPPED 2026-07-14; S8-Phase-A HTTP/SSE MCP-over-SSH
  — SHIPPED 2026-07-14; S9 Codex-over-SSH — no code gate, routes today. All see
  the relevant sections below.)

### New findings from the pass (now tracked)

- **P2 — Deploy command family is orphaned.** `run_deploy`, `read_deploy_config`,
  `validate_deploy`, `create_deploy_config` (`commands/deploy.rs`) have **no**
  frontend or Rust caller — only their `lib.rs` registrations — since the deploy
  UI was removed in the P2-20 state pruning (`705f0b6`). This makes the June
  review's F23 (`DeployConfig.env` never applied) and F24 (runs can't be
  cancelled) bugs in dead code. Either delete `deploy.rs` + its 4 registrations,
  or re-surface a deploy UI and fix F23/F24 then. **Supersedes F23/F24.**
- **P2 — SSH password auth on Unix is non-functional.** Post-F06/F11, the keychain
  password is only fed to ssh stdin on Windows, because Unix OpenSSH reads the
  password from `/dev/tty`, not stdin. So password-auth SSH targets can't
  authenticate non-interactively on macOS/Linux via `ssh_run`/`ssh_exec`, and with
  `BatchMode` dropped a dev build with a controlling TTY can block until the
  command timeout. Proper fix: `sshpass`/`SSH_ASKPASS` (or keep `BatchMode=yes` on
  Unix to fail fast), applied consistently across `ssh_run`, `ssh_exec`, and
  `ssh_check_remote_path` (subsumes **S6**).
- **P3 — auth-watcher edge cases.** The new trailing-edge debounce has no
  max-wait cap (a cred file rewritten with <500 ms gaps indefinitely never emits —
  theoretical; real logins settle) and doesn't flush a pending emit if the channel
  closes mid-burst (teardown-only, inconsequential).
- **P3 — Codex flat-path suffix assumption.** G10's `text.slice(flatTextEmitted)`
  assumes the terminal `agent_message` is a length-extension of the concatenated
  deltas; a *corrected* terminal text would be mis-emitted. Matches the existing
  0.135 item-path assumption; only manifests if Codex diverges.

## Remote Agents (current flagship)

Canonical plan: [`dev/remoteagents/README.md`](./dev/remoteagents/README.md).
This is the next major product bet: PWA first, Packet account sign-in, Packet
Cloud relay, desktop-owned providers/secrets/tools, and no generic remote Tauri
bridge.

**Sequencing note.** Remote Agents (ROADMAP R0, P0) is the headline direction.
Its relay reuses the same `api-agent:*` event contract that tile conversations
already emit, so the "stream `api-agent:*` / respond to prompts / cancel"
envelope should treat that event shape as a stable input. The Rust
flight-planner backend question (see **Flight Planner backend** below) is
resolved (shipped 2026-07-11) and does not gate this work.

**Blocked on Sprint-0 decisions.** [`dev/remoteagents/09-open-decisions.md`](./dev/remoteagents/09-open-decisions.md)
records three Sprint-0 BLOCKING decisions — auth provider choice,
payload-encryption timing, and code location — all still marked "Open" as of
that doc's 2026-06-15 last touch (four weeks stale as of this writing). Per
that doc, no `remoteagents/` code should be written until each is resolved.
The P1 items below are the target backlog once Sprint-0 unblocks; do not pick
them up before that gate clears.

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
- **SHIPPED — Sidecar-over-SSH (Phase 4.1).** The transport-agnostic stdio JSON
  protocol now runs the sidecar over SSH, so Anthropic (Subscription) and OpenAI
  (ChatGPT) providers work against remote codebases. Verification contract:
  [`dev/sidecar-over-ssh-verification.md`](./dev/sidecar-over-ssh-verification.md).
  Follow-up: Codex-over-SSH — no gate found (see below); live smoke still pending.
- **NO GATE FOUND 2026-07-14 — Codex-over-SSH already routes.** The original
  premise was false: it assumed a *spawn-`codex`-over-`ssh`* model, but the
  sidecar-over-SSH transport runs the **whole sidecar on the remote host**
  (`PACKETADE_REMOTE_SIDECAR=1`), so `codex exec` spawns natively there against
  the remote filesystem — no per-provider SSH spawn path is needed. A full code
  trace found zero exclusion: `openai-codex` is in `SIDECAR_PROVIDERS`
  (`agent_sidecar/mod.rs:30`); the remote preflight has a codex auth check
  (`supervisor.rs:1244`); `api_agent.rs:696+` routes remote workspaces
  generically for every sidecar provider; and the FE catalog marks
  `api-openai-codex` `supportsSsh: true` (only `api-ollama` is local-only,
  `agent-catalog.ts:72`). Regression-locked by tests
  (`is_sidecar_provider("openai-codex")` in `agent_sidecar/mod.rs`; the
  `supportsSsh` assertion in `agentCatalog.test.ts`). **Remaining: a live
  end-to-end smoke** (remote host with `~/.codex/auth.json` + the sidecar built
  under `~/.packetade/agent-sidecar`) per `dev/sidecar-over-ssh-verification.md`
  step 12 — not runnable without a remote host, so it stays open as a
  verification item, not an implementation one.
- **P2 — Misleading "Path will be created" copy.** `WorkspaceCreationModal`
  promises the path will be created on workspace start; nothing actually
  `mkdir -p`s it. Either add the mkdir over SSH on first launch, or revise
  the copy. **(being fixed by H4 this wave.)**
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
- **FIXED — Password-auth migration silently downgrades to "agent".**
  `src/lib/sshTargetMigration.ts` now calls `getSshPasswordExists(t.id)` and
  keeps `authMethod: "password"` for legacy keyring-stored SSH passwords (was
  forcing `keyPath ? "key" : "agent"`). Covered by
  `src/lib/__tests__/sshTargetMigration.test.ts`.
- **SHIPPED 2026-07-14 — Remote git dashboard write actions.**
  `git_stage_files_remote` / `git_unstage_files_remote` / `git_commit_remote` /
  `git_push_remote` / `git_pull_remote` / `git_create_branch_remote` landed
  (over the existing SSH `ssh_git` transport, shell-safe via `sh_quote`), and
  the GitDashboard's remote read-only gate is lifted. See `CHANGELOG.md`
  `[0.10.1]`. Follow-ups (P3): the remote per-file diff view (needs a remote
  file-read path); a friendlier "behind upstream — pull first" message on remote
  push (today git's raw non-ff rejection surfaces); defense-in-depth `..`/absolute
  path rejection on remote staging (harmless today — `--` + `sh_quote` + git's
  repo-boundary check already prevent escape).
- **MCP servers over SSH (Phase 4.2) — split into two.** The original single
  item conflated two very different problems:
  - **Phase A — HTTP/SSE MCP over SSH — SHIPPED 2026-07-14.** Remote sidecar
    launches now forward URL-reachable HTTP/SSE MCP servers (they need no local
    binary); stdio servers are dropped with a warn. `split_mcp_network_servers` +
    the `is_remote_workspace` branch in `commands/api_agent.rs` (was: hard error
    when any MCP server was enabled remotely). Config is sourced from the local
    global `~/.claude/settings.json`; secrets in headers/env travel to the remote
    sidecar over the SSH-encrypted channel (consistent with the existing
    `openai` api_key forwarding). Servers pointed at a loopback/`localhost`/
    unspecified URL are dropped too (`mcp_url_is_local_only`) — they're
    unreachable from the remote host and would leak their token; private-LAN URLs
    are a deliberate documented caveat (the remote may share the LAN), NOT blocked.
    Remaining Phase-A polish: surface the skipped stdio/local servers to the user
    (today it's a backend warn only). See `CHANGELOG.md` `[0.10.1]`.
  - **Phase B — stdio MCP + remote project config — DEFERRED (L, decision-gated).**
    The hard part: stdio (process) MCP servers need their binaries on the *remote*
    host, and project-scoped `.mcp.json` lives on the remote host (today's
    local-fs read returns empty for a remote path). Needs (1) sourcing MCP config
    from the remote host — either read it over SSH in Rust, or have the remote
    sidecar source its own `.mcp.json` + `~/.claude/settings.json` (a new sidecar
    capability + protocol flag), and (2) a **product decision on config
    ownership** (does a remote session use the remote host's global settings, the
    local machine's, or a merge?). Sits alongside N2/N3 as a decision-gated track.
    Phase-A polish that could fold in: surface skipped stdio servers to the user
    (today it's a backend warn only).
- **DONE — Consolidate duplicate `CloneServerConfigDto` and
  `GitServerConfigDto`.** The duplicate `CloneServerConfigDto` in
  `commands/scaffold.rs` was removed; `commands/git.rs::GitServerConfigDto` is
  the single shared shape.
- **P3 — `clone_repo_remote` has no frontend caller.** The `cloneRepoRemote`
  wrapper (`src/lib/tauri.ts`) exists but nothing invokes it. Surface a "Clone
  to remote workspace" action in `WorkspaceCreationModal` / ServersView, or
  remove the binding.
- **P3 — Sidecar-providers list drift.** Frontend `SIDECAR_AGENTS`
  (`src/components/agents/AgentInputArea.tsx:116`) is hand-mirrored from
  backend `SIDECAR_PROVIDERS`
  (`src-tauri/src/commands/agent_sidecar.rs:36`). Codegen or expose via a
  `list_sidecar_providers` Tauri command.
- **P3 — Dead Tauri commands.** `get_ssh_password_exists` now has a live
  caller (`sshTargetMigration.ts` uses it to preserve password auth). The
  remaining three — `set_ssh_password`, `delete_ssh_password`,
  `ssh_test_connection` — still have no callers beyond their `tauri.ts`
  wrappers. Either remove them or repurpose for the `ssh_check_remote_path`
  keyring-password probe above.
- **P3 — Rename `target_id` → `server_id` across the wire.** Field name
  kept for in-flight back-compat (see `src/lib/tauri.ts:1331-1336`).
- **P3 — `resumeApiConversation` partial live-config lookup.** Resolves
  `port` / `keyPath` / `hostFingerprint` from live `ServerConfig` but uses
  persisted `host` / `user` / `remotePath`. If a user renames or repoints
  the server, resume hits the old host.
- **P3 — Sentinel rename.** `src-tauri/src/commands/pty.rs`
  `PACKETCODE_SSH_OK` and `src-tauri/src/core/tool_runtime_ssh.rs`
  `PACKETCODE_EOF_*` still use the old brand. **(being fixed by H4 this wave.)**
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

## Tile composer / conversation tiles

Conversations are now workspace tiles on the single surface (the standalone
Agents tab was removed). No open items here today — the previous
`AgentModeChip` provider-aware-labeling complaint has shipped.

- ~~**P3 — Ctrl+Shift+V shortcut collision.**~~ — **RESOLVED (this wave, H4).**
  The transcript view-mode cycler was moved off `Ctrl+Shift+V` (push-to-talk
  dictation) to the otherwise-unbound `Ctrl+Shift+O`, ending the
  two-handlers-one-chord collision (`src/hooks/useAgentTabHoists.ts`; guard test
  in `src/hooks/__tests__/useAgentTabHoists.test.tsx`).

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

## Flight Planner backend

- **SHIPPED 2026-07-11 — extract-then-delete complete.** See
  [`CHANGELOG.md`](./CHANGELOG.md) `[0.10.1]` for the full account
  (`chore/planner-amputation`, merged `b930297`). Two facts worth keeping
  live here rather than letting them go stale in CHANGELOG prose:
  - **KEPT (persisted-data policy, deliberate):** `core/flight.rs`'s `planner_*`
    fields, `PlannerStatus` enum/DTO, `PersistedState.flight_approvals`, and
    `FlightApprovalRequest(Dto)` stay so old users' on-disk state keeps
    loading losslessly — write-once/read-never now that there's no planner UI.
  - **Orphaned, not migrated:** on-disk flight journals under
    `data_dir().join("missions")` are now harmless orphans; nothing reads or
    writes them. This supersedes the "Class B — live path" framing below —
    treat that framing as historical.

### Intentional Mission→Flight back-compat surfaces (do NOT flag as leftover)

The Mission→Flight rename (v0.9.5) deliberately keeps four read-side
compatibility surfaces so persisted user data written under the old
`missionId` / `missions` names still loads. These are intentional, not
stale-symbol misses — leave them in place until the removal criteria below
are met. They fall into two removal classes.

**Class A — lazy read-side fallbacks (7 items).** All are deserialize-/read-time
only: they re-emit the canonical `flightId` key the *next* time that record is
persisted. There is no eager one-shot migration pass, so a record that is loaded
but never re-saved keeps its legacy key on disk indefinitely.

- **5 Rust `#[serde(alias = "missionId")]`** on persisted structs:
  `api/mod.rs:232`, `commands/flight_planner.rs:311` and `:337`,
  `core/flight.rs:480`, `core/flight_journal.rs:51`.
- **2 frontend store read shims:** `issueStore.ts:170` (`flightId` falls back to
  legacy `missionId`) and `goalStore.ts:18` (`migrateGoal` copies legacy
  `missionId` → `flightId` on read).

*Removal criteria (Class A):* no removal timeline exists today and none is
implied by the code. Do NOT phrase removal as "after release X all data is
migrated" — that is false here because these are lazy fallbacks with no eager
pass, so never-touched records keep legacy keys forever. Removable only after
(a) a one-shot eager migration ships that walks all persisted
goals/issues/flights/journal records and rewrites them with canonical `flightId`
keys, AND (b) at least one release cycle passes for that migration to run on
users' machines. Earliest realistic target is the 1.0.0 cut (per SemVer, removals
belong at a major bump; pre-1.0 the 0.x→0.(x+1)/1.0 cut is the legitimate window).
Without the eager pass, removal silently drops the flight binding on any record
not re-saved since the rename. **Action item:** build the eager mission→flight
on-disk migration pass and gate Class-A removal on it shipping + one release.

**Class B — the on-disk journal directory literal (1 item).**

- **`data_dir().join("missions")`** at `core/flight_journal.rs:82` (documented at
  `:2`). This is NOT an expirable shim — it is the live, canonical path the code
  reads *and* writes right now. There is no parallel `~/.packetade/flights/`
  directory and no journal-dir migration logic.

*Removal criteria (Class B):* treat as a live path, not a back-compat shim, and do
not put it on the Class-A track. It can change only as part of a deliberate
`missions/` → `flights/` directory migration (copy + legacy-read fallback,
mirroring the existing `storage.rs` `data_dir()` legacy-fallback precedent), and
even then keep the legacy-read fallback one extra major version. On-disk format
compatibility outlives API/config deprecation.

## GitHub pane v0.9+ (from v0.8 deferrals)

- **SHIPPED 2026-07-14 — Authored PR line comments + reply threads.**
  `github_post_pr_review_comment` + `github_reply_to_pr_review_comment` landed;
  `DiffViewer` gained line-number gutters + a per-line hover composer, and
  `PullRequestReviewsPanel` gained per-thread reply. See `CHANGELOG.md`
  `[0.10.1]`. Follow-up (P3): pin the fetched diff's head sha as `commit_id`
  (today it's resolved at post time) to close a narrow concurrent-force-push
  race; and surface existing comments inline in the diff (the panel shows them,
  the diff is authoring-only for now).
- **SHIPPED 2026-07-14 — Notifications inbox.** `GET /notifications` in a
  dedicated "Inbox" subtab with unread badge, optimistic mark-as-read, and
  link-back to the source issue/PR (type-aware html_url). See `CHANGELOG.md`
  `[0.10.1]`. Follow-up (P3): background poll to keep the badge live (today the
  inbox lazy-fetches on open + manual refresh — no background cadence yet).
- **P3 — Issue → Flight auto-mirroring (bidirectional).** v0.8 has one-way
  Plane / Flight spec handoff. A "mirror this flight to GitHub issues"
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

- **Phase 1 SHIPPED 2026-07-14 — task-relevant retrieval; embeddings deferred.**
  Retrieval used to be task-*blind* (top-N by confidence, no query). It now
  ranks patterns + lessons by IDF-weighted term overlap against the task query
  blended with confidence — the injected memory is relevant to what's being
  built. See `CHANGELOG.md` `[0.10.1]`. **Phase 2 (embeddings) — DEFERRED, and
  re-scoped:** memory is a JSON blob of ≤100 patterns / ≤2000 events (not sqlite),
  so **sqlite-vss / LanceDB are unjustified** — a vector index for ≤100 rows is
  pointless. If paraphrase-misses prove real in practice, the fit is a bundled
  local embedding model (e.g. `fastembed`) with brute-force cosine over the tiny
  corpus (M, with real cross-platform ML packaging risk), NOT a vector DB. Only
  pursue once Phase 1's keyword relevance is shown insufficient.
- **SHIPPED — Pre-execution memory brief for executor sessions.** Memory is on
  by default and the pre-execution brief injects project-scoped patterns into
  flight/attempt prompts, gated by `memorySettings.injectIntoFlightPrompts`
  (default `true`; see `asyncFlightStore.ts` `getMemorySettings().injectIntoFlightPrompts`).
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
  insight (flight journal, agent transcript, code review thread)
  should have a single-click capture affordance.
- **P3 — Project-scoped filter chips in the Timeline.** (The `TimelineTab` now
  lives inside `src/components/views/MemoryView.tsx`.)
- **SHIPPED 2026-07-14 — Provenance linking on event cards** in `MemoryView`'s
  Timeline: `sessionId`/`taskId`/`flightId` labels now deep-link to the
  originating surface (guarded against dangling targets). See `CHANGELOG.md`
  `[0.10.1]`.
- **P3 — Export / import memory** as JSON+Markdown.
- **P3 — Date-range scope chips.**
- **P3 — 30-day memory digest.**

## Product tracks (from `dev/README.md`)

- **P2 — Cost dashboard alerts** (`dev/moat/cost-dashboard-plan.md`).
- **Swarm orchestration Phase 4 escalation (N2) — SHIPPED** 2026-07-14
  (→ `CHANGELOG.md` `[0.10.1]`). Decision: escalation **suggests, not acts** —
  no auto-reassignment. Built as a producer on the live *attempt* lifecycle (the
  orchestrator-scheduler substrate the plan assumed is dead): a failed attempt
  records an informational `task_failed` coordination event, and when a flight
  becomes stuck (all attempts terminal, ≥1 failed, zero successes — reached by
  failure **or** cancellation of the last sibling) it adds one signature-deduped
  `escalation` suggestion to the timeline. `src/lib/flightCoordination.ts`;
  `dev/bridgemind/swarm-orchestration-plan.md` Phase 4.
- **PacketADE MCP provider transport (N3) — SHIPPED** 2026-07-15 (→ `CHANGELOG.md`
  `[0.10.1]`). PacketADE exposes itself as an MCP server over Streamable HTTP
  (`rmcp` 2.2, Rust core, loopback + bearer/Origin auth): 5 read tools + 7
  `packetade://` resources + audit feed, plus **one opt-in append-only write**
  — `append_handoff` (posts a namespaced, human-visible note to a flight's
  coordination timeline; gated behind an "Allow writes" toggle, default off;
  event-routed so the frontend is the sole state writer; the coordination log
  now round-trips through storage). `src-tauri/src/mcp_server/`.
  - **Cut (dead substrate):** the plan's other two writes, `request_review` and
    `mark_blocked`, target the amputated task/milestone tree — no frontend
    mutator exists and no live flight has tasks to mutate. Not built.
  - **Still deferred:** **Phase-3 ownership tools** (`claim_task`/`reserve_paths`/
    `release_paths`/`escalate_task`) assume the deleted orchestrator substrate;
    re-validate against the live attempt/path-ownership model before building.
- **P3 — Workspace UX gaps** — git review packet ties **SHIPPED** (N4, 2026-07-14,
  → `CHANGELOG.md` `[0.10.1]`): `ReviewPacketPanel` surfaces linked review packets
  in GitDashboard + deep-links to the live approval. Remaining nicety: open the
  git diff editor directly from the packet. Still open: command-palette
  integration of prompt library
  (`dev/zen-workspace/features-prompt-library.md`).

## Rust audit follow-ups (from v0.9.2 / v0.9.3 Phase C+D waves)

Items surfaced by the Phase C `core/` library audit that didn't ship in
Phase D. Backend is 100% audit-covered now; these are the next-tier
hardening passes worth doing when context allows.

**SHIPPED 2026-07-14 — P3 cleanup batch** (verified against current code first):
tool-arg-JSON parse now `tracing::warn!`s before coercing to `{}` (4 sites in
`llm_anthropic.rs` / `llm_openai_compat.rs`); `include_usage` extended to MiniMax
(Ollama deliberately left out — older builds reject unknown params); SSH
`project_path` degradation in `tool_custom_agent.rs` documented; dead
`_title_unused` binding removed from `worktree.rs`; `orchestrator.rs` `unwrap()`
after `is_none()` replaced with `let-else`; `pty.rs` transcript-init failure now
`warn!`s. **Verified ALREADY-DONE (dropped):** `tool_web.rs` regex hoist (LazyLock,
shipped in RA2/RA3), `hooks.rs` payload-serialize warn, `commands/mcp.rs` atomic
write (F21), `migration.rs` cross-volume copy fallback. **OBSOLETE:**
`flight_planner_prompts.rs` LoC bloat (file deleted with the planner). **NOT a
bug:** finish_reason "stop" tool flush (guarded by `!current_tool_id.is_empty()`).
**Deferred (not trivial):** brand `const` interpolation (`llm_system_prompt.rs`,
purity nit); PR-body `NamedTempFile` (needs the `tempfile` dep); the
`pick_heredoc_terminator` / subagent / worktree-hook dedups (refactors, churn+risk);
the pty reader-thread error-spin log (needs log-once, not a naive warn).

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
  assistant message ended _without_ a tool call. Verify intent.
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
- **P3 — `core/flight_planner_prompts.rs` LoC bloat (1,656).**
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

**Batch A + Batch B — SHIPPED (moved to `CHANGELOG.md` by H1).** Both remediation
batches have landed and are recorded in the changelog:
- **Batch B** ("it silently failed"): F13, G23, G24, G25, F33, F34, G02. F34
  shipped as a truthfulness fix (`target_spec` returned in `deferred_fields`);
  durable Task-level `target_spec` persistence remains future work.
- **Batch A** (data-loss / corruption): F19, F20, F09, F10, F44, F48, F52, F56,
  G18, plus atomic MCP writes (F21). F52's caveat stands: `flight.issueIds` is a
  derived frontend cache, so a backend-authoritative Flight↔issue link is a
  deliberate later effort.

**Obsoleted by the single-surface refactor (nothing to fix):**
F49 (`FlightList.tsx` deleted; `FlightsView.tsx` no longer derives flight status
from issues), F48 (`flights/FlightDetail.tsx` —
already Batch A), F33 (`orchestrationSchedulerStore.ts` — already Batch B), and
G31 (`orchestrationSchedulerStore.ts`). The referenced files no longer exist in
the tile-program single surface.

**Still verified-open** (audit-confirmed against current code): _(none — F02 and
G16 both SHIPPED 2026-07-14, see below.)_
(F40 SSRF — SHIPPED 2026-07-14, see below. F24 — orphaned deploy code, superseded
by the "Deploy command family orphaned" item in the P2 batch summary. F50, F38 —
shipped in the H4 wave.) Other findings below that are not annotated as
shipped/obsolete predate the single-surface refactor and await per-finding
re-verification against current code.

### P1 — confirmed high

> ~~**F40 — `web_fetch` is an unrestricted SSRF primitive**~~ — **SHIPPED
> 2026-07-14 (→ `CHANGELOG.md` `[0.10.1]`).** `core/tool_web.rs` now blocks
> private/loopback/link-local/metadata IP ranges (incl. IPv4-mapped, NAT64, 6to4,
> and IPv4-compatible embedded-IPv4 forms), validates every hostname at connect
> time via a custom DNS resolver (closing the rebinding TOCTOU across the initial
> request and every redirect hop), pre-screens IP-literal hosts and their
> encoding bypasses, and caps + re-checks (scheme + IP) each redirect. Shipped
> with the body-size cap and untrusted-content envelope (the paired
> `tool_web.rs` items). 2-agent security-reviewed; 11 unit tests.

- ~~**F02 — one invalid UTF-8 byte freezes a terminal forever** (unbounded `pending`) — `core/pty.rs`.~~ **SHIPPED 2026-07-14.** `decode_terminal_chunk` now uses `Utf8Error::error_len()` to distinguish an incomplete trailing sequence (buffer it) from a genuinely invalid byte (emit U+FFFD, skip it) — an incremental lossy decode, so a bad byte can no longer re-queue forever. Tests cover invalid→flush, a flood of invalid bytes staying bounded, and invalid-then-incomplete.
- ~~**F13 — deploy run stuck "running" forever on EIO**~~ — **SHIPPED (Batch B → CHANGELOG).**
- ~~**F19 — MCP write clobbers shared `~/.claude/settings.json` on parse failure**~~ — **SHIPPED (Batch A → CHANGELOG).**
- ~~**F20 — MCP server edit drops `disabled`/`type`/`url`/`headers`**~~ — **SHIPPED (Batch A → CHANGELOG).**
- **F50 — duplicate pane IDs collide after hydration** — `stores/workspaceStore.ts`. `crypto.randomUUID()` or reconcile `wsCounter`. **(being fixed by H4 this wave.)**
- **F53 — cross-arch build bundles the wrong native sidecar binary** — `scripts/prune-sidecar.js:171-193`. Target-aware prune + release-gate assert.
- **G01 — sidecar + grandchildren orphaned on app exit** (no `kill_on_drop`/shutdown) — `agent_sidecar/supervisor.rs`, `lib.rs`.
- ~~**G02 — sidecar restart silently bricks live sessions**~~ — **SHIPPED (Batch B → CHANGELOG).**
- **G09 — Codex `respondPermission` writes to a stdin `codex exec` ignores → turn hangs** — `providers/openai-codex.ts:895-929`.
- ~~**G16 — OpenAI-compat parallel tool calls collapse/cross-contaminate (`index` ignored)** — `core/llm_openai_compat.rs`.~~ **SHIPPED 2026-07-14.** The streamer tracked a single `current_tool_*` scalar, so parallel tool calls (distinguished only by `tool_calls[].index`, with possibly-interleaved arg deltas) collapsed onto one another. Now accumulated per-index in a `BTreeMap` (pure `accumulate_tool_call_delta` / `drain_tool_calls` helpers), emitting one `ToolUseEnd` per call in index order. Also guards the non-standard index-omitting-multiple-calls case (roll the slot on a new id). 4 tests cover interleaved parallel, start-once-per-index, index-omitting rollover, and single-call. 2-agent-reviewed.
- ~~**G23 — orchestrated PTY task success uses exit reason, not exit code**~~ — **SHIPPED (Batch B → CHANGELOG).**
- ~~**G25 — async attempt has no terminal transition on done/error**~~ — **SHIPPED (Batch B → CHANGELOG).**
- **G33 — Stop with a queued message re-sends it (cancel emits `done` → drain)** — `agentTaskStore.ts`, `apiAgentListeners.ts`.

### P2 — confirmed medium

- **F01 — `kill_pty`/`kill_sessions` leak zombie children on Unix** — `commands/pty.rs:393-410,117-128,329-331`.
- **F06 — keyring password forwarded to remote stdin on ControlMaster-reused SSH** — `core/tool_runtime_ssh.rs:106-138`.
- ~~**F09 — keyring migration deletes legacy cred even when new write fails**~~ — **SHIPPED (Batch A → CHANGELOG).**
- ~~**F10 — Gemini key migration deletes localStorage in `finally` even when keyring throws**~~ — **SHIPPED (Batch A → CHANGELOG).**
- **F11 — password auth writes to ssh stdin OpenSSH doesn't read** — `core/tool_runtime_ssh.rs:128-138`.
- **F16 — leading-edge auth-watcher debounce drops the authoritative cred write** — `auth_watcher.rs:201-211`.
- **F23 — `DeployConfig.env` typed end-to-end but never applied to the command** — `deploy.rs:9-15,220-264`.
- **F24 — deploy runs cannot be cancelled (no kill handle / `kill_deploy`)** — `deploy.rs:266-327`. _(verified open.)_
- **F28 — `send`/`retry` overwrite the in-process cancel sender, cancelling a running turn** — `api_agent.rs:701-724,1015-1037`.
- **F32 — failed API `sendMessage` leaves the bubble spinning forever** — `agentTaskStore.ts:1072-1098`.
- ~~**F33 — orchestration scheduler silently swallows backend tick failures**~~ — **OBSOLETE — `orchestrationSchedulerStore.ts` deleted (was also Batch B).**
- ~~**F34 — `update_task` `target_spec` reported landed but silently dropped**~~ — **SHIPPED (Batch B → CHANGELOG).**
- **F38 — `useVoiceInput` never stops recognition/native recording on unmount** — `hooks/useVoiceInput.ts:63-153`. _(verified open; being fixed by H4 this wave.)_
- ~~**F44 — `migrateLegacyStorage` mutates localStorage while iterating by index → loses keys**~~ — **SHIPPED (Batch A → CHANGELOG).**
- **F46 — streamed UTF-8 multibyte corrupted when split across chunks (both streamers)** — `llm_anthropic.rs:213`, `llm_openai_compat.rs:234`.
- ~~**F48 — FlightDetail unlink clears `issue.flightId` but not `flight.issueIds`**~~ — **SHIPPED (Batch A → CHANGELOG); `flights/FlightDetail.tsx` since deleted.**
- ~~**F49 — flight status never recomputes when an issue changes**~~ — **OBSOLETE — `FlightList.tsx` deleted; `FlightsView.tsx` no longer derives flight status from issues.**
- **F51 — `flightStore.hydrateFromBackend()` clobbers in-flight optimistic mutations** — `flightStore.ts:688-698`.
- ~~**F52 — `issueStore` localStorage-authoritative, never hydrated, lossy backend mirror**~~ — **SHIPPED (Batch A → CHANGELOG).**
- **F55 — `FlightStatus` contract test asserts a hand-kept length, missing `spec`** — `__tests__/contract.test.ts:167-180`.
- ~~**F56 — SSH-target→serverStore migration untested, deletes legacy keys before save lands**~~ — **SHIPPED (Batch A → CHANGELOG).**
- **G03 — `truncate()` panics on a multibyte UTF-8 boundary, killing the reader loop** — `agent_sidecar/handler.rs:933-939`.
- **G08 — Codex cancel surfaces a spurious `error` banner instead of clean cancellation** — `providers/openai-codex.ts:458-483`. _(panel: high→medium)_
- **G10 — Codex `agent_message_delta` + `agent_message` duplicate assistant text** — `providers/openai-codex.ts:543-560`.
- **G11 — Anthropic `respondEdit` resolves ALL pending edits on one response** — `providers/anthropic.ts:1029-1071`.
- **G17 — token/cost always zero for MiniMax & Ollama (`include_usage` gated)** — `llm_openai_compat.rs:178-180`. _(see existing P3 entry)_
- ~~**G18 — empty assistant message persisted → Anthropic 400s the next turn**~~ — **SHIPPED (Batch A → CHANGELOG).**
- ~~**G24 — backend-initiated PTY kill reported to frontend as successful completion**~~ — **SHIPPED (Batch B → CHANGELOG).**
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
- ~~**F21** MCP writes non-atomic — `commands/mcp.rs:167-168,195-197`.~~ **RESOLVED 2026-06-15**: `write_pretty_json` now writes via temp file + `sync_all` + atomic rename (mirrors `core::storage::write_with_backup`).
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
- **F58** Flight Planner rate-limit backoff clamp untested — `flight_planner.rs:910-912`.
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
- ~~**G31** orphaned running task permanently consumes a parallel slot~~ — **OBSOLETE — `orchestrationSchedulerStore.ts` deleted in the single-surface refactor.**
- **G34** auto-failover system notice deleted by `retryLastTurn` truncation — `apiAgentListeners.ts:281-298`. _(panel: med→low)_
- **G35** late tool-result after turn end silently dropped — `apiAgentListeners.ts:156-189`.
- **G36** done notification + queue drain fire even on user cancel — `apiAgentListeners.ts:251-265`.

**Refuted (do not action):** F07, F08, F14, F30, F31, F45 (F-series) · G12, G19, G22, G27, G28, G37 (G-series). Reasons in the report §1.
