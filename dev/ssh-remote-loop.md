# SSH & Remote Workspaces — Scoped Loop

Created: 2026-07-25
Backlog: [`../backlog.md`](../backlog.md) → "SSH & remote workspaces".
Shape: same gated-loop cadence as [`gitea-support-loop.md`](./gitea-support-loop.md)
(discrete, independently-gated items; per-item commit; verify → record).

## Objective

Harden and finish the SSH/remote-workspace surface: reap orphaned remote
processes on timeout, polish remote Git, close the Windows-OpenSSH and
`realpath` fail-closed gaps, tighten the `ServerConfig` wire contract, and run
the environment-gated remote smoke. One P2 (the live smoke) + P3 hardening.

## Grounding — what's live today (do not rebuild)

| Piece | Where | Notes |
|---|---|---|
| SSH host record | `ServerConfig` — TS `types/server.ts`, Rust `core::storage::ServerConfig` | Single canonical host record. Powers PTY launches + API-agent file/bash tools + remote worktrees. Passwords in keyring `ssh-<id>` (`commands/ssh_keys.rs`). |
| Per-connection exec config | `core::execution::SshConfig` | Built from `ServerConfig` at each call site; always populate `host_fingerprint` from `ServerConfig.hostFingerprint` (else TOFU `accept-new` + warn). |
| Remote tools | `core/tool_runtime_ssh.rs` | `ssh_run`, remote read/list/grep/write_file with `confine_prelude` (symlink-escape confinement via `realpath`, **fails closed** exit 9). File size cap 2 MB (`:10`). `bash` intentionally unconfined. |
| Local bash tool | `core/tool_runtime.rs` (`execute_bash`) | `kill_on_drop(true)` reaps only the direct child, not grandchildren. |
| Sidecar bash parity | `agent-sidecar/src/providers/openai-agents.ts::killTree` | Full process-group / `taskkill /T` kill — the parity target for the Rust paths. |
| Remote git | `commands/git.rs` (`*_remote` cmds), `ssh_check_remote_path` | POSIX `[ -e … ]` / `git -C` — breaks on Windows OpenSSH targets. |
| Flight attempts (remote) | `commands/flight_attempts.rs` | `cancel_flight_attempt` fingerprint asymmetry (:330-342), cleanup deferred to FE. Remote worktree launch/cleanup. |
| Wire bindings | `lib/tauri.ts` | `cloneRepoRemote` (no caller), `target_id` field kept for back-compat (:1331-1336). |
| Resume path | `agentTaskStore` `resumeApiConversation` | Resolves `port`/`keyPath`/`hostFingerprint` from live `ServerConfig` but persisted `host`/`user`/`remotePath`. |
| Host form | `ServerFormModal` | `keyPath` not sanitized against shell metacharacters. |
| Verification | `dev/sidecar-over-ssh-verification.md` | Step 12 = the live remote smoke (P2). |

## Loop ledger

`queued → in-progress → gated → closed`. Safety/correctness first, then wire
hygiene, then the platform-parity (Windows-OpenSSH) block, then the live smoke.

| ID | Item | Acceptance | Key hooks | Gate | Size | Status |
|---|---|---|---|---|---|---|
| **S1** | Reap orphaned remote/local grandchildren on timeout | On timeout/drop the whole process tree dies, not just the direct child: POSIX process-group kill + Windows `taskkill /T` for `execute_bash`; `ssh -tt`/`RequestTTY` so the remote command gets SIGHUP on disconnect for `ssh_run`. Parity with the sidecar `killTree`. | `core/tool_runtime.rs::execute_bash`; `core/tool_runtime_ssh.rs::ssh_run`. | cargo check + unit test on the kill-signal path where feasible. | M | ✅ closed — process-group kill (`process_group(0)`+`killpg`) / `taskkill /F /T`; concurrent pipe drain; `ssh -tt` (bash tool only) + CR normalize; `#[cfg(unix)]` grandchild-reap test. cargo check --tests REAL_EXIT=0 |
| **S2** | `keyPath` argv hygiene | `ServerFormModal` save rejects key paths containing non-printable or shell-metacharacter bytes, before they reach any argv. | `ServerFormModal`; a pure `isSafeKeyPath` validator (shared with Rust if practical). | Vitest: pure validator (accept/reject cases). | S | ✅ closed — `lib/sshKeyPath.ts` `isSafeKeyPath` (rejects control bytes + `; \| & $ ` `` ` `` `< > " '`, allows Windows backslashes/spaces/parens); modal blocks save + inline error. vitest 5/5, lint 0, build OK |
| **S3** | Remote Git polish | Per-file remote diff; a friendly non-fast-forward push message; defense-in-depth `..`/absolute-path rejection for remote staging. | `commands/git.rs` remote diff/push/stage; reuse path-guard helper. | cargo check + path-guard unit test. | M | ✅ closed — `validate_remote_rel_path` guards stage/unstage/diff; `friendly_push_error` (non-ff → actionable msg); `git_diff_file_remote` (`ssh_show_head`+`ssh_read_working_file`) wired into GitDashboard so remote rows open the diff viewer. cargo check --tests REAL_EXIT=0 (4 new unit tests), lint 0, build OK |
| **S4** | `cancel_flight_attempt` fingerprint symmetry | Backend cleanup carries the host fingerprint the same way the FE path does, so a backend-initiated cancel pins host-key correctly. | `commands/flight_attempts.rs:330-342`. | cargo check. | S | ✅ closed — `resolve_server_ssh_config` re-resolves the saved `ServerConfig` by target_id (with `host_fingerprint`) so cancel cleans up the remote worktree itself with host-key pinning instead of deferring; pure `ssh_config_from_server` + 2 unit tests. cargo check --tests REAL_EXIT=0 |
| **S5** | `resumeApiConversation` full live-config lookup | Resume resolves `host`/`user`/`remotePath` from the live `ServerConfig` too (not persisted copies), so a renamed/repointed server resumes to the right host. | `agentTaskStore.resumeApiConversation`. | Vitest: resume builds `SshConfig` from live config. | S | ✅ closed — pure `buildResumeSshConfig` resolves host/user/port/key/auth/fingerprint from the live server (falls back to persisted when deleted); `remote_path` intentionally stays the conversation's own working dir (not the server default). vitest 4/4, lint 0, build OK |
| **S6** | `clone_repo_remote` — surface or remove | Either wire a "Clone to remote workspace" action (`WorkspaceCreationModal` / ServersView) to the existing `cloneRepoRemote` binding, or remove the dead binding. | `lib/tauri.ts` `cloneRepoRemote`; `WorkspaceCreationModal`/`ServersView`. | Vitest/RTL or removal; lint/build. | S | ✅ closed — **surfaced** (kept the tested backend): `WorkspaceCreationModal` shows a "Clone a repo here" input when the remote path isn't a git repo; `handleCreate` clones via `cloneRepoRemote` before creating the workspace, aborting on clone failure. Pure `buildRemoteCloneArgs`/`shouldOfferRemoteClone` + 9 vitest. lint 0, build OK |
| **S7** | Rename `target_id` → `server_id` across the wire | The in-flight back-compat `target_id` field name is migrated to `server_id` end-to-end, with a read shim for persisted data. | `lib/tauri.ts:1331-1336`; Rust DTO field; persisted-data read shim. | cargo check + vitest (shim reads old field). | M | queued |
| **S8** | Portable `realpath` fallback (fail-open-safely) | Remote file tools keep working on remotes without `realpath` (BusyBox, Windows OpenSSH): probe `command -v realpath || readlink -f`, and choose a safe degradation rather than losing the file tools entirely. `bash` stays unconfined. | `core/tool_runtime_ssh.rs::confine_prelude`. | cargo check + prelude-string unit test. | M | queued |
| **S9** | Windows-OpenSSH remote hosts | `ssh_check_remote_path` and remote git commands work against Windows OpenSSH targets (no POSIX `[ -e … ]` / `git -C` assumptions) — detect shell/OS or use portable constructs. Pairs with S8. | `commands/git.rs`; `core/tool_runtime_ssh.rs`; remote-OS detection. | cargo check + unit tests on the portable command builders. | L | queued |
| **S10** | SFTP / port-forward / file-size cap (Phase 4.3) | Lift/raise the 2 MB remote file cap with a streamed transfer (SFTP or chunked), and/or port-forward support. | `core/tool_runtime_ssh.rs:10` (cap); transfer path. | cargo check + size-cap test. | L | queued |
| **S11** | Live Codex-over-SSH smoke (P2) | One real remote host: remote Codex auth + installed sidecar, per `dev/sidecar-over-ssh-verification.md` step 12. **Environment-gated** — needs a configured SSH server (absent in the 2026-07-19 dev env). | `dev/sidecar-over-ssh-verification.md`. | Manual verification record (no code gate). | S | queued (env-gated) |

## Deferred (not in this loop)

- **Full Windows-remote parity beyond git/file tools** (PTY quirks, path
  translation edge cases) — S9 covers the check/git surface; deeper parity is
  its own effort.
- **Interactive port-forward UX** if S10's scope proves too wide — ship the
  streamed file cap first, port-forward later.

## Loop protocol

Each iteration: claim the lowest-ID `queued` item whose deps are `closed`
(S11 is env-gated — do when a remote host is available); revalidate hooks
against current code; implement minimally; add a focused test (prefer pure
helpers + Rust unit tests); gate (targeted vitest + `pnpm lint` + `pnpm build`;
`cargo check` real-exit into the `packetade-build` scratch/target, never the
user's build dir); flip to `closed` + record; commit one item per commit on
`feat/ssh-remote-hardening`. Always populate `SshConfig.host_fingerprint` from
`ServerConfig.hostFingerprint` in any new call site.

## Suggested slices

- **Safety slice (do first):** S1 (process-tree kill) → S2 (keyPath hygiene) →
  S3 (remote-git path guards). Correctness/security, small surface.
- **Wire-hygiene slice:** S4 (fingerprint symmetry) + S5 (live-config resume) +
  S6 (clone binding) + S7 (`server_id` rename).
- **Platform-parity slice:** S8 (`realpath` fallback) + S9 (Windows-OpenSSH) +
  S10 (file cap) — the biggest block; re-confirm scope before S9/S10.
- **S11** whenever a real remote host is available (unblocks the P2).
