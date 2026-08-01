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
information architecture are complete. The five decided (2026-07-30) items
from the
[`main-shell/right-panel audit`](./dev/main-shell-navigation-and-right-panel-audit-2026-07-29.md)
were implemented the same day; the current pass is their follow-ups (UX quick
wins and the creation/opening/deletion flow fixes).
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

- **P1 — attempt launches send a non-dispatchable provider id for `api-claude`.**
  `pickedToSpec` in `LaunchAsyncFlightModal` (and the reassign path in
  `asyncFlightStore`) derive the backend provider with
  `agentConfigId.replace(/^api-/, "")`, which yields `"claude"` for the default
  `api-claude` executor. `core::llm_provider::get_provider` knows `anthropic`,
  not `claude`, and `flight_attempts.rs` forwards the string verbatim to
  `start_api_agent_session`. Found while wiring WI-1 (2026-07-31); the new
  `src/lib/attemptRouting.ts` deliberately uses `apiAgentProvider` instead and
  has a regression test for it. Confirm against a real launch, then either
  route both call sites through `apiAgentProvider` or normalise in Rust —
  mis-mapping a provider is how a turn gets billed to the wrong credentials.
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
> Ledger: [`dev/archive/gitea-support-loop.md`](./dev/archive/gitea-support-loop.md). Self-hosted
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

> **Shipped:** the M1–M10 loop ([`dev/archive/memory-v9-loop.md`](./dev/archive/memory-v9-loop.md))
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

- **✅ Resolved 2026-07-30 — the three P0s.** The Workspace-level Agent
  inspector is removed (`e7e7c27`), one surface-scoped `RightDock` owns every
  right-side panel with conversation-scoped Preview and authoritative
  Hide/Close plus the wired Markdown viewer (`93d41af`), and local-only
  actions are gated on SSH conversations (`33708c0`). See the shipped entry in
  the 2026-07-30 State of the ADE section below.
- **P1 — make the global New menu truthful.** The route registry landed in
  `dffbe61` and unified Left Rail, command palette, Status Strip labels,
  hotkeys, and Dictation's route identity, so the remaining piece is the
  creation surface itself: the "+ New" menu still offers only Flight and
  Issue, and the Ctrl+K palette still offers no creation at all. Tracked with
  the creation-flow follow-ups.
- **P1 — correct shell project and Git-host context.** SSH can show or mutate a
  stale local project/branch; Gitea capability flags do not gate every
  GitHub-only action; repo/host switches can retain old PR detail. Use typed
  local/SSH context and clear/capability-gate every dependent surface.
- **P1 — make operational controls honest.** Agent Stop can report idle before
  cancellation succeeds; Git says review is required without enforcing it;
  Flight Monitor failure can be silent; Side Chat requests lack request
  identity/cancel. (The "today's spend includes old hydrated conversations"
  finding is resolved by deletion — the live-spend chip and Cost Dashboard that
  computed that sum were removed on 2026-07-31; the budget guardrails now read
  the backend spend figures with no live re-add.)
- **P2 — align labels and accessibility.** Rename shell GitHub to Git Hosts,
  Fleet to Workspaces, VT to Dictation, and misleading handoff actions; remove
  the two-ellipsis Agent header; add navigation/tab/menu ARIA and responsive
  overflow proof.

## Local model routing (Ollama-first)

Full plan, decision record, and the three-mechanism auxiliary-LLM audit live in
[`dev/local-model-routing.md`](./dev/local-model-routing.md). A Cursor-style API
gateway, self-hosted inference as a product, and a self-trained model are all
explicitly **out of scope**; the chosen direction is per-task-class routing so
auxiliary calls can run on local hardware while the agentic loop stays on
frontier models.

- **P1 — LM1: fix Ollama fundamentals.** `stream_chat_compat` never sends
  `num_ctx` or `keep_alive`, so Ollama silently truncates the front of the
  conversation at its default context and reloads the model between calls.
  Needs a native `/api/chat` path in `core/llm_ollama.rs`, a `/api/show`
  tool-capability probe with picker gating, and a visible over-context warning
  instead of silent truncation. Blocks everything else in this section.
- **P2 — LM2: custom OpenAI-compatible endpoint row.** One provider row wrapping
  `stream_chat_compat` with a user-supplied base URL covers vLLM, LM Studio,
  LiteLLM, hosted inference, and any self-hosted gateway. Independently useful.
- **~~P2 — LM3: unify the auxiliary LLM entry point.~~ PARTIALLY DONE
  2026-07-31** (shipped as WI-1 of `dev/oauth-removal-plan.md`).
  `src-tauri/src/core/aux_llm.rs` exists with five task classes covering spec
  import, both Code Quality AI actions, and both GitHub PR AI actions. It
  resolves the routing settings first, else the cheapest provider with a
  keyring `api-key-*` credential, ranked against `shared/model-pricing.json`.
  Remaining: extend `AuxTaskClass` to the mechanism-1 and mechanism-3 surfaces.
- **P2 — LM4: migrate the mechanism-3 sites onto the seam.** `memory.rs`,
  `insights.rs`, `spec.rs`, `github.rs` investigate — they drop a hard
  `claude`-on-PATH dependency and gain token accounting. **LM5 is done**: no
  auxiliary feature starts a sidecar session any more, and the bare
  `SidecarManager::forward_start` was deleted with its last caller. The old
  "keep `claude-oauth` selectable so subscription-funded operation stays the
  default" wording is withdrawn — it contradicts the 2026-07-31 owner
  decision.
- **P3 — LM6/LM7: routing settings and cost proof.** New `modelRoutingStore`
  plus settings slice mapping task class → provider/model (not
  `orchestrationSettingsStore`, which is flight-scoped). **The cost-proof half
  needs a new plan:** it assumed a local-vs-metered split in
  `CostDashboardView`, which no longer exists, and CE5's `task_class` ledger
  attribution is cut (2026-07-31). LM7 must either carry its own temporary
  measurement or state its saving as modelled rather than measured.

## Cost efficiency loop

Canonical plan: [`dev/cost-efficiency-loop.md`](./dev/cost-efficiency-loop.md).
**Owner decision 2026-07-31: the cost reporting surface is removed** (Cost
Dashboard view and route, toolbar live-spend chip, Settings usage-analytics
card, per-conversation and per-turn dollar readouts, `/usage`). Cost remains a
control input only: budget guardrails, the bounded-autonomy cost hard-stop, the
shared pricing table, and all token accounting are untouched.

- **P2 — CE3 remainder: cache-write tokens on the Codex sub-agent bucket.**
  `SubAgentTokenBucket` has no `cacheWriteTokens`, so a multi-agent Codex turn
  under-reports the most expensive token class to the guardrails once caching
  makes it non-zero. Hard prerequisite of CE6.
- **P2 — CE1: Codex cached-token double-count.** Rust passes `input` and
  `cached` as separate additive arguments; OpenAI's `cached_tokens` is a subset
  of prompt tokens, so Codex rows are overstated ~2–2.6x at typical hit rates.
  Its own commit with a CHANGELOG note.
- **P3 — CE4 re-scoped: temporary cache-hit-rate instrumentation.** A script
  over `~/.packetade/usage.jsonl` (which already records `cache_read`/
  `cache_write` and discards them) that prints the hit rate per model. Exists
  only to prove CE6 worked, then goes dormant — **not** a new reporting surface.
- **P3 — flight rollups still carry pre-CE2 dollars.** CE2-B (done 2026-07-31)
  repriced `usage.jsonl` and persisted conversation messages, but the flight
  cost fields in `state.v1.json` — `flights[].total_cost`, `attempts[].cost`,
  `milestones[].tasks[].cost`, `planner_cost`,
  `autonomy_runtime.action_history[].cost` — were left alone: they store a
  single collapsed `tokens` sum with no input/output/cache split and no
  per-turn model, so recomputing them means guessing an I/O ratio.
  `storage::save_flights` also merges `total_cost` with `max()`, so a lowered
  value would be pushed back up by the next frontend snapshot. **User-visible
  consequence: a per-flight budget cap can trip early on a flight whose spend
  predates CE2.** Fixing it properly means recording the token split per
  rollup (`accumulate_executor_cost` would need per-class arguments) — worth
  doing only if per-flight caps get used in anger.
- **~~CE5 — self-owned ledger with attribution~~ CUT 2026-07-31.** It existed
  to make a permanent reporting surface complete. Consequences: subscription
  providers stay outside the PacketADE-owned ledger permanently; CE6-PRE
  carries its own `run_id`; LM7 loses `task_class`.
- **Constraint dissolved:** OAuth removal is no longer gated on CE5 or on any
  other item in the cost plan.

## Reliability audit follow-ups

Full evidence for the original findings remains in
[`dev/archive/code-review-2026-06-07.md`](./dev/archive/code-review-2026-06-07.md). This section
contains only unresolved items.

No unresolved low-rated findings remain. The 30-item remediation loop completed
on 2026-07-19; its per-finding acceptance evidence and gate record live in
[`dev/archive/reliability-low-fix-loop-2026-07-19.md`](./dev/archive/reliability-low-fix-loop-2026-07-19.md).

## 2026-07-30 State of the ADE review

Dated snapshot from the State of the ADE review. Shipped items are recorded here
until the next release cut moves them into `CHANGELOG.md`; open items follow
the normal priority scheme.

- **✅ Shipped — Gemini CLI removal.** The Gemini PTY agent, its statusline
  parser (`commands/statusline/gemini.rs`), status bar, API-key card, agent
  config, and catalog entries are removed. Persisted panes/slots that
  referenced `gemini` are remapped to plain terminal on load
  (`workspaceStore.ts`), and retired builtin agent configs are filtered on
  hydrate (`agentStore.ts`). Supported PTY CLIs are now Claude Code, Codex
  CLI, OpenCode, PacketCode, and plain shells.
- **✅ Shipped — statusline tooling in `claude-code-tools`.** The sibling
  `claude-code-tools` repo now carries feature-synced Claude Code statuslines
  for Windows (`claudetools-win/statusline.ps1`, PowerShell, no deps) and
  macOS/Linux (`claudetools-bash/statusline/`, bash + `jq`/`bc`, with
  installer). Not part of the PacketADE build; noted here so the ledger does
  not lose cross-repo work.
- **P2 — adopt State of the ADE review recommendations.** Triage the review's
  recommendations into concrete backlog items (see
  `docs/reports/state-of-the-ade-2026-07-30.md` — the agent-facing edition and
  the source of truth; `…-2026-07-30.pdf` is the human edition with the same
  content. The HTML edition was retired 2026-07-30).
- **✅ Shipped — same-day review expansion into the consolidated 6-month
  ledger.** The report now carries three new chapters: the reconciled UX
  Ledger (07-29 main-shell audit + code review + rendered visual audit → five
  pending owner decisions D1–D5 + 43 deduped findings, none yet resolved), the
  Visual Audit (14 screenshots in `docs/reports/visual-audit-2026-07-30/`,
  reproducible via `e2e/visual-audit.spec.ts`), and the Outstanding Audits
  Ledger (64 docs swept, 218 open items, 182 still-valid, 15 critical).
- **✅ Shipped — creation/opening/deletion flows review.** A five-reviewer
  fleet walked every creation, opening, and deletion path and inventoried
  every button on every list surface: **65 findings across five flows**
  (workspace creation 12, sessions/panes 11, agent conversations 16, deletion
  13 including the review's only Critical, and a global button-redundancy
  audit 13) with **124 controls inventoried** (15 + 21 + 20 + 33 + 35). It is
  the Creation, Opening & Deletion Flows chapter (§5) of
  `docs/reports/state-of-the-ade-2026-07-30.md`. Nothing in it was fixed by
  the bug loop or the five decision implementations. Its top items — including
  the chapter's only Critical — were then shipped in `f405ea1`; the residue is
  tracked as the P1 deletion and shell follow-ups above.
- **✅ Decided 2026-07-30 — the five owner decisions (D1–D5).** All five
  resolved by the owner: D1 YES — remove the Workspace-level Agent inspector
  (Inspector owned solely by Agents; resolves P0-1); D2 YES — one RightDock
  controller owning width/stacking/visibility of all right-side panels
  (resolves P0-2, helps P0-3); D3 YES — gate/disable local-only actions
  (Preview, applied-Review, Undo, Plan handoff, diff) on SSH conversations
  now, full remote parity later (resolves P0-4); D4 YES — single route
  registry owning left rail, command palette, labels, hotkeys (resolves
  UX-14/P1-9; enables creation-label fixes); D5 — RECONNECT the lightweight
  Editor as a first-class RightDock panel (wire `editorStore.openFile`
  production callers, protect dirty buffers; folds into D2's RightDock scope).
- **✅ Shipped 2026-07-30 — the five decisions are implemented.** Four commits
  in the decided order: `e7e7c27` (D1 — remove the Workspace-level Agent
  inspector; resolves P0-1), `33708c0` (D3 — gate local-only actions on SSH
  conversations; resolves P0-4, and also fixes the same silent SSH→local
  conversion in the `/new` and `/review` slash commands plus diff failures
  that rendered as `+0/−0`), `dffbe61` (D4 — single route registry owning
  rail, palette, labels, placements, hotkeys; resolves P1-9/UX-14, with
  hotkeys now matching the physical `KeyboardEvent.code` so the Ctrl+Shift
  chords work on AZERTY/QWERTZ/Dvorak), and `93d41af` (D2 + D5 — one
  surface-scoped `RightDock` controller plus the reconnected Editor panel with
  a wired Markdown viewer; resolves P0-2, P0-3, P1-5/UX-10, P1-7). This
  delivered the audit's MS1–MS3 slices. Gates green at each step: `pnpm build`
  passing, ESLint at zero errors, Vitest 1260 → 1276 → 1320 → 1363 passing
  across 179 files. Known pre-existing and not caused by this wave: one
  unhandled rejection in `src/lib/__tests__/bootstrap.test.ts`, reproduced on
  a clean tree.
- **✅ Shipped 2026-07-30 — main-shell follow-ups (`f405ea1`).** Everything the
  five decisions deliberately left out, in four groups.
  **(A) Deletion safety.** The report's §5 Critical is closed: the SSH-server
  delete had no confirmation and the only component that carried one
  (`src/components/views/ServersView.tsx`) was never imported and unroutable —
  it was deleted. New shared `src/components/ui/ConfirmDeleteModal.tsx` plus
  `src/lib/serverUsage.ts`, which cross-references connection state,
  conversations with a matching `sshTarget`, running flight attempts, and bound
  workspaces so the dialog names real consequences ("1 conversation runs on
  this host (1 mid-turn)"). A full sweep followed: all 7 native
  `window.confirm` call sites eliminated and 15 destructive paths that had no
  confirmation at all gained one (API-key, GitHub-token and PacketAgent-token
  deletion, crash files, trust audit, prompt templates, memory patterns and
  clear-all, CLI-agent delete and built-in reset, MCP servers, code-quality
  history, project-notes archive). Anonymous trash icons gained `aria-label`s,
  and `scripts/confirm-idiom.test.mjs` is a regression fence (no native
  `confirm(` in source; swept files import the shared component).
  **(B) Keyboard and exit safety.** New `src/lib/keyboardTarget.ts` and
  `src/hooks/useGlobalShortcuts.ts`: Ctrl+K no longer opens the palette when
  focus is in an xterm terminal, input, textarea, select, or contenteditable,
  and it leaves `defaultPrevented` false so the keypress reaches the shell as
  readline kill-line. Escape still always dismisses modals but no longer steals
  the key from terminals for dictation-cancel. New `src/hooks/useCloseConfirm.ts`,
  `src/lib/liveWork.ts`, and `src/components/common/CloseConfirmDialog.tsx`:
  closing the app confirms **only** when live work exists (alive PTYs, mid-turn
  conversations, queued/provisioning/running attempts), lists what would be
  terminated, and uses `destroy()` to avoid re-emitting `close-requested`.
  **(C) Modals and board.** `Modal` now defaults to `closeOnEscape=true` —
  every modal's X already advertised "Close (Esc)", so the old default made
  that tooltip lie app-wide; `TransientPtyModal` keeps an explicit opt-out
  because xterm owns Escape. `NewIssueForm` was a hand-rolled overlay and is
  migrated onto the shared `Modal`, gaining Escape and a labelled close button.
  `IssueBoard` had `grid-cols-5` while `BOARD_COLUMNS` has had six entries
  since "Needs Attention" was added, orphaning "Done" onto a second row at
  every viewport; it is now a non-wrapping flex row, verified against the e2e
  visual-audit screenshots.
  **(D) Creation flows.** `workspaceStore.createWorkspace` now throws on a
  blank local `projectPath`, making the modal's own warning a store invariant
  no caller can bypass; the instant paths (Ctrl+N, sidebar) route through new
  `src/lib/workspaceCreation.ts`, which opens the OS folder picker when no path
  is known and creates nothing on cancel. Workspaces auto-name
  Workspace/Workspace 2/… (the hardcoded "New Session" is gone) and drifting
  labels/tooltips were corrected to one noun. `FleetSidebar`'s duplicate
  top+bottom create controls are de-duplicated (the labelled footer CTA
  stays). Workspace creation is now reachable from the "+ New" menu and the
  Ctrl+K palette (as an actions section, not a faked route).
  Gates: `pnpm build` green, Vitest 1466/1466 across 194 files (up from 1363),
  ESLint at zero errors.
- **✅ Shipped 2026-07-30 — delete cleanup (`d94cca4`).** The three questions
  the previous loop deferred were all answered by the owner and implemented, so
  a confirmed delete now actually cleans up after itself.
  **(1) Flight delete cancels and cleans up.**
  `asyncFlightStore.deleteFlightWithAttemptCleanup` cancels every non-terminal
  attempt through the existing cancel path and then deletes the Flight.
  "Non-terminal" deliberately **includes `reviewing`**, because Rust only tears
  a worktree down on a terminal transition, so a reviewing attempt's worktree is
  still on disk — a subtlety the audit had not identified. Cleanup is
  per-attempt try/caught and the delete runs after the `finally`, so a wedged
  attempt can never abort it; failures surface as a toast naming the branch and
  what may survive (including SSH attempts whose `ServerConfig` is gone, where
  neither Rust nor the frontend fallback can reach the host). The 3-second
  armed inline button — one of the five confirm idioms — is replaced by the
  shared `ConfirmDeleteModal`, which now states the attempts to be cancelled by
  status, the worktrees to be removed, which of those are dirty or uncheckable,
  and that live tasks are **not** cancelled. Completion capture is suppressed
  during a delete so cancelling the last attempt cannot mint a
  `flight_completed` memory event plus LLM retrospective for a record being
  discarded.
  **(2) Conversation delete discards the worktree and branch, and says so
  first.** Owner's instruction was "discard, surface the confirm". Dirty
  worktrees are **force-discarded** rather than refused, with the reasoning
  recorded: once the record is deleted no UI names the tree, so refusing would
  strand a directory nobody can find. The confirm leads with "This worktree has
  UNCOMMITTED CHANGES. They will be permanently lost." in caps, names the exact
  worktree path and `pkt/<id>` branch, escalates the button to "Delete and
  discard changes", and reports an unreadable git status as possibly-dirty
  rather than clean. Root-run, SSH, and already-discarded worktrees are skipped;
  landed worktrees are still discarded. New shared
  `ConfirmDeleteConversationModal` + `src/lib/conversationWorktreeDisclosure.ts`;
  both sidebars moved onto the shared idiom and `FleetSidebar`'s workspace
  dialog is no longer titled "Delete session?".
  **(3) SSH keyring is no longer orphaned.** New Rust `delete_ssh_password`
  clears **both** the current and the `LEGACY_KEYRING_SERVICE` entry — reads
  auto-migrate from legacy, so a survivor could resurrect the secret on id
  reuse — treats a missing entry as success (key-auth servers must not error),
  is registered in `lib.rs` with a TS binding, and is called from
  `serverStore.deleteServer` so every delete path is covered. A keyring failure
  cannot block the delete (logged via `logSwallowed`), and the
  `ConfirmDeleteModal` copy no longer claims the password stays behind.
  Gates: `pnpm build` green, Vitest 1523/1523 across 199 files (up from 1466),
  `cargo test` 444/444 (up from 440), ESLint at zero errors.
- **✅ Shipped 2026-07-30 — the remaining cleanup holes (`6847e5c`).** Six
  groups; everything the previous two loops recorded as still open except undo,
  which needs an owner decision first.
  **(1) Rust worktree failures now surface.** New `WorktreeCleanupOutcome`
  (`worktreePath`, `removed`, `branch`, `branchDeleted`, `branchRetained`,
  `dirtyPaths`, `error`, `deferred`) is returned by `cancel_flight_attempt` and
  `mark_attempt_status` instead of swallowing a failed `git worktree remove`
  behind `warn!`. Failures are **data, not `Err`** — the attempt is still
  cancelled — so the frontend's existing `FlightCleanupFailure[]` toast path
  finally covers them. Discovery: `mark_attempt_status`'s SSH arm was doing
  **nothing but logging**; it now resolves the saved `ServerConfig` with
  fingerprint pinning exactly as `cancel` does.
  **(2) Cooperative integration worktrees are no longer abandoned.** New
  `cleanup_flight_integration_worktree` (registered + TS binding) removes the
  `.pkt-flight-integrations/<flightId>` tree local or remote and is called from
  the flight-delete fan-out; its dirty state is probed and named in the confirm
  **separately** from the attempt counts. Deliberate conservatism: the
  integration branch is removed with safe `git branch -d`, never `-D`, because
  it can be the only ref to merged-but-unlanded attempt work — a refusal is
  reported in `branchRetained` and the branch survives.
  **(3) Startup restores the last view.** `bootstrap.ts` no longer force-routes
  to Welcome. New pure `resolveStartupView(persisted, isModuleEnabled)` in
  `appStore` validates against `ROUTE_REGISTRY` + module-enabled state; retired
  ids, unknown ids, and disabled-module routes fall back to Welcome, and first
  run is Welcome. The restore runs after conversation hydration but before
  `setInitialized(true)` — no Welcome flash, no view mounting against a
  half-built graph. No "always start on Welcome" preference existed anywhere;
  none was invented.
  **(4) Issues are deletable.** `issueStore.deleteIssue` already existed with
  **zero UI callers**; it is now reachable from an `IssueCard` hover affordance
  and an `IssueDetail` footer action, both behind the shared confirm via new
  `ConfirmDeleteIssueModal`, which names the live consequences: the flight it
  unlinks, the workspace session that **keeps running**, and the counts of
  comments, acceptance criteria, and dependency links deleted with it. Real bug
  fixed: the flight unlink previously fired only when the deleted issue itself
  carried a `flightId`, so a flight holding a drifted id kept it forever — now
  every flight naming the issue is cleaned, with `reconcileIssueLinks` as
  backstop. Comment deletion added with the same confirm idiom.
  **(5) Chrome de-duplicated.** `AgentSidebar` drops its header "+" and keeps
  the labelled footer CTA (matching the `FleetSidebar` resolution from
  `f405ea1`), so the report's "Partly resolved" duplicate-sidebar-CTA finding
  now fully closes. `ConversationTile` had **three** kebabs — tile chrome, a
  "More controls" toggle, and the overflow menu's own trigger — merged into
  **one** menu with every action preserved and the lazy-mount economy intact.
  The close (X) tooltip was lying because the same component mounts in two
  places where closing means different things; labels are now per-mount-site
  and state the real consequence (a tile close removes the pane while the
  conversation keeps running). No confirm added there — closing destroys
  nothing and is one click to reverse.
  **(6) Confirm-idiom fence tightened.** `scripts/confirm-idiom.test.mjs` no
  longer trips on a test **name** containing `confirm (`. While fixing it, a
  CRLF bug surfaced: the repo checks out CRLF and `.` won't match a trailing
  `\r`, so `$` never anchored and comments were never stripped — which had
  produced a false positive on a real file. Both directions are pinned with
  fixtures and proven end-to-end with a planted `window.confirm` probe.
  Gates: `pnpm build` green, Vitest 1581/1581 across 200 files (up from 1523),
  `cargo test` 452/452 with 2 ignored (up from 444), ESLint at zero errors.
- **P1 — deletion and shell follow-ups.** What `f405ea1`, `d94cca4`, and
  `6847e5c` deliberately left out; each needs behaviour or a design decision
  rather than a confirm dialog.
  - **Undo — the owner decision that blocks the rest.** No undo exists for any
    destructive action; confirmation is still the only safety net. Deferred
    again in `6847e5c` because it would touch every store. Two options, pick
    one: **(a) soft-delete + restore** — every store gains a tombstone and a
    restore path, persistence changes, recovery survives an app restart; or
    **(b) a time-boxed undo toast** — the commit is deferred for N seconds,
    nothing in persistence changes, and there is no recovery once the window
    closes. (a) is the durable answer and the larger build; (b) is an afternoon
    and covers the common misclick.
  - **NEW — `WorkspacePane`'s terminal tile "Close pane" kills the PTY with no
    confirmation.** A destructive-without-confirm path not previously
    catalogued in this backlog entry; re-confirmed open after the chrome loop
    rebuilt the tile menus around that control. It is the last such path left
    after the confirm sweep. (Report §5.3 P-04 / D-09.)
  - **NEW — `src/components/views/IssueDetailView.tsx` is dead code:** an
    unmounted duplicate superseded by `IssueDetail`, with only self-references.
    The issue-deletion work went into `IssueDetail` and left this file
    untouched. Needs a delete-or-keep decision. (Report §5.3 B-11.)
  - **NEW — no Rust test for `remove_remote_integration_worktree`.** It needs a
    live SSH host, matching the existing gap for every remote worktree
    function. Recorded so it is not mistaken for an oversight in the new code.
  - **NEW — two pre-existing `cargo fmt` drifts** in
    `src-tauri/src/commands/agent_sidecar/supervisor.rs` and
    `src-tauri/src/commands/mod.rs`. They predate `6847e5c` and were left
    untouched so its diff stayed reviewable. `cargo fmt` is still not gated.
  - The duplicate `CancelPendingButton` rendered twice at once in
    `PendingApprovalsSection` and the composer row, plus a third count badge.
  - The four-controls-one-action finding's remaining legs: `Ctrl+N` and the
    `/new` slash command still reach conversation creation by separate routes
    with different semantics. Both sidebar legs are now de-duplicated.
  - No "don't ask again" preference for the app-close confirmation.
  - The six-spellings label sweep across `WelcomeScreen`, `ProjectInfoCard`,
    and `OnboardingPane`.
  - `useServerConnection` and `ConnectionProgress` are now unreferenced; kept
    deliberately, but they need a keep-or-delete decision.
  MS4 (responsive/accessibility semantics, Gitea capability and repo-switch
  tests, packaged local/SSH and 800px-to-ultrawide visual matrix) and the two
  unaddressed MS1 items (Running Agents / Side Chat cancellation
  acknowledgment, clearing repo/PR detail across repo and host switches) remain
  open alongside these.
- **P3 — sweep remaining historical Gemini references.** Comments/aliases kept
  intentionally for load-compat (`agentStore.ts`, `workspaceStore.ts`) stay;
  audit stray descriptive mentions (e.g. `src/agents/packetcode.ts`
  description) at the next cleanup pass.
