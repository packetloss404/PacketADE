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

> **Loop shipped (S1–S8):** [`dev/ssh-remote-loop.md`](./dev/ssh-remote-loop.md).
> Process-tree kill (S1), keyPath hygiene (S2), remote-git polish + confined
> per-file diff (S3), backend-cancel fingerprint pinning (S4), resume live-config
> (S5), clone-to-remote (S6), and portable `realpath`→`readlink` confinement
> fallback (S8) all landed and merged. Only the environment-blocked items below
> remain.

- **P2 — Live Codex-over-SSH smoke (S11).** Still needs one real remote host
  with remote Codex auth + installed sidecar. Follow
  `dev/sidecar-over-ssh-verification.md` step 12. Environment-gated (no SSH
  server configured in the dev env).
- **P3 — Rename `target_id` → `server_id` across the wire (S7).** Deferred:
  the wire type is the ts-rs–generated `AttemptTargetDto`, so the rename needs
  `pnpm generate:tauri-schema` + `check:tauri-schema`, both of which run a
  `cargo test` that can't execute under WSL. Do on a native build (rename the
  Rust field with `#[serde(alias="target_id")]` read shim + a deser test, regen
  the schema, then sweep the ~14 `attempt.target.targetId` FE sites).
- **P3 — Windows-OpenSSH remote hosts (S9).** `ssh_check_remote_path` and the
  remote git scaffolding assume a POSIX remote shell (`[ -e ... ]`, `dirname`,
  heredocs); they break where the remote default shell is cmd.exe/PowerShell.
  Deferred: needs a real Windows-OpenSSH host to build+verify the cmd/PS
  dialect. Keep POSIX as the default branch; add an OS-detection probe and a
  unit-tested Windows command builder.
- **P3 — SFTP / port-forward / raised file-size cap (S10, Phase 4.3).** Remote
  files cap at 2 MB (`MAX_FILE_SIZE`, `src-tauri/src/core/tool_runtime_ssh.rs`).
  Deferred: streamed-transfer correctness (chunk boundaries, reassembly of a
  >2 MB file) needs a live remote to verify. Ship the streamed cap before
  port-forward.

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

- **✅ Shipped — assisted Flight escalation (Option B confirmed 2026-07-27).**
  The completed E1–E9 loop at
  [`dev/bridgemind/flight-escalation-loop.md`](./dev/bridgemind/flight-escalation-loop.md)
  delivers structured failure reasons, stuck-threshold detection, targeted
  reassignment suggestions, a one-click relaunch/reassign action, actionable
  coordination-feed rows, a Flight attention queue, and an issue-Kanban
  Blocked/Needs-Attention column. Detection and recommendations are automatic;
  retry/reassignment remains user-approved. Do not add silent relaunching to
  PacketADE or revive the retired autonomous scheduler.

### Reviewer quality gate

- **✅ Implemented — Option B: enforced review with explicit human override.**
  RG1–RG7 are closed in
  [`dev/bridgemind/reviewer-gate-loop.md`](./dev/bridgemind/reviewer-gate-loop.md).
  The gate is opt-in per Flight; reaching `reviewing` starts one selected,
  read-only reviewer. A non-pass verdict blocks normal acceptance, while an
  explicit override remains available and is recorded. Draft PRs may still be
  created for visibility. No silent merge or unbounded builder↔reviewer loop.
  RG8 remains a release-like local/SSH/manual smoke gate.

### Cooperative Flight task graph

- **✅ Implemented — Option B: assisted execution.** CG1–CG8 are closed in
  [`dev/bridgemind/cooperative-flight-graph-loop.md`](./dev/bridgemind/cooperative-flight-graph-loop.md).
  An applied plan becomes a validated role/dependency graph; the user launches
  ready batches, accepted work converges on an isolated Flight integration
  branch, and dependents unlock from accepted upstream state. No autonomous
  decomposition or background launch is part of the default mode. CG9 retains
  the release-like local/SSH/manual landing gate.

### YOLO / bounded autonomy overlay

- **✅ Implemented — preserve Option B as the default and make autonomy
  explicit.** AP1–AP8 are closed in
  [`dev/bridgemind/autonomy-policy-loop.md`](./dev/bridgemind/autonomy-policy-loop.md)
  after the assisted actions stabilized. Settings owns the default, each Flight
  displays and snapshots its effective policy, and auto-recovery,
  reviewer-remediation, graph execution, and tool permissions are independently
  controlled. Cost/time/retry/concurrency/root/target limits and a kill switch
  are required. YOLO never auto-overrides a reviewer failure, silently resolves
  conflicts, or lands onto a protected/base branch. AP9 remains the adversarial
  release-like smoke gate.

### Coordination inbox and steering

- **✅ Implemented — Option B: structured steering inbox.** CI1–CI8 are closed in
  [`dev/bridgemind/coordination-inbox-loop.md`](./dev/bridgemind/coordination-inbox-loop.md).
  Persist typed messages and acknowledgements; let users target an attempt,
  task, role, or whole Flight; deliver API-agent messages at safe turn
  boundaries; expose a scoped inbox through the PacketADE MCP provider for PTY
  agents. Do not silently type into terminals. Direct agent↔agent forwarding is
  available only through the bounded YOLO policy. CI9 retains the release-like
  local/SSH/manual delivery matrix.

### PacketAgent deployment handoff

- **Approved — Option B: deploy and supervise.** Implement the PacketADE PH1–PH10
  loop in
  [`dev/bridgemind/packetagent-handoff-loop.md`](./dev/bridgemind/packetagent-handoff-loop.md)
  against PacketAgent W9 and its versioned `WorkerPackage` contract. PacketADE
  validates, deploys, activates, reconnects, displays events/evidence, and
  exposes Pause/Resume/Stop/approval controls. PacketAgent owns durable
  execution after PacketADE closes. PH1–PH10 remain blocked until their named
  PacketAgent W1–W9 dependencies exist; do not fake durability in the desktop
  process. PacketAgent implementation is owned by its separate Codex project;
  this repository owns only the PacketADE handoff contract and consumer work.

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

## Packet suite cross-product

### PacketCode / BridgeCode response

- **✅ Source integration implemented — Option B: independent PacketCode
  install/update channel with separate executable and data-home overrides.**
  PC1–PC4 and PC6–PC8 are closed in
  [`dev/bridgemind/packetcode-bridgecode-loop.md`](./dev/bridgemind/packetcode-bridgecode-loop.md).
  PacketADE now models the executable, local/remote `PACKETCODE_HOME`,
  developer checkout, release channel, strict version detection, bounded
  `doctor --json` probe, platform-aware install/update, and correct local/SSH
  launch environments. The sibling PacketCode source now supplies the home and
  doctor contracts, checksum-verifying Windows installer, structured bounded
  loop decisions, per-server MCP restart, feature-truth audit, and hardening
  ledger. PC5 still requires published signed artifacts and clean-machine
  install/upgrade/rollback proof; PC9 continues the lower-priority PacketCode
  hardening queue; PC10 awaits the separate PacketAgent compatibility contract
  and a packaged cross-repo smoke. BridgeCode was discontinued and remains only
  a historical workflow benchmark.

## GitHub pane v0.9+ (from v0.8 deferrals)

> **Loop shipped (GP1–GP7, merged 2026-07-25):**
> [`dev/github-pane-v9-loop.md`](./dev/github-pane-v9-loop.md). Inline review
> comments (GP1), notifications polling (GP2), OAuth device-flow (GP3), Windows
> hook shell-detection (GP4), SSH draft-PR publish (GP5), releases view (GP6),
> and the Issue⇄Flight mirror **design** (GP7,
> [`issue-flight-mirror-design.md`](./dev/issue-flight-mirror-design.md)) all
> landed. Peer-reviewed. Only the design-gated sync code remains:

- **P3 — Issue ⇄ Flight two-way mirroring (code).** Decisions locked; see
  [`dev/issue-flight-mirror-design.md`](./dev/issue-flight-mirror-design.md).
  **P0 landed** (`src/lib/issueFlightMirror.ts` — pure `diffMirrorState` planner,
  `MirrorRecord`/`advanceMirrorRecord`, body-marker helpers, `resolveMirrorTarget`;
  36 tests, peer-reviewed). Remaining: **P1** push-only I/O (build issues from
  Flight state via `diffMirrorState.toPush` + the marker), then **P2** pull, then
  **P3** conflict-resolution UI — each gated. Do not enable P2 until P1 is green.

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
