# PacketADE — LAUNCH-READY BUILD SPEC (completed historical record)

> **Completed 2026-07-19.** Deploy Option A had already landed in `f20801e` and
> was merged through `5bbf0c5`; the later cleanup removed its unused brand
> constants and E2E mocks. Do not relaunch this workflow from this document.

Each item below is a self-contained slice. The loop runs one slice per iteration on its own branch: **implement → 2 adversarial reviews → fix → run the item's GATE → commit**. Do not re-derive; the file/line anchors and edits are pinned. Never run prettier on `src/`. Never run preflight/format:check.

---

## RESOLVED — deploy-P2 Option A shipped

The deploy command family was confirmed 100% dead (zero callers in `src/`, `src-tauri/`, `e2e/`, `agent-sidecar/`; not in `api/mod.rs` or `tauri-schema.ts`; FE deploy surface already removed). **Option A was selected and shipped.** The alternatives below are retained only as historical context.

- **Option A — DELETE (RECOMMENDED DEFAULT):** amputate the dead command family. Closes F22/F23/F24/F25/F39 as a side effect. One commit, low risk, no schema impact.
- **Option B — RE-SURFACE UI:** net-new feature (rebuild `DeployTerminal.tsx`, `deployStore.ts`, listeners, invoke wrappers). Out of scope for a bug-fix loop; do NOT let the loop attempt this.

The loop proceeded with **A (delete)**. This gate is closed; do not ask for the decision again.

---

## RECOMMENDED ORDER (cheapest/safest first)

1. **G33** — frontend-only, single-function edit + one test, fully local-verifiable. Safest.
2. **deploy-P2 (if A)** — pure deletion, no logic, compiler-verified. Very safe once decision is made.
3. **F53** — scripts + config only; pure unit test; no Rust/app runtime. Cross-arch effect hard to fully e2e locally but the unit test + manual `TAURI_ENV_TARGET_TRIPLE` prune probe is enough.
4. **G01** — Rust-only, has real `cargo test --lib` coverage; the exit hook needs a manual `tauri dev` quit-and-`ps` verify (documented). Medium.
5. **sshpw-P2** — Rust-only, unit-testable, but true password-ssh is **NOT e2e-able in CI** — relies on unit tests + manual dev-box verify. Verify-hard.
6. **G09** — sidecar; **hardest to verify locally** (codex is nondeterministic, needs `codex-cli` installed; the live crash reproduces only on codex 0.144.5). Do last so earlier wins bank first. Multi-commit internally.

## INDEPENDENCE / SHARED-FILE MAP

- **Fully independent (no file overlap with any other item):** G33 (`src/stores/*`), F53 (`scripts/*`, `vite.config.ts`), G09 (`agent-sidecar/*`, `package.json`), deploy-P2 (`deploy.rs` + registrations).
- **G01 and sshpw-P2 BOTH touch `src-tauri/src/commands/pty.rs` and `src-tauri/src/lib.rs`.** G01 edits `lib.rs:455` (run→build+run exit hook) and `supervisor.rs`; sshpw-P2 edits `pty.rs:719` (`ssh_exec`) + `main.rs` + new `core/ssh_askpass.rs`. Overlap is `lib.rs` (G01 the run-tail; sshpw only needs `core` to stay `pub` — no edit) and `pty.rs` (only sshpw edits it; G01 does not). **Net: near-independent, but sequence G01 before sshpw and rebase** so both `lib.rs`/`pty.rs` changes are seen. If a merge conflict arises it will be trivial (different functions).
- deploy-P2 touches `src-tauri/src/commands/mod.rs` and `lib.rs:399-403` (registration list) — a different region of `lib.rs` than G01's run-tail (`:455`). If both land, expect a trivial `lib.rs` context overlap; order deploy-P2 before G01 or rebase.

---

## ITEM G33 — Stop while a message is QUEUED re-sends the queued message

**Root cause:** `cancelActiveConversation` never clears `queuedMessages`; the backend cancel emits `api-agent:done` (same event as a real completion), and the done listener drains the queue → re-sends the message the user was cancelling.

**Fix (single edit):** `src/stores/agentTaskStore.ts` — replace body of `cancelActiveConversation` (lines 944-966). Do the store update **synchronously before** `await invoke("cancel_api_agent_session", …)`: map the target conv to `messages.filter(m => !m.queued).map(strip isStreaming)`, set `queuedMessages: []`, `status:"idle"`, `updatedAt:Date.now()`, capture `updated`, `scheduleSave(updated)`, then the try/catch invoke. No listener-module change. (`scheduleSave` and `AgentConversation` already imported.)
- Rationale: synchronous write completes before the cancel-induced `done` can arrive, so the drain finds an empty queue. Dropping `queued:true` bubbles prevents a bubble stuck forever in "queued".

**Test:** add to `src/stores/__tests__/apiAgentListeners.test.ts` a new describe "Stop with a queued message does not re-send it (G33)": seed active conv with initial + streaming-assistant + `queued:true` bubble and `queuedMessages:["please cancel me"]`; `installApiAgentListeners`; call `cancelActiveConversation`; fire `api-agent:done:conv-stop`; `vi.runAllTimers()`; assert `sendApiAgentMessageMock` NOT called, `queuedMessages===[]`, `status==="idle"`, no `queued`/`isStreaming` bubbles. Use fake timers. (Existing protected test at line 244 and `agentQueuedSend.test.ts` stay green.)

**GATE:** `pnpm run lint:src` ; `pnpm run build` ; `pnpm test -- --run`. (No Rust/sidecar/schema.)

**Risk:** low. Only behavioral edge: user's typed queued text is discarded on Stop (intended; re-pushing to draft store is a future enhancement, out of scope).

**Decision:** none.

---

## deploy-P2 — Amputate dead deploy command family (assumes DECISION A)

**Root cause:** dead code — 4 commands + DTOs with zero callers anywhere.

**Fix (single interdependent commit):**
1. Delete entire `src-tauri/src/commands/deploy.rs` (445 lines incl. 3 inline tests).
2. `src-tauri/src/commands/mod.rs:15` — remove `pub mod deploy;`.
3. `src-tauri/src/lib.rs:399-403` — remove the `// Deploy pipeline` comment + the 4 `commands::deploy::{read_deploy_config, create_deploy_config, validate_deploy, run_deploy}` registrations.
4. `src-tauri/src/core/brand.rs:36-38` — remove `DEPLOY_CONFIG_FILENAMES` const + doc (only used by deploy.rs).
5. `src/lib/brand.ts:22-26` — remove `LEGACY_DEPLOY_CONFIG_FILENAME` + `DEPLOY_CONFIG_FILENAME` (zero importers).
6. `e2e/setup/mock-tauri.ts` — line 24 remove `/^deploy:(output|exit):/` pattern; line 97 trim comment to MCP-only; line 99 remove `read_deploy_config: () => ({}),`.

Leave untouched: `dev/archive/moat/deploy-pipeline-*.md`, `dictation/whisper.rs:50`, and shared helpers `validate_project_path`/`hide_window`/`decode_terminal_chunk`.

**Test:** none added (deletion). The 3 inline deploy tests vanish; no external references.

**GATE:** `(cd src-tauri && cargo check --lib)` ; `(cd src-tauri && cargo test --lib)` ; `pnpm run check:tauri-schema` (unchanged — deploy not in schema) ; `pnpm run lint:src` ; `pnpm run build` ; `pnpm test -- --run`.

**Risk:** very low; compiler proves completeness. No `deny(warnings)` in crate.

**Decision:** the A/B choice at TOP — must be resolved before this slice runs.

**Commit:** `refactor(deploy): amputate dead deploy command family [P2]` (closes F22/F23/F24/F25/F39).

---

## ITEM F53 — cross-arch build bundles the WRONG native sidecar (host `claude`, not target)

**Root cause:** `scripts/prune-sidecar.js` re-installs sidecar prod deps with no arch targeting, so pnpm materializes the **host-arch** `@anthropic-ai/claude-agent-sdk-<os>-<cpu>` platform package (carrying the 196 MB `claude`), while `scripts/fetch-node.js` correctly ships the **target** `node`. On any cross-arch build the two disagree → target `node` can't find its platform `claude` → sidecar can't launch.

**Fix mechanism (validated):** pnpm's **`pnpm.supportedArchitectures`** package.json field forces cross-arch optional-dep resolution. The CLI `--config.supportedArchitectures…` form is confirmed **non-functional** in pnpm 9.15.4 — must go through the package.json field.

**Edits:**
1. **NEW `scripts/target-triple.js`** (pure, unit-testable): export `SUPPORTED_TRIPLES` (the 5 triples from `fetch-node.js:74-105`), `detectHostTarget()`, `resolveTarget({argv,env})` (priority `--target=` → `TAURI_TARGET` → `TAURI_ENV_TARGET_TRIPLE` → host-detect; throw on unknown), `tripleToSupportedArchitectures(triple)` → `{os,cpu,libc?}` (win32/x64; darwin/x64; darwin/arm64; linux/x64+glibc; linux/arm64+glibc), `sidecarPlatformPackage(triple)` → dir name (e.g. `@anthropic-ai/claude-agent-sdk-darwin-x64`, `-win32-x64`, `-linux-x64`).
2. **`scripts/prune-sidecar.js`** — between the wipe (~166) and install (~171): `resolveTarget` + log it; temporarily inject `pkg.pnpm.supportedArchitectures = tripleToSupportedArchitectures(target)` into `agent-sidecar/package.json` (read raw bytes first), run existing install unchanged, then in a `finally` restore the **byte-exact original** package.json. After size report (~218) add build-failing asserts: `agent-sidecar/node_modules/<sidecarPlatformPackage(target)>/claude[.exe]` exists & non-empty (else `fail()`), and NO foreign `claude-agent-sdk-*` platform dir present (else `fail()`). `fail()` exits 1 → aborts `beforeBuildCommand`.
3. **`scripts/release-gate.mjs`** — mirror: resolve target, assert the matching `claude[.exe]` present, no foreign platform dir, and matching `src-tauri/binaries/node-<triple>[.exe]` present (ties node target ↔ claude target).
4. **`scripts/fetch-node.js`** — (recommended) refactor to import `SUPPORTED_TRIPLES`/`resolveTarget` from `target-triple.js` so they can't drift. **May be staged as a follow-up commit** if keeping the money-change tight; prune only needs the new functions.
5. **`vite.config.ts`** — extend `test.include` to `["src/**/*.{test,spec}.{ts,tsx}", "scripts/**/*.{test,spec}.{mjs,ts}"]` so the new test runs under GATE.

**Test:** **NEW `scripts/target-triple.test.mjs`** (pure, no fs/network): assert `tripleToSupportedArchitectures` for all 5 triples (incl. linux `libc:["glibc"]`); `sidecarPlatformPackage` maps (`aarch64-apple-darwin`→`…-darwin-arm64`, `x86_64-pc-windows-msvc`→`…-win32-x64`, `x86_64-unknown-linux-gnu`→`…-linux-x64`); `resolveTarget` priority (`--target=`>env; `TAURI_TARGET`>`TAURI_ENV_TARGET_TRIPLE`; unknown throws; host-detect fallback returns a `SUPPORTED_TRIPLES` member or throws).

**GATE:** `pnpm test -- --run` (now includes `scripts/**`, requires the `vite.config.ts` edit) ; `pnpm run build` ; `pnpm run lint:src` (does not cover `scripts/` — manually `node --check` each edited script). Cargo/schema/sidecar unaffected. Manual cross-arch probe (optional): `TAURI_ENV_TARGET_TRIPLE=x86_64-apple-darwin node scripts/prune-sidecar.js` on arm64 → expect `claude-agent-sdk-darwin-x64` installed + asserts pass, then **`pnpm sidecar:install`** to restore (prune is destructive).

**Risk:** low logic risk; residual = `TAURI_ENV_TARGET_TRIPLE` presence on a plain (non-`--target`) `tauri build` (pre-existing fetch-node constraint, now shared — cross-builds must go through `tauri build --target <triple>`). musl not handled (no musl triple today).

**Decision (minor, recommended default = YES):** refactor `fetch-node.js` to share the resolver now vs. follow-up. **Recommend doing it in this slice** to prevent drift; acceptable to defer if it complicates review.

---

## ITEM G01 — Node sidecar tree orphaned on app exit

**Root cause:** `src-tauri/src/lib.rs:455` — app installs no exit hook; and `supervisor.rs:586-602` spawns the Node child with no process group and no tracked live PID, so on exit the sidecar + grandchildren (codex, MCP, ssh) are orphaned.

**macOS fork-safety constraint (CRITICAL):** do **NOT** use `pre_exec(setsid)` — forces fork()+exec, forbidden by the PTY fork-safety memory. Use `tokio::process::Command::process_group(0)` (verified tokio 1.50; delegates to std `POSIX_SPAWN_SETPGROUP` on the posix_spawn fast path — no fork). `spawn_via_tokio` sets no `pre_exec`/`current_dir`, so it stays on the fast path.

**Fix (`supervisor.rs` + `lib.rs`):**
1. `spawn_via_tokio` (~586): `#[cfg(unix)] cmd.process_group(0);`. After `child.id()` (602) store PID in new sync field; clear on all exit paths (640-648, 662-666). `spawn_via_shell_sidecar` (~692): store pid with `own_group:false`.
2. New std-sync manager fields (struct 66-96, init 108-117): `local_child: std::sync::Mutex<Option<ChildHandle>>`, `remote_children: std::sync::Mutex<HashMap<String,u32>>`, `shutting_down: AtomicBool`; `struct ChildHandle { pid:u32, own_group:bool }`.
3. Remote ssh (`spawn_remote_sidecar_for_session` ~303-318): `#[cfg(unix)] cmd.process_group(0);`, record `child_pid` into `remote_children` keyed by `session_id` (clone an `Arc<std::sync::Mutex<…>>` into the wait task, mirroring `remote_sessions`); remove it in the wait task (380-392).
4. Resurrection guard: top of `spawn_and_supervise` loop body (~433): `if self.shutting_down.load(SeqCst) { return; }`.
5. New sync `pub fn shutdown(&self)`: set `shutting_down=true`; take `local_child` → `kill_process_tree(pid, own_group)`; drain `remote_children` → `kill_process_tree(pid, true)`. New free `fn kill_process_tree(pid,own_group)`: unix → if `own_group && pid>1` `libc::kill(-pid, SIGTERM)` then `SIGKILL`, else `pid>1` `SIGKILL`; windows → `taskkill /T /F /PID` with `CREATE_NO_WINDOW`. Mirrors `pty.rs:407-417`.
6. **`lib.rs:455`** — replace `.run(generate_context!())` with `.build(generate_context!()).expect(…).run(|app_handle, event| { if let RunEvent::Exit = event { if let Some(mgr)=app_handle.try_state::<Arc<SidecarManager>>() { mgr.shutdown(); } } })`. (`App::run` verified tauri 2.10.3; `SidecarManager` imported at `lib.rs:7`; managed at 161-162.)

**Test (`#[tokio::test]` in supervisor.rs `#[cfg(test)]`, runs under `cargo test --lib`):**
1. `kill_process_tree_reaps_group_leader_and_grandchild` (unix): spawn `sh -c 'sleep 60 & echo $!; wait'` with `.process_group(0)`, read grandchild pid; `kill_process_tree(pid,true)`; poll `libc::kill(_,0)`→ESRCH for both.
2. `kill_process_tree_single_pid_kills_only_target` (unix): `own_group:false` kills the one pid.
3. `shutdown_sets_flag_and_drains_children`: populate fields, `shutdown()`, assert flag true + both maps drained.
4. Guard: `kill_process_tree(0/1, true)` is a no-op (`pid>1` guard).

**Manual verify (for `/verify`):** `pnpm tauri dev`, wait for `ready`, note `agent sidecar spawned pid=…`, start a codex/claude session (spawns grandchild), Cmd-Q; confirm `ps`/`pgrep -g <nodepid>` shows the group gone.

**GATE:** `(cd src-tauri && cargo check --lib)` ; `(cd src-tauri && cargo test --lib)` ; `pnpm run build`. (No TS/schema/sidecar edits.)

**Risk:** low. Documented residual gaps (do NOT expand scope): hard kills / force-quit skip `RunEvent::Exit` (fast-follow = persistent `~/.packetade/sidecar-active-pids` startup-reap registry, mirroring `reap_orphaned_pty_children` — **not this slice**); `detached:true` bash shells (`openai-agents.ts:932`) survive a group-kill on hard exit; unix shell-sidecar fallback kills single pid only.

**Decision:** none (startup-reap registry explicitly deferred as fast-follow).

---

## ITEM sshpw-P2 — SSH password auth silently no-ops on Unix

**Root cause:** OpenSSH-Unix reads the login password from `/dev/tty`, never stdin (only OpenSSH-for-Windows falls back to stdin). App pipes the password to `ssh` stdin → works on Windows, silent no-op on macOS/Linux. Two spawn choke points carry a password: `ssh_run` (`core/tool_runtime_ssh.rs:114`, stdin write gated `#[cfg(windows)]` :149-157) and `ssh_exec` (`commands/pty.rs:719`, unconditional stdin write :740-746; reached by `ssh_test_connection` and `ssh_check_remote_path` — the latter subsumes S6).

**Approach:** `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` (+ `DISPLAY=:0` if unset), helper = **our own exe** (mirrors the `__pty_spawn` self-reinvoke — **no new bundled binary**). Secret channel = a random-named **0600 file in a 0700 dir**; pass only the path via `PACKETADE_ASKPASS_FILE` env (path not secret; never argv, never env-borne secret). RAII guard unlinks on `ssh` return / Drop. Do NOT use `sshpass` (external GPL binary) or `setsid`/`pre_exec` (fork-safety memory forbids; no `setsid(1)` on macOS).

**Fix:**
1. **NEW `src-tauri/src/core/ssh_askpass.rs`:** `pub fn helper_main() -> Option<i32>` (reads `PACKETADE_ASKPASS_FILE`; if set, writes file contents to stdout, `Some(0)`; else `None`) with pure `fn read_secret(&Path)`; `#[cfg(unix)] struct AskpassGuard { path }` (Drop removes file); `#[cfg(unix)] fn arm(cmd, password) -> Result<AskpassGuard,String>` (ensure 0700 dir, `create_new().mode(0o600)` write password, set `SSH_ASKPASS=current_exe()`, `SSH_ASKPASS_REQUIRE=force`, `PACKETADE_ASKPASS_FILE=path`, `DISPLAY=:0` if unset); `#[cfg(windows)]` no-op stub.
2. **`src-tauri/src/main.rs`** — after the `__pty_spawn` block, before `packetade_lib::run()`: `if let Some(code)=packetade_lib::core::ssh_askpass::helper_main() { std::process::exit(code); }`.
3. **`ssh_run`** (`tool_runtime_ssh.rs:114-159`) — unix + password_auth: `arm(&mut cmd, pw)?`, hold guard var past `child.wait_with_output()`; keep windows stdin path unchanged.
4. **`ssh_exec`** (`pty.rs:719-757`) — unix: if `password.is_some()` arm + hold guard; windows stdin unchanged. No caller signature changes.
   Leave `ssh_args`/`PreferredAuthentications`/`BatchMode` logic and the JS PTY `-t` interactive path alone. Do NOT arm askpass on sidecar spawn sites (`supervisor.rs:303,1294`) — they must keep rejecting password auth via `reject_remote_password_auth`.

**Test (`ssh_askpass.rs` `#[cfg(test)]`, unit only):** `read_secret` byte round-trip (spaces/newlines/quotes); `arm` writes file mode `0o600`, exact contents, and sets the three env vars (assert via `get_envs()`); `AskpassGuard` Drop removes file; `helper_main` → `None` when env unset, `Some(0)` + writes secret when set (run env-mutating tests serially / save-restore env). Keep `execution.rs` `ssh_args_*` and `supervisor.rs:1520-1525` rejection tests green.

**GATE:** `(cd src-tauri && cargo check --lib)` ; `(cd src-tauri && cargo test --lib)` ; `pnpm run check:tauri-schema` (no new command → unchanged) ; `pnpm run lint:src` ; `pnpm run build` ; `pnpm test -- --run`. Sidecar unchanged.

**Verify-hard:** real password-ssh is **NOT e2e-able in CI** — rely on unit tests + optional manual dev-box `ssh_test_connection` against a password host. Edge: OpenSSH <8.4 launched from a real terminal may still prompt on `/dev/tty` (dev-only; GUI launches have no controlling tty).

**Decision (minor, recommended default already chosen):** self-exe helper vs. bundled `sshpass` → **self-exe (no new binary)** is the recommended default baked into this plan. Accepted tradeoff: password file's brief 0600 on-disk existence (document in module doc comment).

---

## ITEM G09 — Codex `respondPermission` writes to closed stdin; approvals can never be delivered (HARDEST TO VERIFY — codex nondeterministic)

**Root cause:** `respondPermission` (`agent-sidecar/src/providers/openai-codex.ts:1143-1177`, write at :1171) targets `child.stdin`, but `spawnCodex` closes it via `child.stdin.end()` (:562) — required so `codex exec` doesn't block reading stdin. `codex exec` is non-interactive and has NO stdin approval protocol; the written shape is speculative/unread. **Hang is latent, not live** — `modeToCodexFlags` never returns `-a on-request`, so approvals never fire and `respondPermission` early-returns.

**COUPLED LIVE BUG (fix together, highest urgency):** on codex-cli 0.144.5, `codex exec` **rejects `-a`/`--ask-for-approval`** (`error: unexpected argument '-a'`). `buildExecArgs` (:264-278) pushes `...sandbox.args` which for default/plan/deny_all/acceptEdits includes `-a never` → **initial (non-resume) exec turns crash immediately**. (`buildResumeArgs` :293-300 strips `-a`, so resume survives.) `-a` moved to config-only for exec.

**Fix (correct fix = do-not-hang, not make-interactive-perms-work):**
1. **`modeToCodexFlags` (:117-155):** remove every `-a <value>` pair; where "never prompt" is wanted, express as config override `-c approval_policy=never` (verify exact key against `~/.codex/config.toml`). `buildResumeArgs`'s `-a`-stripping loop (:293-300) becomes unnecessary → simplify. **This fixes the live default-turn crash.**
2. **`respondPermission` (:1143-1177):** stop writing to `child.stdin`. RECOMMENDED = amputate the dead interactive-approval plumbing: remove the `permission_request` emission (:931-955), the `pendingApprovals` map (:321,:946,:1117,:1149), the stdin write; re-point `respondEdit` (:1179-1200) to a logged no-op; replace `respondPermission` with a stub emitting one explicit `error`/log ("codex exec is non-interactive; per-command approvals not supported — permissions pre-granted via sandbox/approval-policy"). Matches the repo's amputate-dead-code pattern.
3. **Per-turn idle watchdog (defense-in-depth):** timer in `spawnCodex` alongside `killTimer`, armed on spawn, reset on any stdout event in `handleEvent`; if idle > `CODEX_TURN_IDLE_TIMEOUT_MS` (default ~minutes, test-overridable) with no exit → SIGTERM→SIGKILL (reuse cancel escalation :1202-1221) + one `doneEmitted`-guarded `error`. Clear timer in `exit` (:498-523) and `close`.

**Test (event-injection + fake-child; model on `test/codex-0142-schema-smoke.mjs`):**
- `modeToCodexFlags`: assert NO returned args contain `-a` (guards the regression); default/plan produce sandbox-only (+`-c approval_policy` if adopted) flags.
- `buildExecArgs`: assert argv contains no `-a`.
- No-hang/respondPermission: fake `child` whose `stdin` is ended/throws; assert `respondPermission` does NOT write stdin and emits the clear "not supported" error; if amputated, assert `permission_request` never emitted for `exec_approval_request` inputs.
- Watchdog: `codexCommand`=fake long-runner (`node -e "setInterval(()=>{},1e9)"`), short injected idle timeout; assert `error` emitted + child killed within window + `done`/`error` fires exactly once.
- Add as `test/codex-permission-nohang-smoke.mjs` and **wire both it and `codex-0142-schema-smoke.mjs` into `sidecar:check` (`package.json:27`)** — the existing smoke is NOT currently gated.

**GATE (sidecar changed):** all six standard steps **plus `pnpm run sidecar:check`**: `(cd src-tauri && cargo check --lib)` ; `(cd src-tauri && cargo test --lib)` ; `pnpm run check:tauri-schema` ; `pnpm run lint:src` ; `pnpm run build` ; `pnpm test -- --run` ; `pnpm run sidecar:check`.

**Internal commit slicing (do in one branch, 4 commits):** (1) `fix(codex): drop -a from exec flags; approval_policy via -c` (fixes live crash) ; (2) `fix(codex): respondPermission never writes closed stdin; fail cleanly` ; (3) `feat(codex): per-turn idle watchdog` ; (4) `test(codex): gate codex smokes in sidecar:check`.

**Risk / verify-hard:** codex is nondeterministic and requires `codex-cli` installed; the live crash reproduces only on ≥0.144.5. Verify via the fake-child smokes (deterministic, gated) + optional env-gated real-spawn integration test (skipped in CI). Confirm `approval_policy` key against installed codex before finalizing commit 1.

**Decision (recommended default = amputate):** `respondPermission` fix = **option (b) amputate the dead plumbing** (vs. (a) minimal delete-of-write-block). Recommend amputate — matches repo pattern, removes the footgun entirely.

---

## LOOP EXECUTION NOTES

- One branch per item: e.g. `fix/g33-stop-requeue`, `refactor/deploy-amputate-p2`, `fix/f53-cross-arch-sidecar`, `fix/g01-sidecar-exit-hook`, `fix/sshpw-askpass-unix`, `fix/g09-codex-nohang`.
- Per slice: implement → **2 adversarial reviews** → apply fixes → run the item's GATE (listed above) → commit. G09 commits 4 times within its branch.
- Cargo/schema/sidecar GATE steps are harmless to run on frontend-only items but only load-bearing where noted.
- **Historical pre-launch gate:** deploy-P2 A/B was resolved as Option A; this completed workflow must not be relaunched.
- Order: G33 → deploy-P2(A) → F53 → G01 → sshpw-P2 → G09. Rebase G01/sshpw-P2/deploy-P2 against each other for the trivial `lib.rs`/`pty.rs` context overlaps.
