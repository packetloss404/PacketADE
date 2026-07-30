# Backlog

Master source for outstanding work in PacketADE. When an item ships, move it
to the matching version section in [`CHANGELOG.md`](./CHANGELOG.md) and remove
it from here.

Priority: **P1** = real bug or major user-facing gap · **P2** = correctness/UX
· **P3** = cleanup.

## Dictation reliability and BridgeVoice response

Canonical repair record:
[`dev/bridgemind/dictation-repair-hardening-loop.md`](./dev/bridgemind/dictation-repair-hardening-loop.md).
Option B keeps Dictation inside PacketADE and local-first. The broken baseline
path has been repaired: verified model selection/fallback, native microphone
formats, downmix/resampling, saved-device use, lifecycle/cancel, event shape,
language/dictionary, Windows clipboard/opt-in foreground paste, history, and
Composer/store convergence.

- **P1 — live microphone acceptance matrix.** This Windows host currently has
  no active capture endpoint, so run the packaged default/USB/Bluetooth,
  44.1/48 kHz, fast-PTT, cancel, disconnect, repeated phrase, first-model-load,
  history, in-app, clipboard, and external-app matrix when a microphone is
  connected or enabled.
- **P2 — packaged cross-platform dictation matrix.** Source prerequisites are
  present (`NSMicrophoneUsageDescription`, Debian `libasound2`, stable device
  IDs, bounded doctor/recovery, safe native targets). Verify macOS microphone
  and accessibility prompts plus Linux ALSA/PipeWire and X11/Wayland fallback
  behavior in real packaged builds.
- **P3 — alternate engine benchmark.** Benchmark Parakeet and optional Whisper
  acceleration only after the repaired CPU path has packaged latency/quality
  measurements; do not add a cloud dependency by default.

## Remote Agents (preserved; currently paused)

Canonical plan: [`dev/remoteagents/README.md`](./dev/remoteagents/README.md).
This remains the next major networked product bet: PWA first, Packet account
sign-in, Packet Cloud relay, desktop-owned providers/secrets/tools, and no
generic remote Tauri bridge.

**Sequencing note.** Workspace/Agents restructuring and the six-group Settings
information architecture are complete. The current owner decision pass is the
[`main-shell/right-panel audit`](./dev/main-shell-navigation-and-right-panel-audit-2026-07-29.md).
Remote Agents is preserved at its current Sprint-0 decision gate and resumes
after that pass or explicit owner reprioritization. Its relay reuses the same
`api-agent:*` event contract that conversations already emit, so the "stream
`api-agent:*` / respond to prompts / cancel" envelope remains a stable future
input.

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
- **P3 — Windows-OpenSSH remote hosts (S9).** `ssh_check_remote_path` and the
  remote git scaffolding assume a POSIX remote shell (`[ -e ... ]`, `dirname`,
  heredocs); they break where the remote default shell is cmd.exe/PowerShell.
  Deferred: needs a real Windows-OpenSSH host to build+verify the cmd/PS
  dialect. Keep POSIX as the default branch; add an OS-detection probe and a
  unit-tested Windows command builder.
- **P3 — SFTP / port-forward / raised file-size cap (S10, Phase 4.3).** Remote
  files cap at 2 MB (`MAX_FILE_SIZE`, `src-tauri/src/core/tool_runtime_ssh.rs`).
  Deferred: streamed-transfer correctness (chunk boundaries, reassembly of a
  > 2 MB file) needs a live remote to verify. Ship the streamed cap before
  > port-forward.

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
  - DEB only. Snap/Flatpak would broaden distro reach.
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

- **Source consumer implemented — Option B: deploy and supervise.** PacketAgent
  published W9 at commit `dd8a5c93779a9ecc8af96bb232adcb5be0bdf16e`.
  PacketADE now pins that contract, reproduces its canonical fixture digest,
  stores the bearer token only in the OS keyring, validates/deploys/activates
  Flight packages, persists deployment/cursor references, polls and
  acknowledges ordered events, surfaces evidence, and provides
  inspect/pause/resume/revoke controls. The detailed PH1–PH10 status is in
  [`dev/bridgemind/packetagent-handoff-loop.md`](./dev/bridgemind/packetagent-handoff-loop.md)
  and remains cross-repository. Still open: a live W9 close/restart/reconnect
  gate with configured credentials; direct PacketADE approval responses
  (PacketAgent W9 publishes attention events but no approval-response route);
  task/conversation source builders; richer attention/cost projection; and a
  packaged evidence/artifact return-and-land matrix. PacketAgent continues to
  own durable execution after PacketADE closes.

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
only: they re-emit the canonical `flightId` key the _next_ time that record is
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

_Removal criteria:_ the eager-migration prerequisite (a) is now **met**. The
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

### PacketCode remaining hardening

These PacketCode-owned items are duplicated here intentionally so PacketADE's
master ledger does not hide them behind the broad PC9 status. The implementation
source of truth is
`D:\projects\packetcode\docs\bridgecode-plus-hardening-loop-2026-07-27.md`.

- **P2 — versioned workflow verifier/retry (PCH3).** Let a workflow declare a
  verifier prompt/provider/model, versioned pass contract, and retry cap.
  Missing or malformed verdicts never pass, and retries count against token and
  agent budgets.
- **P2 — abandoned-job reconcile/resubmit (PCH4).** After restart, show the old
  job as recovered/cancelled with its evidence intact and offer an explicit
  bounded resubmit from saved input. Never claim that the dead process resumed.
- **P3 — Streamable HTTP MCP trust contract (PCH5).** Design explicit network
  targets, credentials, redirect/origin rules, output provenance, and approval
  scopes before enabling remote MCP transport in PacketCode.
- **External release gates (PCH6–PCH8).** Publish signed stable/preview builds,
  run clean-machine install/update/rollback and packaged PacketADE smoke, then
  consume PacketAgent's versioned contract when its active separate project
  publishes it.

## GitHub pane v0.9+ (from v0.8 deferrals)

> **Loop shipped (GP1–GP7, merged 2026-07-25):**
> [`dev/github-pane-v9-loop.md`](./dev/github-pane-v9-loop.md). Inline review
> comments (GP1), notifications polling (GP2), OAuth device-flow (GP3), Windows
> hook shell-detection (GP4), SSH draft-PR publish (GP5), releases view (GP6),
> and the Issue⇄Flight mirror **design** (GP7,
> [`issue-flight-mirror-design.md`](./dev/issue-flight-mirror-design.md)) all
> landed. Peer-reviewed. Only the design-gated sync code remains:

- **P2 — Issue ⇄ Flight live host proof.** The P0–P3 source implementation is
  complete: mapping-B task issues grouped under a Flight milestone, fallback
  Flight issue, hidden-marker adoption, GitHub/Gitea host routing, 60-second
  visibility-aware pull/push, revision fences, LWW conflict preservation, and
  an acknowledgement UI. See
  [`dev/issue-flight-mirror-design.md`](./dev/issue-flight-mirror-design.md).
  Run the packaged GitHub + Gitea matrix (create/adopt/update/pull/conflict,
  hidden-window pause, restart, and revoked-auth recovery). Flight tasks do not
  yet own labels, so v1 preserves host labels rather than inventing a second
  local label model.

## Git host providers — GitHub + Gitea/Forgejo (dual-config)

> **Shipped (G1–G14), peer-reviewed and merged to `main`.**
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

### Project-local Memory Hub (BridgeMemory response)

- **P2 — packaged project-memory interoperability proof.** MH1–MH7 source work
  is complete: `.agents/memory` Markdown/frontmatter, safe CRUD/revisions,
  graph/backlinks/health, unified IDF retrieval, provenance capture, Memory UI,
  and permission-gated MCP access are implemented. Complete MH8/MH9 by running
  the real editor/watch-storm/partial-write/rename/restart matrix plus
  empty/large/dirty/gitignored packaged-project smoke on available platforms.
  PacketADE deliberately does not edit `.gitignore`.

## Local-First MCP Hub (BridgeMCP response)

- **P2 — live/packaged MCP Hub proof.** MCPH1–MCPH7 source work is complete:
  lossless config inventory, official review-before-add catalog, stdio doctor,
  frozen per-session trust in protocol v11 and in-process providers, and the
  Codex CLI trust proxy that exposes only the frozen allowlisted server/tool
  surface and re-checks path/write denial floors at call time. The Hub also has
  redacted audit, explicit reconnect, and suite resources for Flights, Issues,
  coordination, reviews, Memory, workspaces, and PacketCode health. Complete
  MCPH3/MCPH8 with a real Codex CLI plus local/SSH crash/reload/version-skew,
  offline install/removal, trust downgrade/reconnect, remote-profile parity,
  and packaged provider smoke. Streamable HTTP/SSE config is preserved but the
  local doctor probes stdio only; stdio child-process network access is not an
  OS sandbox.

## Trust and provenance

- **P2 — packaged provenance parity proof.** TP1–TP7 source work is complete:
  the schema-v1 origin/authority/integrity/lineage envelope, ingestion
  normalization, legacy-unknown hydration, compact chips, tainted-turn gates,
  downstream Flight/Memory/reviewer/coordination lineage, and bounded redacted
  audit are implemented. Complete TP8 with live local/SSH and all-provider
  transport parity, MCP remote, restart, YOLO, and packaged visual/manual
  smoke. Do not weaken denial floors to make a provider pass.

## Rust audit follow-ups (from v0.9.2 / v0.9.3 Phase C+D waves)

Only unresolved follow-ups remain here; shipped audit work is in `CHANGELOG.md`.

### MCP / workspace / runtime

- **P3 — `core/mcp_bridge.rs::resolve_mcp_name` per-call server
  re-spawn.** Every `mcp__*` tool call re-spawns every enabled MCP
  server and re-runs `tools/list`. Cache the advertised-name →
  (server, tool) map at agent-session start.

## Monitor windows

- **P2 — packaged/manual Monitor proof.** The read-only v1 source is complete:
  one reusable backend-leased `monitor-main`, narrow Tauri capability, separate
  boot shell, Agent and Flight projections, source-surface actions, safe stale
  states, focus-back-to-main routing, read-only conversation hydration, and a
  deny-by-default secondary-window application-command boundary that rejects
  PTY/API-agent/approval/write/deploy/secret mutation. Run the packaged
  multi-display matrix, verify the Monitor window closes with the main process
  on each platform, and add packaged WebView-to-Rust denial integration proof.
  Approval/Cost monitors,
  saved bounds, multiple simultaneous Monitor windows, and PTY attachment stay
  later; terminal mirroring must not mount or own the live PTY.

## Workspace/Agents restructuring and Settings contract

Canonical goal:
[`dev/workspace-agents-restructuring-goal.md`](./dev/workspace-agents-restructuring-goal.md).
Locked WA0 implementation contract:
[`dev/workspace-agents-wa0-route-contract.md`](./dev/workspace-agents-wa0-route-contract.md).
Supporting evidence and the separate Settings audit:
[`dev/workspace-agent-settings-decision-2026-07-29.md`](./dev/workspace-agent-settings-decision-2026-07-29.md).
WA3 implementation evidence:
[`dev/workspace-agents-wa3-handoff-evidence.md`](./dev/workspace-agents-wa3-handoff-evidence.md).
WA4 evidence gate:
[`dev/workspace-agents-wa4-dogfood-gate.md`](./dev/workspace-agents-wa4-dogfood-gate.md).

The Workspace/Agents direction is approved, and the six-group Settings
information architecture is implemented. Remaining Settings work is limited to
the authority and capability gaps below. Do not delete the current conversation
engine or persisted conversation panes as cleanup.

- **P0 — WA0: route/ownership contract. COMPLETE.** Every
  entry/deep-link/wrapper/creation path, persistence carrier, compatibility
  rule, handoff boundary, multi-window gate, and WA1–WA4 proof slice is
  inventoried in the canonical WA0 contract.
- **P0 — WA1: same-window Agents source + local packaged slice COMPLETE; manual
  product sign-off remains.** The `agents` route, cross-project conversation/attention sidebar,
  headless launcher, selected chat/inspector, contextual shortcuts, and normal
  deep-link cutover are implemented. Normal navigation creates no wrapper
  Workspace; all new attachment/materialization APIs are removed; old placed
  panes still render. Full frontend tests, targeted lint, and production build pass.
  Run manual UX/dogfood review before declaring the product slice signed off.
- **P0 — WA2: source + local Windows hydration/CLI proof COMPLETE; SSH and
  published PacketCode proof open.** New Workspace creation and Add Session are CLI-only, detected PacketCode is
  recommended/default, missing PacketCode opens typed Settings recovery, and
  old conversation panes remain readable. Cold start launches no hidden PTYs;
  selecting a Workspace starts only its panes; navigation preserves live PTYs;
  Codex resolves to its CLI wrapper rather than the Store desktop app.
- **P0 — WA3: source COMPLETE; manual local/SSH and external-runtime proof
  open.** Typed handoffs now connect Workspace, Agents, PacketCode, Flight
  Deck, PacketAgent, Git endings, terminal attach, and Monitor without cloning
  conversations, worktrees, approvals, reviews, or history.
- **WA4: COMPLETE — owner retired new Workspace conversation attachments.**
  **Open alongside Workspace**, its handoff/session-glue/store materializers,
  dormant draft tile, and advisory evaluator are removed. Git-ending and
  Flight-attempt handoffs now open the exact CLI-first project Workspace
  without attaching. Existing saved conversation panes remain readable,
  closable, and garbage-collected; see the
  [`decision record`](./dev/workspace-agents-wa4-dogfood-gate.md) and
  [`completion audit`](./dev/workspace-agents-completion-audit-2026-07-29.md).
- **P2 — detachable interactive Agents window prerequisite.** Move canonical
  conversation/approval/persistence ownership behind a single-writer broker or
  versioned Rust state before allowing a second interactive WebView. The
  current Rust-restricted read-only Monitor does not prove multi-writer safety.
- **P1 — enforce or remove placebo Settings controls.** AI Provider Routing
  has no production consumer; Agent right-rail collapse is unused; PacketADE
  MCP-provider scope/tool checkboxes are not passed to or enforced by Rust.
  Default Agent launch location is now consumed by the Agents launcher. Hide or
  disable the remaining placebo controls until their effective runtime policies
  are observable.
- **P1 — complete or hide SSH password configuration.** Settings offers
  Password auth but cannot write/delete the keyring secret. Add secure
  set/delete plus host-key/auth/base-path Test, or remove the option from new
  server setup. Never persist the password in frontend state or DTOs.
- **P1 — make safety-setting persistence authoritative.** Flight/autonomy
  settings currently report Saved before the unawaited backend write completes.
  Add awaitable revisioned saves, dirty/saved/error UI, and race-proof draft
  handling.
- **P2 — Settings identity and navigation correctness.** Typed section/CLI deep
  links are complete. Use stable scoped MCP server IDs, show the real active
  local/SSH Workspace in Project settings, and validate provider-aware profile
  model/tool choices.
- **P2 — reorganize Settings into six groups. COMPLETE.** General; Workspaces &
  Terminal; Agents & Models; Automation; Integrations & Data; Security &
  Diagnostics now own all previous cards through lossless sub-tabs. Search,
  scope badges, current typed PacketCode recovery, and legacy Agent-section CLI
  recovery compatibility are implemented and test-covered.
- **P2 — add CLI-first preferences and diagnostics.** Terminal appearance and
  behavior, shell/environment, Workspace restore/template defaults, default CLI
  and model, worktree cleanup, external editor, and a consolidated
  CLI/provider/SSH doctor are the major missing Settings capabilities.

## Main app navigation and right-panel audit

Canonical review:
[`dev/main-shell-navigation-and-right-panel-audit-2026-07-29.md`](./dev/main-shell-navigation-and-right-panel-audit-2026-07-29.md).
This was an independent read-only audit; no finding below is silently approved
for implementation.

- **P0 — remove or explicitly scope the Workspace Agent inspector.** `App`
  currently mounts an inspector beside Workspace for any globally selected
  Agent conversation. The final CLI-first Workspace boundary favors keeping
  Inspector in Agents; legacy panes would require an explicit focused-pane
  exception.
- **P0 — establish one right-dock owner.** Editor, Git, and Agent Inspector can
  compete for fixed width and collapse the main canvas at the supported 800px
  minimum. Decide one surface-scoped dock with mutual exclusion, shared resize,
  width clamping, and automatic collapse.
- **P0 — repair Preview and SSH boundaries.** Preview open/tab/target state is
  global and not conversation-scoped; Hide/Close disagree; Files does not wire
  its promised Markdown preview; Preview and applied Review expose local-only
  disk operations for SSH conversations. Disable unsupported remote actions
  until a single remote-aware file contract exists.
- **P1 — unify main navigation metadata.** Left Rail, command palette, Status
  Strip, hotkeys, and modules maintain separate route identities. Add one view
  registry, make Dictation canonical, expose missing Agents/Flights/Cost
  destinations, and make the global New menu truthful.
- **P1 — correct shell project and Git-host context.** SSH can show or mutate a
  stale local project/branch; Gitea capability flags do not gate every
  GitHub-only action; repo/host switches can retain old PR detail. Use typed
  local/SSH context and clear/capability-gate every dependent surface.
- **P1 — make operational controls honest.** Agent Stop can report idle before
  cancellation succeeds; today's spend includes old hydrated conversations;
  Git says review is required without enforcing it; Flight Monitor failure can
  be silent; Side Chat requests lack request identity/cancel.
- **P2 — align labels and accessibility.** Rename shell GitHub to Git Hosts,
  Fleet to Workspaces, VT to Dictation, and misleading handoff actions; remove
  the two-ellipsis Agent header; add navigation/tab/menu ARIA and responsive
  overflow proof.

## Reliability audit follow-ups

Full evidence for the original findings remains in
[`dev/code-review-2026-06-07.md`](./dev/code-review-2026-06-07.md). This section
contains only unresolved items.

No unresolved low-rated findings remain. The 30-item remediation loop completed
on 2026-07-19; its per-finding acceptance evidence and gate record live in
[`dev/reliability-low-fix-loop-2026-07-19.md`](./dev/reliability-low-fix-loop-2026-07-19.md).
