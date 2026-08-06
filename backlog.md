# PacketADE Backlog

Last reconciled: 2026-08-03

This is the single task register for work that has not shipped or has not yet
earned its required real/package proof. Completed implementation history belongs
in [`CHANGELOG.md`](./CHANGELOG.md); dated audits and superseded designs are
evidence, not additional backlogs.

Priority: **P1** = release blocker, real bug, or major user-facing gap;
**P2** = bounded correctness/UX work; **P3** = later enhancement or cleanup.

## Owner decisions

These are the only current product decisions blocking implementation.

1. **P1 - Remote Agents authentication.** Choose a product-grade OIDC/passkey
   provider or a carefully scoped in-house passkey/magic-link implementation.
   Dev-only identity may be used only for internal smoke tests.
2. **P1 - Remote Agents payload encryption timing.** Current recommendation:
   plaintext is acceptable only for local/internal development; encrypted
   agent, approval, and file payloads are required before any external beta.
3. **P1 - Global Undo.** Choose durable soft-delete/restore with retention, or
   a time-boxed undo toast that delays destructive commits. Confirmations are
   the current safety net; do not start a cross-store implementation until the
   persistence/retention choice is explicit.
4. **P1 - v1.0.0 scope adoption.** The 2026-08-05 Fable 5 review recommends a
   Windows-only, signed, installer-proven v1.0.0 with the updater client
   shipped but the first served update deferred to 1.1, and an explicit "1.0 is
   NOT" list (macOS/Linux, Remote Agents, Global Undo, hosted CI, the
   environment-gated proof matrices). Adopt, amend, or reject that definition;
   the signing-identity application (Azure Trusted Signing plus an OV
   fallback) is the critical path and should start immediately either way. See
   [`docs/reports/fable5-review-2026-08-05.md`](./docs/reports/fable5-review-2026-08-05.md).
   The "1.0 is NOT macOS" line is scheduled rather than abandoned: macOS builds
   and runs on real hardware today, and
   [`dev/macos-release-plan.md`](./dev/macos-release-plan.md) targets a signed,
   notarized arm64 DMG for v1.1. Its only day-0 dependency is Apple Developer
   Program enrollment, which must start alongside the Windows signing
   application.

Remote Agents relay architecture and code location are already decided: extend
the standalone Rust service at `D:\projects\packet-relay`; keep shared schemas
and the initial PWA under PacketADE's `remoteagents/` workspace. See
[`dev/remoteagents/09-open-decisions.md`](./dev/remoteagents/09-open-decisions.md).

## Release and real-environment proof

The source behind these slices is implemented. Keep them open until the named
environment or packaged matrix has actually run.

- **P1 - Distribution trust and hosted gates.** Add hosted CI; acquire Windows
  Authenticode and Apple Developer ID credentials **in parallel on day 0**; wire
  Tauri updater signing/configuration and hosted `latest.json`. Current Windows
  artifacts are unsigned. See
  [`dev/beta-distribution-trust-runbook.md`](./dev/beta-distribution-trust-runbook.md)
  and [`dev/updater-setup.md`](./dev/updater-setup.md). macOS signing,
  notarization, and entitlements are owned end to end by
  [`dev/macos-release-plan.md`](./dev/macos-release-plan.md).
- **P1 - macOS v1.1 release.** Enroll in the Apple Developer Program
  (Individual); create the Developer ID Application certificate and an App Store
  Connect API key and back the private key up twice. Run the unsigned macOS
  acceptance matrix during the 1.0 fix buffer, then fix the blockers: no
  entitlements file, `bundle.macOS` carries only `minimumSystemVersion`,
  `dictation/delivery.rs:40-48` hard-fails off Windows, CMake missing from the
  documented macOS prerequisites, and `build.rs:16-21` treats a missing bundled
  Node as a warning. Ship a signed + notarized + stapled arm64 DMG.
  See [`dev/macos-release-plan.md`](./dev/macos-release-plan.md).
- **P2 - macOS terminal shell defaults.** Auto resolves to bash on macOS
  (`src/agents/terminal.ts:4,9`; `TerminalShellSettingsCard.tsx:163`), where
  `/bin/bash` is the 2007 GPLv2 freeze and zsh has been the login shell since
  Catalina; posix profiles pass no login-shell args
  (`src/lib/terminalShells.ts:219-222`, unlike git-bash at `:206-211`), so
  `~/.zshrc`-defined aliases and env are missing. Nothing reads `$SHELL`.
  fish/nu/xonsh are never probed on posix despite the backend allowlist and the
  UI copy promising them.
- **P1 - Packaged application acceptance.** Run v0.10.3 launch, lifecycle,
  accessibility, denial, credential, and real-host matrices. Build success is
  not interactive acceptance. See
  [`dev/release-v0.10.3.md`](./dev/release-v0.10.3.md) and
  [`dev/proof-audit-2026-08-01.md`](./dev/proof-audit-2026-08-01.md).
- **P1 - Flight supervision.** Run packaged local and disposable pinned-SSH
  matrices for Reviewer Gate, cooperative integration, Coordination Inbox, and
  bounded YOLO (RG8/CG9/CI9/AP9).
- **P1 - PacketAgent W9 interoperability.** Configure a separately running
  PacketAgent URL/token/workspace; prove deploy, close/relaunch/reconnect,
  ordered-event continuation, evidence/artifact return, and the currently
  published control surface. PacketAgent remains the durable-execution owner.
- **P1 - PacketCode release proof.** Publish signed stable/preview artifacts;
  run clean-machine install/update/rollback, packaged PacketADE launch, and
  PacketAgent W9 compatibility smoke. Source detection and `doctor --json`
  already pass.
- **P1 - Dictation hardware/platform matrix.** Run default/USB/Bluetooth,
  44.1/48 kHz, fast-PTT, cancel, disconnect, repeated phrase, first-model-load,
  history, in-app, clipboard, and opt-in external-paste tests on Windows with an
  active microphone. Then run the Linux ALSA/PipeWire plus X11/Wayland matrices.
  macOS microphone permission, TCC behaviour, and the `systemWidePaste` gap are
  items MAC-13 to MAC-15 of the acceptance matrix in
  [`dev/macos-release-plan.md`](./dev/macos-release-plan.md).
- **P2 - Local Terminal shell matrix.** In the v0.10.3 package, exercise Auto,
  PowerShell 7, Windows PowerShell, Command Prompt, Git Bash, WSL,
  unavailable-profile recovery, app/workspace/pane persistence and hydration,
  and CLI/SSH non-regression. Detection and direct command probes already pass.
- **P2 - Workspace, Settings, and SSH proof.** Run manual Workspace/Agents
  dogfood plus packaged OS-keyring set/delete/rollback and live pinned-host
  password authentication. Run the surviving Claude Agent SDK and OpenAI
  Agents SDK local/SSH provider matrix; the retired Codex chat-provider gate is
  not applicable.
- **P2 - GitHub/Gitea authority and Issue-to-Flight mirroring.** Use disposable
  GitHub and Gitea repositories to prove create/adopt/update/pull/conflict,
  hidden-window pause, restart, revoked-auth recovery, repository transitions,
  and the bounded slow-write/host-switch overlap.
- **P2 - Project Memory interoperability.** Run real-editor watch storms,
  partial-write/rename/restart, and packaged empty/large/dirty/gitignored
  project matrices. PacketADE must not edit `.gitignore`.
- **P2 - MCP Hub parity.** Run surviving sidecar/in-process providers against
  configured local and pinned-SSH MCP servers: crash/reload/version-skew,
  offline install/removal, trust downgrade/reconnect, remote-profile parity,
  and packaged catalog/removal smoke.
- **P2 - Trust/provenance parity.** Run all-provider local/SSH/MCP/restart/YOLO
  and packaged visual/manual matrices without weakening denial floors.
- **P2 - Monitor proof.** Run packaged multi-display lifecycle and stale-state
  checks, verify Monitor closes with the main process, and execute a
  WebView-to-Rust denial integration test.
- **P3 - Windows OpenSSH and remote transfer proof.** Add an OS probe and
  unit-tested cmd/PowerShell command builder for Windows-OpenSSH targets. Prove
  streamed transfers above the current 2 MB cap before considering port
  forwarding.
- **P3 - Autonomy harness real-run validation.** Exercise
  `src/lib/agent-harness.ts` against a live provider and record the evidence.
  (Folded from `docs/deferred-work.md`.)
- **P3 - PTY orphan-reaper live verification.** After the reaper is actually
  wired (see the Fable 5 P1), verify orphan reaping in a packaged build.
  (Folded from `docs/deferred-work.md`.)
- **P3 - Additional platform packaging.** Snap/Flatpak remain deferred until the
  release matrix demands them. macOS `x86_64-apple-darwin` is a fast-follow to
  the v1.1 arm64 DMG only if a user asks; it cross-compiles on an Apple Silicon
  Mac and needs no new machinery. Linux packaging is still unproven.

## Bounded source work

These are real code changes, not substitutes for the proof matrices above.

### Fable 5 review findings (2026-08-05)

Verified findings from the six-team deep review; full evidence with file:line
citations is in
[`docs/reports/fable5-review-2026-08-05.md`](./docs/reports/fable5-review-2026-08-05.md).

- **P1 - Reviewer Gate verdict persistence.** `merge_attempts_for_frontend_save`
  drops `review_gate` and no Rust writer exists, so an enabled Reviewer Gate
  blocks acceptance permanently and dead-ends bounded-YOLO auto-graph. Add a
  backend-owned `set_attempt_review_gate` command under the state lock plus a
  Rust merge test. Feature-flag the gate and auto-graph off until fixed.
- **P1 - Reconcile attempts on startup.** `recover_flights_on_startup` never
  touches `flight.attempts`; non-terminal attempts survive restart forever,
  leaking worktrees/`pkt/*` branches and permanently blocking future launches
  via the path-collision guard. Demote to `Failed` and sweep worktrees.
- **P1 - PTY kill and reaper.** `kill_pty` signals only the direct child (a
  `setsid` leader), so agent subtrees survive pane close; the startup orphan
  reaper reads a pid registry nothing writes; there is no app-exit PTY cleanup.
  Port the process-group kill from `core/pty.rs`, wire `record_spawned_pid`,
  and add a `RunEvent::Exit` arm.
- **P1 - State-lock fairness.** Sync save commands busy-spin `try_lock` on the
  IPC thread and can starve indefinitely against queued async writers (UI
  freeze, no timeout). Make the saves async/fair; recover poisoned locks
  instead of permanently failing every subsequent save.
- **P1 - MCP read-only enforcement is fail-open.** Both the Rust and sidecar
  copies gate writes with a substring denylist that misses `edit_file`,
  `commit`, `exec`, and similar; the strict allowlist never engages because
  `capabilityCheckedAt` is never set by default. Move to allowlist-by-default.
- **P1 - Sidecar protocol security floor.** Version mismatch is warn-only; a
  pre-v11 sidecar silently ignores `mcpTrustSnapshot` and runs MCP unfiltered.
  Refuse sessions below v11 and surface the refusal in the status chip.
- **P1 - Authenticated Node download.** `fetch-node.js` verifies against a
  SHASUMS file fetched over the same channel and trusts a self-written cache
  marker forever. Pin the five archive digests in-repo and re-validate the
  cache against them.
- **P1 - Release machinery truthfulness.** `release-readiness.mjs` passes
  quality gates if the script _name exists_; `release:gate:strict` accepts the
  updater minisign key as an Authenticode credential; the gate never runs
  automatically. Fix both scripts and add `release:gate` to `prebundle`.
- **P2 - Sub-agent permission holes.** The sub-agent loop dispatches tool calls
  without checking them against its allowlist, and `spawn_subagent` is not in
  `RISKY_TOOLS`, routing around DenyAll; `grep` follows symlinks out of the
  workspace while the other file tools reject them. Also decide whether
  permission mode `Auto` should remain the shipped default for local `bash`.
- **P2 - Accept/Reject safety and landing.** Attempt Accept/Reject are
  unconfirmed single clicks that reach `git worktree remove --force`; there is
  no post-accept Land/Open-PR action outside cooperative flights. Add
  confirmation with the existing dirty-worktree probe and a Land action.
- **P2 - Flight cost integrity.** Cost deltas are applied twice when a hydrate
  interleaves, and the `max()` merge makes the inflation permanent. Emit
  authoritative totals; make the listener set rather than add. Also: `pkt/*`
  branches are never deleted after attempts; plan-apply replaces milestones
  without confirmation and orphans running task ids; the launch modal hides
  partial-launch success.
- **P2 - Sidecar resilience.** Three fast failures permanently brick sidecar
  providers with no restart command; a hung-but-alive sidecar streams nothing
  forever with no watchdog; `done`/`error` persistence runs inline on the
  single reader loop and stalls all conversations. OpenAI provider never emits
  `rate_limited` and checks MCP path denial with empty arguments.
- **P2 - Dependency and config hygiene.** Add `default-features = false` to
  reqwest (drops a redundant OpenSSL stack); delete unused `fuzzy-matcher`;
  remove the dead `specs-gen.vercel.app` CSP origin; add `--frozen-lockfile`
  to sidecar installs; add `*.key` to `.gitignore` before generating updater
  keys.
- **P2 - SSH trust anchors.** Validate the `ssh_pin_host` line (reject
  wildcards/`@cert-authority`), quote `UserKnownHostsFile`, and require a
  pinned fingerprint before sending an API key to a remote sidecar.
- **P1 - Terminal-pane orphaned spawn.** Unmounting a pane during the awaited
  `createPtySession` never kills the PTY (the session id ref is still null in
  cleanup) and writes the dead pane's session into `layoutStore`. Add the
  mounted-guard + best-effort `killPty` (`useTerminalSession.ts:236-251`).
- **P1 - Shared Modal focus/semantics/Escape stack.** The one shared `Modal`
  has no focus trap/restore and no dialog ARIA, and nested modals close the
  wrong dialog on Escape; view-switch chords also fire while modals are open,
  destroying half-typed forms. Fix once in the wrapper with a modal stack —
  upgrades all 20 modals.
- **P2 - Listener-lifecycle sweep.** Apply the cancelled-flag pattern to the
  eight files that assign `unlisten` after `await listen(...)`; fix the
  five-file `mountedRef` dev-only bug that wedges the PR/quality-AI panels;
  add unmount cleanup + `cancelQualityFix` to `AutoFixButton`.
- **P2 - workspaceStore persistence.** Add the `persistenceTail` ordering and
  a local-only hydrate merge (a workspace created during the bootstrap window
  is currently dropped); catch the fire-and-forget `writePty` so a message to
  a dead PTY is not silently lost.
- **P2 - Undefined theme tokens.** `accent-cyan`, `accent-yellow`,
  `accent-orange`, and `text-text-tertiary` are used but not defined — 12
  usages render colourless today (PR pending pills, "Up Next" status dot).
- **P2 - Coverage measurement and runtime split.** Add vitest coverage tooling
  with per-directory floors; move the ~2,483 LOC of event-listener runtimes
  out of `stores/` into `src/runtime/`; rename `src/agents/` → `src/lib/pty/`;
  then write behavioural tests for the six money/remote modules
  (`LaunchAsyncFlightModal`, `reviewerGateRuntime`, `issueFlightMirrorStore`,
  `ServerFormModal`, attempt listeners, the PTY pattern parser).
- **P3 - Brand-literal sweep.** Replace the 43 hardcoded `packetade:` storage
  keys and 7 `packetade://` URIs with `storageKey()`/`URI_SCHEME`.
- **P1 - Rehearse the Phase-3 release gates before the release window.** A
  2026-08-06 dry run against the known-good v0.10.3 artifacts already reduces
  the strict gate to exactly the two scheduled blockers — Authenticode
  credentials and updater configuration — plus a dirty tree, with no
  environmental noise. What that run could not cover is the nine quality gates
  themselves, which were skipped. Run one full `release:readiness` from a
  **Windows shell** (where Cargo is on PATH) on a quiet machine before
  2026-08-17, so the reserved fix buffer is not spent distinguishing real
  failures from tooling artifacts. Note also that `release:gate` has passed
  standalone but has never yet run inside a real `pnpm tauri build`.
- **P1 - Release gates report false failures when run from WSL.** Three
  independent traps, all confirmed on this machine, all of which would burn
  time during the release window: `hostTarget()` reads `os.platform()`, so WSL
  reports `linux` and the script demands Linux bundles for a Windows-only
  release (fixed — `PACKETADE_RELEASE_TARGET` is now validated and its
  provenance is printed); `cargo` is not on the WSL path, so `rust:check`,
  `rust:test`, and `check:tauri-schema` fail with `cargo: not found`; and the
  bundle-root lookup used to fall through to `src-tauri/target` whenever
  `cargo metadata` could not run — the same missing-Cargo cause — so readiness
  reported missing artifacts for a release that had built correctly (fixed:
  the root now resolves from `CARGO_TARGET_DIR`, then `.cargo/config.toml`,
  then `cargo metadata`, translating Windows paths under WSL, and prints its
  provenance). The remaining item is the Rust gates: run release gates from
  the Windows shell, or put the MSVC toolchain on the WSL path. See
  `dev/local-quality-gates.md`.
- **P2 - Remote sidecar receives the API key before the protocol floor can
  refuse it.** The SSH handshake arrives after `start_session` is already on
  the wire, so a pre-v11 remote sidecar gets the provider key before the
  version floor can reject it. The session is killed on its `ready`, but
  closing this properly needs a handshake-before-start redesign of the remote
  path. Pair it with requiring a pinned `host_fingerprint` before any remote
  sidecar start.
- **P2 - Sidecar cold start takes 18-29 s on this checkout.** Module-load
  measurement attributes ~25.5 s of it to `providers/openai-agents.js` alone
  (pre-existing, unrelated to the MCP trust work). Four spawn-based smokes
  (`protocol`, `registry`, `remote-project`, `remote-mcp-fromfs`) time out
  against their 3-5 s `ready` budgets as a result. Re-run them on a native
  filesystem to separate DrvFs cost from real load cost, then either lazy-load
  the OpenAI SDK behind first use or raise the budgets deliberately.
- **P3 - A landed attempt does not remember that it landed.** The attempt tile
  reports "Landed `pkt/…` as `abc1234`" in component state only, so the fact
  disappears on remount. Persisting it needs a new field on the Rust `Attempt`
  struct. Re-clicking Land is already safe — the merge returns `nothingToLand`
  and the tile says so rather than claiming a second landing.
- **P2 - Several test timeouts are too tight for this filesystem.** A full
  suite run on 2026-08-06 returned 1,631 passed / 10 failed, and **every one of
  the ten was a timeout or a platform assumption, not a regression** — but that
  makes a clean run impossible here, so a real failure would be easy to miss.
  The source-fence tests (`workspace-agents-boundaries`, `confirm-idiom`) walk
  all of `src/` synchronously and need 5-49 s against a 5 s default;
  `sessionContract` pays a cold-import cost; and
  `persistenceMigration`'s "moduleStore ignores a persisted 'ideation' entry"
  carries its own hardcoded `15_000` budget while taking ~27 s on DrvFs. All
  pass when given room. Raise the budgets for the filesystem-walking tests,
  and consider `--pool=threads` as the repo default: the forks pool hits
  vitest's hardcoded 60 s worker-boot timeout under load. Note the fences are
  vitest files — run them with `npx vitest run <path>`, not bare `node`.
- **P3 - Onboarding overlay now suppresses view-switch chords.** The modal
  stack correctly blocks `Ctrl+Shift+<chord>` navigation while any dialog is
  open, but `AgentsOnboarding` renders a `Modal` for the one-time welcome
  overlay, so a first-run user's chords do nothing until they dismiss it.
  Consistent with the rule and harmless, but decide whether a dismissible
  non-destructive overlay should be exempt.
- **P3 - Two component tests only pass on a Windows runner.**
  `AddSessionPicker` and `TerminalShellSettingsCard` assert Windows shell
  profiles, but `src/lib/terminalShells.ts:37-38` derives the platform from
  `navigator.userAgent`, which resolves to `posix` under jsdom on a Linux or
  WSL runner. Pre-existing and unrelated to the modal work, but it means the
  component suite is not green cross-platform — relevant once CI exists.
- **P3 - MCP Hub capability snapshot drops tool annotations.**
  `McpCapabilitySnapshot.tools` (`src/types/mcp.ts`) carries only
  `{name, description}`, so `defaultMcpTrustProfile` still derives its default
  allowlist from the name heuristic. Enforcement is unaffected (the sidecar
  probe and the Rust live listing both read `readOnlyHint` directly), but the
  Hub shows the user a less accurate picture than the runtime enforces.
- **P3 - Reviewer Gate report provenance does not persist.** The TypeScript
  `ReviewGateReport` carries an optional `provenance` envelope; the Rust
  `ReviewGateReportDto` has no such field, so the verdict now survives a
  restart but its provenance does not. Strictly better than the pre-fix state
  (nothing persisted at all) and consistent with coordination events, but
  closing it means adding the field to `core/flight.rs` and `api/mod.rs` and
  regenerating bindings.
- **P3 - Windows startup PTY reaper.** The crash-recovery sweep is deliberately
  Unix-only: a `.cmd`-wrapped CLI records `cmd.exe` in the pid registry, so a
  recycled pid would match the recorded image name and tree-kill an unrelated
  console. Pane-close and app-exit reaping do work on Windows, so only a hard
  crash strands a child. If crash-orphans prove real in practice, add a
  stronger identity token (process creation time) before building the sweep.
- **P3 - Dead code and hygiene.** Delete the unreferenced checkpoints command
  module and the other verified-dead commands/wrappers; delete the ~15
  orphaned frontend files (incl. `IssueDetailView.tsx`, the dead twin
  `views/SpecImportModal.tsx`, and the 16 dead `tauri.ts` wrappers after a
  Rust-side check); unify the flight status-dot colour maps; rename
  `IssueFlightMirrorCard`; backfill the 19 missing release tags; document
  sidecar protocol v11 in the Rust module docs; align the two error-taxonomy
  serializations (`rate_limit` vs `ratelimit`).

### Settings and Workspace

- **P2 - Stable Settings identity.** Migrate MCP selection/trust references to
  stable scoped server IDs; show the active local/SSH Workspace in Project
  settings; validate provider-aware profile model/tool choices.
- **P2 - Resolve Task Role Defaults.** Either consume the setting in the real
  launch/runtime path or remove the control. AI Provider Routing is already
  consumed and must remain.
- **P2 - CLI-first preferences and diagnostics.** Consolidate CLI/provider/SSH
  doctor output. Consider terminal appearance/behavior, Workspace restore and
  template defaults, default CLI/model, worktree cleanup, external editor, and
  environment editing only through the six-group Settings information
  architecture.
- **P2 - Detachable interactive Agents prerequisite.** Do not create a second
  interactive WebView until conversation, approval, and persistence ownership
  has a single-writer broker or versioned Rust state. The read-only Monitor is
  not proof of multi-writer safety.

### Main shell and daily-driver polish

- **P2 - MS4 accessibility/responsiveness.** Align Git Hosts, Workspaces,
  Dictation, and handoff labels; remove duplicate ellipsis chrome; add
  navigation/tab/menu ARIA; and prove responsive overflow from 800 px through
  ultrawide.
- **P2 - Creation semantics.** Reconcile `Ctrl+N` and the `/new` slash command,
  which still reach conversation creation through different routes with
  different semantics.
- **P3 - App-close preference.** Decide whether a scoped "don't ask again"
  preference is appropriate; preserve confirmation whenever live work would be
  destroyed unless the owner explicitly accepts the tradeoff.
- **P3 - Dead/unreferenced code decisions.** Delete or justify
  `IssueDetailView.tsx`, `useServerConnection`, and `ConnectionProgress`.
- **P3 - Format enforcement.** Normalize the known Rust formatting drift and
  decide whether `cargo fmt --check` joins the local/release gates.
- **P3 - Historical Gemini wording.** Remove stray descriptive mentions while
  retaining intentional persisted-data read aliases until their removal gate.

### Models, agents, and editing

- **P2 - Ollama capability-aware picker.** Probe `/api/show`, cache by endpoint
  and digest, and hide or clearly gate models that cannot execute tools.
- **P2 - Custom OpenAI-compatible provider.** Add one user-configured base-URL
  row for vLLM, LM Studio, LiteLLM, and compatible hosted/self-hosted endpoints.
- **P2 - Finish auxiliary-task routing.** Move remaining Memory, Insights,
  Spec, and GitHub auxiliary calls onto `core/aux_llm.rs`; add task-class
  provider/model settings without reviving the removed Cost Dashboard.
- **P2 - Retired-conversation provider switch.** Offer an explicit, logged
  user action to continue a conversation that references the retired
  `api-openai-codex` chat-provider id. Never rewrite automatically.
- **P2 - Edit capability groups.** Replace fragile per-tool allow-list entries
  with an `edits` capability so profiles do not silently exclude `edit_file`.
- **P2 - Failed-edit rendering.** Do not render a successful-looking phantom
  diff row when an Edit/`edit_file` tool call failed or was refused.
- **P3 - Remote exact edits.** Fix the SSH heredoc trailing-newline behavior
  before enabling `edit_file` remotely.
- **P3 - Composer per-launch MCP multi-select.** Let a launch pick a subset of
  enabled MCP servers instead of all-or-nothing. (Folded from the retired
  `docs/deferred-work.md`.)
- **P3 - Per-run cost cap.** A `costCapUsd` per conversation/run with mid-run
  cancel, complementing the existing budget guardrails. (Folded from
  `docs/deferred-work.md`.)
- **P3 - Cross-provider reasoning effort.** Expose a reasoning-effort control
  instead of the hardcoded 8000-token thinking budget in `api_agent.rs` /
  `llm_anthropic.rs`. (Folded from `docs/deferred-work.md`.)
- **P3 - Diff viewer controls.** Side-by-side toggle, word wrap, and
  whitespace-ignore in the agent diff view. (Folded from
  `docs/deferred-work.md`.)
- **P3 - `agentTaskStore` module split.** The store is ~1,780 lines and has
  grown since the last measurement; split along session-lifecycle/event-intake
  seams. (Folded from `docs/deferred-work.md`, count corrected.)

### Flight, Git host, and runtime debt

- **P3 - Partial multi-target launch result.** Return per-target success and
  failure directly instead of recovering partial successes by diffing persisted
  Attempts after an error.
- **P3 - Planner compatibility retirement.** Define the release-age and
  retention gate for removing legacy `planner_*` fields and optional journal
  cleanup. Do not restore Planner v1.
- **P3 - MCP advertised-name cache.** Resolve MCP tool names once at agent
  session start instead of respawning every enabled server for every call.
- **P3 - Gitea parity extensions.** Consider agent-tool/create-PR support,
  richer Actions/checks, inline review-comment authoring, and multi-commit AI
  compare only after the packaged dual-host authority matrix closes.
- **P3 - Semantic Memory retrieval.** Evaluate local embeddings only if
  measured IDF retrieval misses justify it; no vector database is currently
  warranted.
- **P3 - Historical cost compatibility.** Preserve retired-provider and old
  flight-cost data losslessly. Correct old rollups only with a schema that can
  represent input/output/cache/model attribution without guessing.

## Proposed later products

These are approved concepts, not current implementation commitments.

- **P2 - Packet Control evidence layer.** Freeze one `ControlRun`/
  `ControlStep`/`ControlArtifact` contract that projects losslessly onto
  PacketAgent's `ValidationEvidenceRecord`; then add user-initiated local/SSH
  terminal evidence capture, redaction, approval, capped retention, and
  read-only review surfaces. No daemon or autonomy expansion. See
  [`dev/packet-control-loop.md`](./dev/packet-control-loop.md).
- **P3 - PacketBBS connection preset.** Add a non-secret endpoint, bounded
  `/healthz` probe, safe external Web launch, and structured-argv Telnet pane
  only after current release gates. Do not share credentials or databases. See
  [`dev/features-packetbbs-terminal.md`](./dev/features-packetbbs-terminal.md).
- **P3 - Dictation engine benchmark.** Benchmark Parakeet and optional Whisper
  acceleration only after the repaired CPU path has real packaged latency and
  quality measurements.
- **P3 - Monitor expansion.** Approval/Cost routes, saved bounds, multiple
  simultaneous windows, and PTY attachment remain later. A Monitor must never
  mount or own the live PTY.
- **P3 - Native iOS/TestFlight.** Evaluate after the Remote Agents PWA proves
  relay, auth, push, and phone UX.

## Completed boundaries

Do not reopen these from historical plans:

- Workspace/Agents restructuring and WA0-WA4 are complete: Workspaces are
  CLI/PacketCode-first; Agents is a first-class same-window GUI-agent surface;
  new Workspace conversation attachments are retired; saved panes remain
  compatible.
- The six-group Settings information architecture and P1 authority/security
  corrections are complete.
- Flight Deck Option B is live. Planning is a normal read-only conversation
  with explicit apply; attempts remain user-launched. The autonomous Planner v1
  backend was intentionally removed.
- The 30 low-rated Reliability findings are closed.
- GitHub/Gitea dual-host source support, Issue-to-Flight source mirroring,
  Project Memory, MCP Hub, trust/provenance, Dictation hardening, Monitor v1,
  PacketCode integration, and PacketAgent W9 consumer source are implemented;
  their remaining work is recorded above.
- Claude Code panes self-bootstrap PacketADE's native status collector in
  v0.10.3; selectable Terminal shells are shipped at source/package level.

## Canonical plan map

- Product direction: [`ROADMAP.md`](./ROADMAP.md)
- Restart state and exact artifacts: [`HANDOFF.md`](./HANDOFF.md)
- Current audit summary: [`docs/reports/state-of-the-ade-2026-07-30.md`](./docs/reports/state-of-the-ade-2026-07-30.md), Section 0
- Current release record: [`dev/release-v0.10.3.md`](./dev/release-v0.10.3.md)
- Remote Agents: [`dev/remoteagents/README.md`](./dev/remoteagents/README.md)
- Main shell: [`dev/main-shell-navigation-and-right-panel-audit-2026-07-29.md`](./dev/main-shell-navigation-and-right-panel-audit-2026-07-29.md)
- Workspace/Agents: [`dev/workspace-agents-restructuring-goal.md`](./dev/workspace-agents-restructuring-goal.md)
- Settings: [`dev/workspace-agent-settings-decision-2026-07-29.md`](./dev/workspace-agent-settings-decision-2026-07-29.md)
- Packaged/external proof: [`dev/proof-audit-2026-08-01.md`](./dev/proof-audit-2026-08-01.md)
