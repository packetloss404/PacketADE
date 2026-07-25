# Backlog

Master source for outstanding work in PacketADE. When an item ships, move it
to the matching version section in [`CHANGELOG.md`](./CHANGELOG.md) and remove
it from here.

Priority: **P1** = real bug or major user-facing gap · **P2** = correctness/UX
· **P3** = cleanup.

## Cross-cutting reliability

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
envelope should treat that event shape as a stable input. The removed autonomous
Flight Planner does not gate this work; the smaller Flight Deck product decision
below is independent.

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

> **Scoped into a gated loop:** [`dev/ssh-remote-loop.md`](./dev/ssh-remote-loop.md)
> (S1–S11). Safety first (process-tree kill, keyPath hygiene, remote-git path
> guards), then wire hygiene, then Windows-OpenSSH / `realpath` platform parity;
> S11 (live smoke) is environment-gated.

- **P2 — Live Codex-over-SSH smoke.** The generic remote-sidecar route and
  provider capability are regression-tested, but still need one real remote
  host smoke with remote Codex auth and the installed sidecar. Follow
  `dev/sidecar-over-ssh-verification.md` step 12. The 2026-07-19 development
  environment had no configured SSH server, so this remains environment-gated.
- **P3 — Rust bash/ssh tools orphan grandchildren on timeout.** The
  abnormal-termination PR added `kill_on_drop(true)` to `tool_runtime.rs`
  (`execute_bash`) and `tool_runtime_ssh.rs` (`ssh_run`), but that only reaps
  the direct child (the `sh -c` / `cmd /C` shell or the local `ssh` client) —
  not the grandchildren it spawned (build, `node`, dev server) or the remote
  process. The sidecar bash tool now does a full process-group / `taskkill /T`
  kill (`agent-sidecar/src/providers/openai-agents.ts::killTree`); the Rust
  paths should reach parity (POSIX process-group kill, Windows `taskkill /T`,
  and `ssh -tt`/`RequestTTY` so the remote command gets SIGHUP on disconnect).
- **P3 — Remote Git polish.** Add per-file remote diff, a friendly non-fast-
  forward push message, and defense-in-depth `..`/absolute-path rejection for
  remote staging.
- **P3 — `clone_repo_remote` has no frontend caller.** The `cloneRepoRemote`
  wrapper (`src/lib/tauri.ts`) exists but nothing invokes it. Surface a "Clone
  to remote workspace" action in `WorkspaceCreationModal` / ServersView, or
  remove the binding.
- **P3 — Rename `target_id` → `server_id` across the wire.** Field name
  kept for in-flight back-compat (see `src/lib/tauri.ts:1331-1336`).
- **P3 — `resumeApiConversation` partial live-config lookup.** Resolves
  `port` / `keyPath` / `hostFingerprint` from live `ServerConfig` but uses
  persisted `host` / `user` / `remotePath`. If a user renames or repoints
  the server, resume hits the old host.
- **P3 — `cancel_flight_attempt` fingerprint asymmetry**
  (`src-tauri/src/commands/flight_attempts.rs:330-342`) — cleanup deferred
  to FE, which carries fingerprint correctly.
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

## Flight Deck

### Escalation & supervision (BridgeSwarm parity)

- **Feature loop — structured escalation + auto-reassignment.** Scoped,
  loop-ready plan at [`dev/bridgemind/flight-escalation-loop.md`](./dev/bridgemind/flight-escalation-loop.md)
  (items E1–E9): structured failure reasons, stuck-threshold detection, targeted
  reassignment suggestions, a one-click relaunch/reassign action, actionable
  coordination-feed rows, a flight attention queue, and an issue-Kanban
  Blocked/Needs-Attention column. Supersedes the stale Phase 4 of
  `dev/bridgemind/swarm-orchestration-plan.md`. Deferred behind working through
  the competitive research; not started.

### Runtime audit (2026-07-19)

The deleted backend was the long-lived autonomous **Flight Planner**, not the
live Flight Deck attempt runtime. The current Deck still creates/persists
Flights, provisions local/SSH worktrees, starts API-agent attempts, streams
their sessions, rolls up cost/status, accepts/rejects/cancels attempts, and can
publish completed local attempts as draft PRs. The Option B product decision is
implemented: “Plan first” opens a normal read-only `AgentConversation`, the user
refines and explicitly applies milestones/tasks, and attempts remain
user-launched. It does not restore Planner v1's autonomous runtime.

- **P3 — structured partial multi-target launch result.** Rust launches targets
  sequentially. If provisioning target N fails after earlier targets started,
  the frontend now rehydrates and attaches those partial successes before
  surfacing the error, so they remain visible and controllable. A future wire
  result should report per-target success/failure directly instead of requiring
  recovery by diffing the persisted Attempt set.
- **P3 — migrate or prune orphaned Planner data.** Legacy `planner_*` fields,
  approval records, and `missions/` journals are retained only so old state
  remains readable after Planner v1's removal. Define an eager migration and
  release-age gate before deleting the compatibility fields; journals can be
  offered as optional cleanup once their retention policy is explicit.

### Intentional Mission→Flight back-compat surfaces (do NOT flag as leftover)

The Mission→Flight rename (v0.9.5) deliberately keeps three read-side
compatibility surfaces so persisted user data written under the old
`missionId` / `missions` names still loads. These are intentional, not
stale-symbol misses — leave them in place until the removal criteria below
are met.

**Lazy read-side fallbacks (3 items).** All are deserialize-/read-time
only: they re-emit the canonical `flightId` key the *next* time that record is
persisted.

- **2 Rust `#[serde(alias = "missionId")]`** aliases on the legacy persisted
  Flight-approval DTO/record: `api/mod.rs` and `core/flight.rs`.
- **1 frontend store read shim:** `issueStore.ts` (`flightId` falls back to the
  legacy `missionId` key).

**Eager migration shipped 2026-07-24.** The one-shot passes now exist:
`core::migration::migrate_mission_to_flight` re-saves persisted state when the
raw file still carries a `missionId` key (canonicalizing flight-approval
records), and `migrateIssuesMissionToFlight` in `lib/storage-migration.ts`
rewrites the `missionId` link on `packetade:issues`. Both are guarded/idempotent
and run at startup.

*Removal criteria:* the eager-migration prerequisite (a) is now **met**. The
three fallbacks are removable once **(b) at least one release cycle ships with
the migration** so it has run on users' machines. Earliest realistic target is
the 1.0.0 cut (per SemVer, removals belong at a major bump). Until that release
has shipped, keep the aliases/shim so a machine that hasn't yet run the migration
still loads legacy data losslessly.

## GitHub pane v0.9+ (from v0.8 deferrals)

> **Scoped into a gated loop:** [`dev/github-pane-v9-loop.md`](./dev/github-pane-v9-loop.md)
> (GP1–GP7). New host-facing commands route through the dual-host
> `active_host_session` seam and are capability-gated for Gitea.

- **P3 — PR review concurrency and context.** Pin the fetched diff's head SHA as
  `commit_id` when authoring line comments, and surface existing review comments
  inline in the diff.
- **P3 — Notifications background polling.** The inbox currently refreshes on
  open or manually; add a conservative background cadence for a live badge.
- **P3 — Issue → Flight auto-mirroring (bidirectional).** v0.8 has one-way
  Flight spec handoff. A "mirror this Flight to GitHub issues"
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

## Git host providers — GitHub + Gitea/Forgejo (dual-config)

> **Shipped (G1–G14), peer-reviewed on `feat/gitea-support` — pending merge.**
> Ledger: [`dev/gitea-support-loop.md`](./dev/gitea-support-loop.md). Self-hosted
> **Gitea/Forgejo** alongside cloud GitHub, **both configurable at once** — a
> workspace uses whichever host its `origin` remote belongs to, and the pane's
> icon/labels follow that host. The single in-memory GitHub token became a
> keyring-backed **list of git-host connections** behind `core/git_host.rs`; the
> ~45 GitHub commands route through the active connection. Read + write paths,
> reviews, notifications, capability-gating, and branding all land.
>
> **Deferred follow-ups:** Gitea agent-tool (`gh_*`) parity + a `tea`/API
> create-PR path (`core/tool_github.rs`, `core/tool_pull_request.rs` stay
> GitHub-scoped); richer Gitea Actions/check-runs surfacing (currently degraded
> to empty); Gitea inline PR-review-comment authoring (v1 gated — viewing works);
> AI compare-diff for Gitea multi-commit PRs.

## Memory v0.9+ (from v0.8 deferrals)

> **Shipped:** the M1–M10 loop ([`dev/memory-v9-loop.md`](./dev/memory-v9-loop.md))
> was peer-reviewed and merged to `main` on 2026-07-24 — IDF-ranked Timeline
> search (M1), project + date-range scope chips (M2), export/import JSON+MD (M3),
> "+ Add to memory" on the flight timeline + agent transcript (M4), confidence
> auto-rerating on flight outcome (M5), recurring-error "this looks familiar"
> launch hint (M6), 30-day digest (M7), "Ask your project" tab (M8), the wired-in
> `summarize_flight` retrospective (M9), and retirement of the dead
> `task_completed` path (M10). Only the deferred item below remains open.

- **P3 (deferred) — Evaluate semantic retrieval only if keyword misses are
  measured.** If the current IDF-weighted retrieval proves insufficient, use a
  bundled local embedding model plus brute-force cosine over the small JSON
  corpus; a vector database is not justified at its current size. M1's IDF scorer
  and M8's Ask tab now make keyword quality measurable — revisit only if it falls
  short.

## Product tracks (from `dev/README.md`)

- **P3 — Open the git diff editor from a review packet.** The packet already
  deep-links to approval; add the direct diff-editor route.
- **P3 — Prompt-library command-palette integration.** See
  `dev/zen-workspace/features-prompt-library.md`.

## Rust audit follow-ups (from v0.9.2 / v0.9.3 Phase C+D waves)

Only unresolved follow-ups remain here; shipped audit work is in `CHANGELOG.md`.

### LLM provider stack

- **P3 — Ollama usage discovery.** MiniMax now requests usage, but older Ollama
  builds reject the same option. Detect supported Ollama versions/capabilities
  before enabling it so local token/cost reporting is not permanently zero.

### Tool runtime


### MCP / workspace / runtime

- **P3 — `worktree.rs` `attempt_id` ASCII sanitization.** Today the
  callers always pass UUIDs from `commands/flight_attempts.rs` / `commands/git.rs`,
  but the public function has no defence-in-depth. Tighten to
  ASCII-alphanumeric + `-_`.
- **P3 — `core/mcp_bridge.rs::resolve_mcp_name` per-call server
  re-spawn.** Every `mcp__*` tool call re-spawns every enabled MCP
  server and re-runs `tools/list`. Cache the advertised-name →
  (server, tool) map at agent-session start.
- **P3 — `core/hooks.rs:205` payload-serialize fallback.** It logs
  before falling back to `b"{}"` (landed in v0.9.3), but consider
  whether `serde_json::Value` failing to encode is recoverable at
  all — could promote to error.
- **P3 — `core/pty.rs:253-263` reader-thread error spin.** Only
  `BrokenPipe` exits the loop; a persistent OS-level error retries
  silently. Log once per error kind to make the spin visible.

### Test gaps (carried from earlier in the session)

- **P3 — `InvestigationPanel` Draft-patch error path missing test.**
- **P3 — `PendingApprovalsSection` Y/N keyboard edge cases missing
  test** (e.g., focused inside an input — should not consume).
- **P3 — `forkAndResend` should clear `agentPlanStore`.** 1-line
  follow-up from the v0.9.0 S1 refactor.
- **P3 — `IssueCommentList.tsx` duplicate `timeAgo` helper.**
  Surface caught during the v0.9.1 T2c dedup pass; not addressed
  because it lives outside the GitHubView surface that owned T2c.

## Reliability audit follow-ups

Full evidence for the original findings remains in
[`dev/code-review-2026-06-07.md`](./dev/code-review-2026-06-07.md). This section
contains only unresolved items.

No unresolved low-rated findings remain. The 30-item remediation loop completed
on 2026-07-19; its per-finding acceptance evidence and gate record live in
[`dev/reliability-low-fix-loop-2026-07-19.md`](./dev/reliability-low-fix-loop-2026-07-19.md).
