# PacketADE — Fable 5 Deep Review (2026-08-05)

**Audience:** AI agents and the owner. This is the machine-readable consolidated
record of the 2026-08-05 whole-repo review. The human edition with screenshots
is [`fable5-review-2026-08-05.html`](./fable5-review-2026-08-05.html).

**Baseline:** `main` @ `2aaa7f56` (v0.10.3, tagged release source `61e0669`),
clean tree before the pass.

**Method:** six parallel specialist review teams (Rust backend, sidecar +
build pipeline, Flight Deck/orchestration, release readiness, documentation,
frontend), each returning file:line-cited findings that were verified before
inclusion; plus a live UI capture session (Vite dev build with a stubbed Tauri
bridge) and a lead-verification pass. Documentation fixes found by the audit
were applied in the same pass — see §7.

---

## 1. Executive summary

**PacketADE is a genuinely strong, near-shipping product whose bottleneck is
exactly what its own ROADMAP says it is: proof and distribution, not features.**
The engineering quality is high — 1,875/1,875 vitest, 606 Rust tests passing,
textbook shell-quoting and path-sandboxing in the tool runtime, honest docs
with zero broken links across the doc set. The review confirms the v1.0.0 push is
realistic on a ~2-week clock **for a deliberately scoped Windows-only 1.0**,
with one external dependency (a code-signing identity) that must start
immediately.

The review also found real problems that the existing gates could not have
caught, clustered in four places:

1. **One shipped feature is broken end-to-end.** The Flight **Reviewer Gate**
   can never persist its verdict (the Rust snapshot merge drops `review_gate`
   and no Rust writer exists), so enabling it blocks acceptance permanently and
   dead-ends bounded-YOLO auto-graph mode. No test covers gated acceptance,
   which is why CI stayed green. (§3, F1)
2. **Process lifecycle leaks.** PTY kill signals only the direct child so agent
   subtrees survive pane close; the startup orphan reaper reads a pid registry
   nothing writes (it has always reaped zero); Flight attempts are never
   reconciled on restart, leaking worktrees/`pkt/*` branches and permanently
   blocking future launches on the same path. (§3, F3–F5)
3. **Two security boundaries are fail-open.** MCP read-only trust is a
   substring denylist with verified bypasses (`edit_file`, `commit`, `exec`
   pass as "non-mutating") in both the Rust and sidecar copies; and protocol
   mismatch is warn-only, so a stale pre-v11 sidecar silently runs MCP with no
   filtering at all. (§3, F6–F7)
4. **The release machinery reports green without running anything.** The
   readiness script passes quality gates if the script _name exists_; the
   strict gate accepts the updater minisign key as a signing credential; no CI
   exists; and the packaged installer has never once been installed. (§3,
   F8–F9; §2)

None of this changes the overall verdict: the architecture is sound, the
invariants mostly hold (verified individually in §5), and every finding above
has a bounded fix. The 2-week v1.0.0 plan in §2 sequences them.

**Grades:** Rust backend **B/B+** · Sidecar/build **B** (control flow sound,
verification weak) · Flight Deck **not yet flagship-ready** (fix F1–F5 +
Accept/Land gap) · Frontend **B** (state layer and conventions strong;
listener lifecycle, modal accessibility, and coverage tooling weak) · Docs
**B+** (markdown A−, public HTML site was D — repaired in this pass) · Release
readiness **conditional GO** for Windows-only 1.0 by ~2026-08-19.

---

## 2. v1.0.0: definition and 2-week plan

### Proposed definition (owner decision — recorded in `backlog.md`)

> **1.0 means:** a Windows x64 desktop ADE, signed by a verifiable named
> publisher, installed from its own installer and interactively accepted
> against a written matrix, published on GitHub Releases with hashes and notes,
> tagged, and update-capable (the updater client ships; the first served
> update lands in 1.1). Local-first, single-user.
>
> **1.0 is NOT:** macOS or Linux · Remote Agents/PWA/relay · Global Undo ·
> SmartScreen-warning-free · proven against live PacketAgent/Gitea/pinned
> SSH/microphone · hosted CI · auto-updating from a published manifest.

### Critical path

The signing identity is the only item not under the owner's control.
**Apply for Azure Trusted Signing (~$10/mo, 1–7 business-day validation, no
hardware token) immediately, with a fallback OV certificate ordered in
parallel.** EV is too slow for this window. A signed 1.0 from a new identity
will still trigger SmartScreen initially — say so in the release notes.

### Three phases to 2026-08-19

- **Phase 1 (through 08-07):** cert applications first hour. `*.key` into
  `.gitignore` **before** generating the updater keypair; back the key up
  twice. Fix the release-gate/readiness script defects (F8). Remove the dead
  `specs-gen.vercel.app` CSP origin. Wire the updater client
  (`tauri-plugin-updater`, config block, pubkey, passive install). Backfill
  the 19 missing release tags. Run the full `pnpm check` ladder including
  Playwright (never run in any release). Land the P1 fixes F1–F7 or
  feature-flag the broken surfaces off.
- **Phase 2 (08-10 → 08-14):** bump `1.0.0-rc1`, build, and **install the NSIS
  installer on 08-10** — it has never been run. Acceptance matrix Mon–Wed:
  first item is one API-agent conversation through the **bundled** sidecar +
  bundled Node (highest packaging risk); then PTY panes across all five shell
  profiles, the packaged Claude statusline, one Flight attempt end-to-end,
  Settings/keyring, app close, Monitor on two displays. Wed–Fri is reserved
  fix buffer.
- **Phase 3 (08-17 → 08-19):** bump `1.0.0`, full check, strict gate (now
  meaningful), final signed build with `TAURI_SIGNING_PRIVATE_KEY` set so
  `.sig` files exist, clean-machine install, verify the UAC publisher name,
  write `dev/release-v1.0.0.md`, tag, GitHub Release, update docs.
  **Contingency:** cert not arrived → ship `v1.0.0-rc1` publicly unsigned
  with hashes; hold the `v1.0.0` tag for the signed build.

### Top timeline risks

| Risk                                                                                                  | Mitigation                                   |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Certificate validation slips                                                                          | Parallel applications day 1; rc1 contingency |
| First-ever install surfaces bugs (HIGH — never done)                                                  | Install on day 5, not day 13; 3-day buffer   |
| Bundled `node.exe` packaging breaks (known-fragile: ACL workaround in `src-tauri/.cargo/config.toml`) | Sidecar conversation is acceptance item #1   |
| Scope creep from 47 open backlog items                                                                | The "1.0 is NOT" list, committed in writing  |
| Updater key loss (permanent)                                                                          | Two backups before the first 1.0 build       |

---

## 3. Consolidated P1 findings

All registered in `backlog.md` under "Fable 5 review findings (2026-08-05)".

> **STATUS 2026-08-06: all twelve are fixed**, each with test evidence, by six
> parallel fix teams. The Rust suite went 606 → 635 tests with no failures, and
> the follow-on gaps each team declined to close (Reviewer Gate provenance, the
> remote-sidecar key-before-handshake window, MCP Hub annotation fidelity, land
> persistence) are filed in `backlog.md` rather than left implicit. What none of
> it has is runtime proof in a packaged build — every fix is verified by tests,
> type checks, and static reasoning, so the packaged acceptance matrix in §2
> remains the gate that matters.

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Evidence                                                                                                                                       | Fix                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **Reviewer Gate verdict can never persist.** No Rust code ever _writes_ `review_gate` (every hit is `None` or a read), so the field is permanently `None`; `merge_attempts_for_frontend_save` bases the merge on the backend record and correctly declines the frontend's copy, leaving the frontend's write with nowhere to land. Rust enforcement at `flight_attempts.rs:443` then blocks acceptance forever. Dead-ends bounded-YOLO auto-graph (`boundedAutonomyRuntime.ts:258`). **Diagnosis corrected during the fix:** the original finding said the merge _drops_ the field; in fact the merge starts from `current.clone()`, so a backend-held verdict would have survived — the defect was one-sided (a missing writer), not a discard. Same breakage, same fix. | `src-tauri/src/core/storage.rs:494-519`; `flight_attempts.rs:443,779,1251`; the only merge test builds `review_gate: None` (`storage.rs:1068`) | Backend-owned `set_attempt_review_gate` command under `with_state_lock`; Rust merge test + end-to-end gated-acceptance test. **FIXED 2026-08-06.** |
| F2  | **Accept never lands code; Accept/Reject are unconfirmed `--force` deletions.** Accept sets `completed` and force-removes the worktree; the branch survives unmerged, and only cooperative flights have a Land action. Meanwhile Flight _delete_ has a modal + dirty-worktree probe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `AttemptTile.tsx:358-378`; `CooperativeFlightCard.tsx:141`; `flight_attempts.rs:1186`                                                          | Post-accept Land/Open-PR on the tile; confirmation with the existing dirty-worktree probe (`FlightsView.tsx:488-503`).                             |
| F3  | **Attempts are never reconciled on startup.** `recover_flights_on_startup` normalizes everything except `flight.attempts`; non-terminal attempts persist forever → worktree/`pkt/*` leaks and a permanent path-collision launch block (`validate_target_claims_against_active_attempts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `core/orchestrator.rs:74-119`; `flight_attempts.rs:283-325`                                                                                    | Demote non-terminal → `Failed` ("Interrupted by app restart") + best-effort worktree sweep.                                                        |
| F4  | **PTY kill leaves agent subtrees alive.** `clone_killer` sends SIGHUP to the direct child only (a `setsid` leader); on Windows only the `cmd.exe` wrapper dies. Entry removed immediately → untracked survivor + leaked reader thread.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `commands/pty.rs:718,880,644-651`; `vendor/portable-pty/src/lib.rs:291-322`                                                                    | Port the process-group SIGTERM→SIGKILL from `core/pty.rs:404-435`; `taskkill /T /F` on Windows.                                                    |
| F5  | **The orphan reaper has always reaped zero.** It reads a pid registry written only by a `PtyManager` that is never constructed; and `RunEvent::Exit` cleans up only the sidecar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `lib.rs:178,547-552`; `core/pty.rs:221,692`                                                                                                    | `record_spawned_pid` from the live manager (`commands/pty.rs:719`); add an Exit arm that group-kills PTY sessions.                                 |
| F6  | **MCP read-only trust is fail-open.** A 19-word substring denylist (duplicated Rust + TS) passes `edit_file`, `apply_patch`, `commit`, `mkdir`, `chmod`, `exec`, `git_commit`, `append_to_file`, `put_object` as non-mutating in a session the user set read-only. The strict allowlist only engages when `capabilityCheckedAt` is set — the default snapshot never sets it.                                                                                                                                                                                                                                                                                                                                                                                              | `agent-sidecar/src/mcp-trust.ts:5-6,120,132`; `src-tauri/src/core/mcp_bridge.rs:46-54,134`                                                     | Allowlist-by-default (`readOnlyHint` / `allowedToolNames`); denylist becomes a floor; collapse to one authority.                                   |
| F7  | **Protocol mismatch is warn-only, unsafe at v11.** v11 moved MCP authority into the start request; a pre-v11 sidecar silently ignores `mcpTrustSnapshot` and runs every MCP server unfiltered. `PACKETADE_SIDECAR_PATH` is honored in release builds, so a stale sidecar is reachable without a corrupt install.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `commands/agent_sidecar/handler.rs:55-63`; `mod.rs:42-45`; `supervisor.rs:1292`                                                                | Security floor: refuse sessions below v11, keep warn-only above; surface the refusal in the status chip. Gate the env overrides behind a dev mode. |
| F8  | **Release machinery reports green without running anything.** `release-readiness.mjs:307-313` passes gates if the npm script _name is defined_; `release-gate.mjs:191-195` accepts `TAURI_SIGNING_PRIVATE_KEY` (the updater minisign key) as an Authenticode credential; the gate is absent from `prebundle`, so `pnpm tauri build` runs zero integrity checks. The v0.10.3 release used the `--report-only` readiness variant and never ran Playwright.                                                                                                                                                                                                                                                                                                                  | `scripts/release-readiness.mjs:307-313,337-339`; `scripts/release-gate.mjs:162-167,191-195`; `package.json:43`                                 | Execute the gates; separate updater vs Authenticode checks; add `release:gate` to `prebundle`; add minimal hosted CI.                              |
| F9  | **The bundled Node download is not authenticated.** `SHASUMS256.txt` is fetched over the same unconstrained redirect-following channel as the archive; the `.sha256` cache marker is self-validating and never re-checked, so one poisoning is permanent — and the binary ships inside the (eventually signed) installer.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `scripts/fetch-node.js:58,121-124,278-318,528-541`                                                                                             | Pin the five archive digests beside `NODE_VERSION`; validate the cache against them each run; redirect hostname allowlist + depth cap.             |
| F10 | **State-lock starvation can freeze the UI indefinitely.** Eleven sync save commands busy-spin `try_lock` + 1 ms sleep on the IPC thread; `try_lock` loses to any queued async waiter, and the sidecar spawns an awaiting rollup task per `turn_summary`. No timeout, no error. Lock poisoning is also permanent — every later save fails silently.                                                                                                                                                                                                                                                                                                                                                                                                                        | `core/storage.rs:417-424,428,446`; `commands/state.rs:49-107`; `handler.rs:560`                                                                | Async/fair saves (or `spawn_blocking`); poisoned-lock recovery via `into_inner()`.                                                                 |
| F11 | **Unmounting a terminal pane mid-spawn orphans the PTY process forever.** Cleanup reads `sessionIdRef.current`, which is still `null` until after the awaited `createPtySession` resolves — so no `killPty` fires, and the resolved spawn then writes the dead pane's session into `layoutStore`. A live `claude`/`codex` process survives with nothing that can find it (compounding F5).                                                                                                                                                                                                                                                                                                                                                                                | `src/hooks/useTerminalSession.ts:236-251,412`                                                                                                  | `mountedRef` guard + best-effort `killPty` on cancelled spawn (pattern already correct in `useTransientPty.ts:70`).                                |
| F12 | **The shared Modal has no focus management or dialog semantics, and Escape closes the wrong dialog when modals nest.** Focus is never trapped/restored, no `role="dialog"`/`aria-modal`, and the outer modal's window keydown fires first when a confirm nests inside (its test passes because it asserts the reverse registration order). All 20 modals inherit this; Ctrl+Shift+digit view chords also fire while modals are open, silently destroying half-typed forms.                                                                                                                                                                                                                                                                                                | `src/components/ui/Modal.tsx:60,73-104`; `PromptLibrary.tsx:133,314`; `useGlobalShortcuts.ts:69-78`; `Modal.test.tsx:82-103`                   | Modal stack (topmost handles Escape) + focus trap/restore + ARIA in the one shared wrapper; bail out of view chords while the stack is non-empty.  |

---

## 4. Notable P2/P3 findings (by area)

### Rust backend (grade B/B+; full detail in the team report)

- `grep` is the one file tool that follows symlinks out of the workspace
  (`tool_runtime.rs:940,966`) — the other four reject exactly that; symlink
  cycles also recurse unbounded.
- The sub-agent loop dispatches tool calls without checking them against its
  allowlist, and `spawn_subagent` is not in `RISKY_TOOLS` → clean route around
  DenyAll (`tool_subagent.rs:189`; `api_agent.rs:1840`). Plan mode blocks it;
  DenyAll does not.
- Shipped default `PermissionMode::Auto` gives an out-of-the-box API agent
  unrestricted local `bash` with zero prompts (`api_agent.rs:46-49,2182`) —
  a defaults decision to revisit, not a bug.
- `reqwest` missing `default-features = false` compiles **two full TLS
  stacks** (rustls + native-tls/OpenSSL) into the binary (`Cargo.toml:36`).
  Highest-value one-line fix in the audit. `fuzzy-matcher` is entirely unused.
- Sidecar resilience: 3 failures/60 s permanently bricks all sidecar providers
  (flat 500 ms backoff, no `restart_sidecar` command); no liveness watchdog, so
  a hung-but-alive Node means "thinking" forever; `done`/`error` persistence
  runs inline on the single reader loop and stalls all conversations during a
  slow fsync (`supervisor.rs:604-642`; `handler.rs:312-319,671-676`).
- PTY transcripts past 256 KB do a full read+rebuild+write per output chunk
  while holding a global mutex (`core/pty.rs:645-687`).
- SSH trust anchors: `ssh_pin_host` appends a renderer-supplied known_hosts
  line verbatim (wildcards / `@cert-authority` accepted); `UserKnownHostsFile`
  is unquoted; `host_fingerprint` is a presence flag never compared; an
  unpinned remote sidecar target can receive a live API key over a TOFU
  first connection (`pty.rs:1119-1146`; `execution.rs:112-126`;
  `supervisor.rs:1435,1475-1481`).
- Dead surface: the whole 123-line checkpoints command module; 7 other
  registered-but-uncalled commands; 10 more reachable only via wrappers
  nothing imports; an abandoned graceful-shutdown path in `core/pty.rs` that
  happens to contain the correct group-kill F4 needs. 240/240 commands
  registered; no frontend call targets a missing command; `deploy.rs` /
  `ideation.rs` are gone.
- Zero tests on the 882-line MCP write-gate surface (six write gates) and the
  758-line sidecar event handler (cost rollup).

### Sidecar & build pipeline

- Credential handling in the Anthropic provider is verified careful: per-session
  `Options.env`, OAuth token blanked, hard refusal on missing key, adversarial
  env-poisoning test. No key logged anywhere.
- OpenAI provider gaps: MCP path denial checked with empty arguments at
  listing time only (`openai-agents.ts:558`); process-global
  `setDefaultOpenAIKey` (`:269`); never emits `rate_limited`, so an OpenAI 429
  never arms the Rust backoff (`:636-641`).
- SDK pins are stuck ranges: `@anthropic-ai/claude-agent-sdk ^0.2.116` (latest
  0.3.223) and `@openai/agents ^0.11.4` (latest 0.14.3) can never resolve
  forward under caret semantics. Upgrade deliberately with exact pins — after
  landing the missing cancel/429/provider-execution tests, which are currently
  tautological or self-mirroring (`registry-smoke.mjs:80-100`;
  `protocol-v9-smoke.mjs:269-313`; `openai-agents-gating-smoke.mjs:56-73`).
- No `--frozen-lockfile` on any sidecar install; the destructive prod prune
  re-resolves live from the registry on every release build
  (`prune-sidecar.js:181-232`).
- Malformed JSON / unknown request types are dropped with no `error` event —
  Rust waits forever (`agent-sidecar/src/index.ts:32-35,73-77`).
- Protocol v11 lockstep confirmed (11 == 11 both sides), but it is three
  unlinked literals with no Rust test; the Rust decoder's `unwrap_or` defaults
  mean a renamed TS field silently becomes empty/zero.

### Flight Deck / orchestration

- Invariants verified individually: Rust owns attempt lifecycle (**holds**),
  flush-before-launch (**holds**), Option B only / no planner residue
  (**holds cleanly**), backend-owned data preserved on merge (**violated** —
  F1), cost ownership (**holds in Rust, leaks at the frontend delta mirror**),
  partial-failure recovery (**mechanism right, invisible in the UX**).
- Flight↔Issue linkage: all three UI sites call both stores, but the real rule
  is that `issueStore.assignToFlight` is authoritative —
  `reconcileIssueIdsFromIssues` rebuilds `issueIds` from `issueStore` on every
  hydrate, so a one-sided `addIssueToFlight` silently vanishes. CLAUDE.md has
  been corrected to state this.
- Cost double-count: backend persists `total += delta` then emits the delta;
  the frontend adds it again; a hydrate landing between the two double-counts,
  and the `max()` merge makes the inflation permanent, defeating
  `core::reprice` (`flight_cost.rs:78`; `flightStore.ts:371-383`;
  `storage.rs:543-544`).
- `pkt/<id>` branches are never deleted by the Flight paths (the integration
  path does it correctly); `git worktree prune` is called nowhere.
- Plan apply wholesale-replaces milestones with no confirmation, mints fresh
  task ids (orphaning running cooperative attempts, whose `patchTask` then
  silently no-ops), and lets the agent rename the flight
  (`FlightPlanningCard.tsx:43-48`; `flightPlanning.ts:182,186`).
- Modal defects: `publishAsPrs` re-initializes from the global default instead
  of the flight (silently flips the setting on reopen); SSH targets can launch
  with an empty `basePath`; partial-launch success is reported as total
  failure while recovered agents burn tokens invisibly
  (`LaunchAsyncFlightModal.tsx:96,251-259,420-483`).
- Bridgemind claimed-vs-actual: RG6 code exists but is contradicted by F1;
  AP1–AP8 verified (with caveats: frontend-only enforcement, pre-action cost
  check can overshoot once); CG1–CG8 verified; **CI8 never landed** — the
  coordination inbox only delivers `sender.kind === "user"`, so agent-origin
  messages are recorded but never forwarded; the loop doc has been noted for
  correction. E1–E9 verified. PacketAgent handoff honestly partial.

### Frontend (grade B; full team report)

- **The listener-lifecycle bug family (8 files):** the `unlisten` fn is
  assigned _after_ `await listen(...)`, so unmount during registration leaks
  the listener permanently. Members: `useTerminalSession.ts:306-319`, the five
  quality/PR panels, `AutoFixButton.tsx:89-133` (registered in the click
  handler with no unmount cleanup at all; `cancelQualityFix` exists and is
  never called), `reviewerGateRuntime.ts:321,406` (one leak per retry), and
  `apiAgentListeners.ts:254-812` (14 sequential awaits with no rollback on
  failure). Three correct reference implementations already exist in-repo.
- **A five-file `mountedRef` bug** (`mountedRef` never re-set `true` in the
  effect body under StrictMode) silently breaks PR description, PR review, and
  all three quality-AI panels under `pnpm tauri dev` only — they stream
  forever, never render, and fire two backend sessions each. One-line fix per
  file.
- **Persistence gaps:** `workspaceStore` is the sole store with neither
  write-ordering nor a hydrate merge — a workspace created during the
  bootstrap window is dropped (`workspaceStore.ts:360-363,784-792`;
  `flightStore`'s `persistenceTail` is the reference). `agentTaskStore.ts:1022`
  fire-and-forgets `writePty`, so a user message to a dead PTY is silently
  lost. Several floating rejections in plan-approval and dictation paths.
- **Four undefined theme tokens are live visual bugs** — `accent-cyan`,
  `accent-yellow` (×7, PR pending pills), `accent-orange`,
  `text-text-tertiary` emit no CSS, so those elements render colourless
  (`flight-colors.ts:26`; `PRChecksTab.tsx:239-296`).
- **Brand-literal gap:** 43 hardcoded `"packetade:…"` storage-key literals and
  7 `packetade://` URIs bypass `storageKey()`/`URI_SCHEME` (which has zero
  importers) — safe today because the legacy migration is a blanket prefix
  copy, but it recreates the rename-churn problem `brand.ts` exists to solve.
- **Accessibility debt is systemic but concentrated:** the shared `Dropdown`
  has no ARIA/arrow keys and drops focus on select; ~41 icon-only buttons have
  no accessible name; ~161 inputs are unlabeled; the command palette has no
  listbox semantics; the left rail is a plain div without `aria-current`;
  `useApprovalShortcuts` binds bare `y`/`n` such that typing in a
  contenteditable can silently approve a tool call.
- **Dead code:** 23 unreachable files by full import-graph analysis; ~15
  immediately deletable including all three backlog suspects, the 492-LOC
  `IssueDetailView.tsx`, and the dead twin `views/SpecImportModal.tsx` (the
  `issues/` copy is live — don't grep by basename). 16 dead `tauri.ts`
  wrappers front registered Rust commands (Rust-side check before removal).
- **Store architecture verdict:** 57 stores, boundaries sound, **no merges
  recommended** — the suspected `historyStore`/`projectHistoryStore`/
  `promptStore` overlap is a false positive. The real defect: ~2,483 LOC of
  Tauri event-listener _runtimes_ filed under `stores/` (exactly the untested
  code) — recommend `src/runtime/`; also rename `src/agents/` (PTY parsers) →
  `src/lib/pty/` to end the collision with `components/agents/`.
- **Coverage is not measured at all** — no coverage tooling, no thresholds, no
  CI; the pure state layer is seriously tested while the six modules that
  spend money or write to remote systems (`LaunchAsyncFlightModal`,
  `reviewerGateRuntime`, `issueFlightMirrorStore`, `ServerFormModal`, attempt
  listeners, the PTY pattern parser) have zero behavioural tests.
- Smaller items: `FlightsView` sidebar status-dot map disagrees with the
  shared `FLIGHT_STATUS_CONFIG` (selecting a row changes its colour); dual
  `useGitInfo` pollers spawn duplicate `git` children on DrvFs; native-mode
  dictation double-inserts into the composer; `agentTaskStore` is ~1,780 lines
  and growing (split tracked in backlog).

---

## 5. Documentation: state and the work done in this pass

The 2026-08-03 reconciliation genuinely held (markdown set graded A−, zero
broken relative links across the 76 files then present, re-verified at 73 after
this pass's archive moves and additions; HANDOFF's test counts verified). The
gaps were omission-shaped, and the biggest one was public: the GitHub Pages
site (`docs/*.html`, live at packetloss404.github.io/PacketADE) still
advertised eight providers, ChatGPT Plus login, and the removed Cost
Dashboard.

**Applied in this pass (2026-08-05/06):**

1. `docs/index.html`, `docs/packetade-manual.html`, `docs/roadmap.html` —
   repaired against v0.10.3: 7 API-key provider rows, subscription/OAuth copy
   removed (PTY-CLI subscription note kept, accurately), Cost Dashboard copy
   deleted in favour of budget guardrails, version strips/ladder updated.
2. `CHANGELOG.md` — added the missing `[0.10.3]` entry for the `fd8c2264`
   runtime-authority correctness pass, including the protocol-v11 note.
3. `CLAUDE.md` — provider count 8→7; hooks list corrected
   (`useCodexStatusLine` never existed); `AgentsView` added to the structure
   map; the Flight↔Issue invariant restated as the code actually enforces it.
4. `README.md` — retired-attachment handoff language replaced; phantom
   `/usage` removed; right-dock description corrected (resizable 260–720 px,
   Editor panel, no toggle); Code Quality section expanded to match the real
   feature; auth-badge states completed; command palette, multi-account CLI,
   aux-LLM routing, custom endpoints, theme switching, and the real quality
   ladder (`preflight`/`check`/`sidecar:check`) documented; release banner
   notes `main` is docs-ahead of the tag.
5. `backlog.md` — Fable 5 findings registered (see §3); the orphaned
   `docs/deferred-work.md` items folded in (per-launch MCP multi-select,
   `costCapUsd`, reasoning-effort control, diff-viewer controls,
   `agentTaskStore` split, harness/reaper verification); v1.0.0 scope added as
   owner decision #4.
6. `dev/README.md` — indexed the orphaned
   `high-priority-real-work-loop-2026-08-01.md` and `github-pane-v9-loop.md`;
   noted the shared RG8/CG9/CI9/AP9 evidence file.
7. Archive moves: `dev/zen-workspace/` → `dev/archive/zen-workspace/`;
   `pre-remote-agents-loop-queue.md` + `pre-remote-convergence-2026-07-28.md`
   → `dev/archive/`; `docs/deferred-work.md` →
   `dev/archive/deferred-work-2026-07-30.md`; deleted the dead
   `dev/ssh-tech-debt.md` tombstone.
8. `docs/reports/state-of-the-ade-2026-07-30.md` §0 — patched: owner-decision
   count, `ab25041` in the resolving-commit list, item 16 reframed to the
   decided position, new item 17 (Packet Control / PacketBBS adoption), stale
   test counts, three broken `§0.3 item 1` Undo cross-refs, the wrong
   `IssueDetailView` path, and supersession notes for the ledger.

**Remaining doc decisions:** whether to regenerate the State report §11
Mission→Flight removal gate against v0.10.3 (still keyed to 0.10.2), and the
CI contradiction — `dev/local-quality-gates.md` says no CI is expected while
`backlog.md`/`ROADMAP.md` carry hosted CI as P1. The review's position:
hosted CI wins; update `local-quality-gates.md` when CI lands.

---

## 6. What the screenshots show

Captured 2026-08-05 from the real frontend (Vite dev build, stubbed Tauri
bridge, empty state): the welcome screen, Workspace/Fleet, Agents with the
new-agent launcher, Flight Deck, the Issues kanban, Memory, GitHub connect,
the six-group Settings IA, and the `Ctrl+K` command palette. Embedded in the
HTML edition.

---

## 7. Recommended immediate order

Revised 2026-08-06, now that all twelve P1s have landed:

1. **Today:** signing-identity applications — Azure Trusted Signing plus an OV
   fallback for Windows, **and Apple Developer Program enrollment in parallel**
   (macOS is a v1.1 target, but enrollment is its long pole). `*.key` into
   `.gitignore`, then generate the updater keypair and back it up twice.
2. **This week:** wire the updater client; delete `fuzzy-matcher` and add
   `default-features = false` to reqwest; run one full `pnpm check` including
   Playwright, **and one full `release:readiness` from a Windows shell** where
   Cargo is on PATH — that rehearsal is the thing the 2026-08-06 dry run could
   not cover.
3. **Next week:** rc1 build → **install it** → packaged acceptance matrix →
   reserved fix buffer. Every P1 fix is test-verified but none is runtime-
   verified, so this matrix is where they are actually proven: the bundled-
   sidecar conversation first, then PTY teardown on pane close and app quit,
   an MCP read-only session against a real server, and a Flight attempt through
   accept and land.
4. **08-17+:** final signed 1.0.0, clean-machine verify, release record, tag,
   publish, docs sync. Cut an unsigned macOS build during the fix buffer and
   run its acceptance matrix, so v1.1 is a signing exercise rather than a
   discovery exercise.

Everything else — including the environment-gated proof matrices, Remote
Agents, and Global Undo — is explicitly 1.1+ per the scope definition awaiting
owner sign-off in `backlog.md`.

---

## 8. The pattern behind the release-machinery defects

Worth stating separately, because it generalises past the specific scripts and
past this review.

Every defect found in the release machinery had the same shape: **a fallback
that looked identical to a deliberate choice.**

- `release-readiness.mjs` reported `[PASS] pnpm test` because the script _name_
  existed — indistinguishable from having run it.
- A typo'd `PACKETADE_RELEASE_TARGET` silently widened the search to every
  platform's artifacts, so a stale `.dmg` could satisfy a Windows check —
  indistinguishable from a deliberate cross-platform search.
- The bundle-root lookup fell through to `src-tauri/target` whenever
  `cargo metadata` could not run — indistinguishable from that being the
  configured root.

None of these was missing logic. Each was a default standing in for a value
nobody could see, and in each case the failure was silent and in the _reassuring_
direction. The same shape appeared outside the scripts: a substring denylist
that answered "is this tool read-only?" with a guess, and a protocol mismatch
that degraded to a warning when the thing that changed was a security boundary.

The durable fix in each case was not a stricter check — it was **making the
input visible**. `Target: windows (from PACKETADE_RELEASE_TARGET)` and
`Bundle root: /mnt/c/... (from src-tauri/.cargo/config.toml [build] target-dir)`
are worth more than any individual assertion added this session, because they
let the next false result diagnose itself.

The operating rule: **a gate that cannot show its inputs cannot be trusted to
have used the right ones.** Prefer refusing to guess over guessing quietly, and
print the provenance of anything inferred.

This is not hypothetical. Four separate times during this review a signal
pattern-matched a known failure and had an entirely different cause — a stale
DrvFs `git status`, vitest worker timeouts that were machine contention, a
"missing" v0.10.3 bundle that was a redirected target directory, and a
"never ignored" config key that was a silent `cargo metadata` fallthrough. Each
was caught only by checking the specific evidence rather than accepting the
plausible story. Both the review teams and the review lead were wrong at
different points; the corrections came from verification, not authority.
