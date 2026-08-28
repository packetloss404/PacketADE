# PacketBench Handoff

Last reconciled: 2026-08-27

This is the restart document. It records the present state, the next decisions,
and the guardrails that must survive. Historical implementation narratives live
in `CHANGELOG.md`, the State report, and Git rather than being duplicated here.

## Restart state

- Branch: `main`, synchronized with `origin/main` at `b0f14891`.
- Application version: `0.11.0`; sidecar protocol: `v11`.
- Worktree clean. Nothing uncommitted, nothing unpushed.
- `main` is the only branch, local or remote. Every branch the previous
  handoff mentioned (`codex/syndicate-integration-toggle`,
  `chore/rename-to-packetbench`, the ACP and LM feature branches) is merged
  and deleted.
- Working directory is `D:\projects\PacketBench`. The GitHub remote is still
  `git@github.com:packetloss404/PacketADE.git` — GitHub redirects it so
  fetch/push work, but the repo has not been renamed. See Next item 2.

## Latest Windows build

**There is no current packaged build.** Nothing has been packaged since the
product was renamed, so no installer of `0.11.0` exists.

The 2026-08-15 development installers the previous handoff recorded are **gone
from disk**. Build output is redirected by `src-tauri/.cargo/config.toml` (a
local-only file, git-excluded) to `C:/Users/ianwalmsley/packetade-build` —
still the *old* product name — and that tree now contains only `debug/`. No
`release/bundle/`, no `.msi`, no `.exe`.

Their SHA-256 hashes remain recorded under `## [Unreleased]` in `CHANGELOG.md`
for provenance. Those artifacts carried the `0.10.5` string while containing
different code from the released 0.10.5, which is why they were never
distributed. The version has since moved to `0.11.0` (commit `d34bf95f`), so
that particular collision cannot recur.

Tagging is behind by more than before: `v0.10.3` is still the newest annotated
tag — `git describe` reads `v0.10.3-50-gb0f14891` — while `CHANGELOG.md`
records 0.10.4 and 0.10.5 as released and 0.11.0 sits unreleased. Anything
reasoning from tags rather than from `CHANGELOG.md` will conclude the tree is
three releases younger than it is.

## What changed since the last handoff

Thirty commits, 2026-08-15 → 2026-08-27, across five threads.

**1. The product was renamed PacketADE → PacketBench** (`5404fb85`, merged at
`d87fb125`). Brand modules are the single source (`src-tauri/src/core/brand.rs`,
`src/lib/brand.ts`); ~400 files, the Tauri bundle identifier, crate/package
names, and the `PACKETADE_*` → `PACKETBENCH_*` env-var prefixes followed. Data
continuity is automatic: the `LEGACY_*` constants now point at `packetade` /
`.packetade` / `packetade:`, so keyring secrets, the data dir, and localStorage
migrate forward on next launch through the existing one-shot migrators.

**2. The Syndicate integration was removed** (`68ce85ee`), then its program
documents were archived (`9bafbff2`). Syndicate separated from the Packet\*
product family by operator decision on 2026-08-27. This reverses the previous
handoff's stated position ("the integration is being kept and invested in, not
removed"). Deleted: `commands/syndicate.rs`, `syndicate_relay.rs`, the frontend
store/lib/component surface, the `kind: "syndicate"` execution-target variant,
the Settings toggle shipped the week before, the now-unused crypto/WebSocket
dependencies, and both controller-protocol conformance fixtures. Persisted
`syndicate` execution targets degrade to `None`/local rather than failing the
state file. The generic SSH/remote machinery is untouched. Five documents moved
to `dev/archive/syndicate/`, which carries a README with two explicit do-nots.

**3. ACP transport and the PacketCode engine surface landed** (`d4ffa233`,
`af4e4400`). `api-packetcode` is a ninth provider row driven over Agent Client
Protocol as a local subprocess (`src-tauri/src/acp/`), emitting the same
`api-agent:*` events as the in-process and sidecar transports.

**4. Local-model routing and the custom provider** — `api-custom`, a
user-supplied OpenAI-compatible endpoint (`2bcba130`, `llm_custom_compat.rs`);
tool-less Ollama models gated out of tool-carrying pickers; per-row model pins
and fail-closed local routing; the serving provider recorded on every
usage-ledger row. `3C-3` and the local-opt-in banner remain.

**5. PacketAgent handoff PH2–PH9** — contract probe, multi-source worker
packages, Rust-side SSE consumption with reconnect/dedupe/ack and a polling
fallback, approval round-trip, typed evidence with provenance-stamped landing,
and attention-queue integration. Source complete in both repos; PH10 live e2e
remains.

Also: version bumped `0.10.5` → `0.11.0` (`d34bf95f`), and code signing was
recorded as a deliberate cost deferral rather than an unstarted P1 (`b0f14891`).

## Verification status

The last commit that recorded its own gates is the rename, `5404fb85`
(2026-08-26):

| Gate                   | Result at `5404fb85`                                     |
| ---------------------- | -------------------------------------------------------- |
| `cargo check`          | clean                                                    |
| Rust lib tests         | 731 passed, 0 failed                                     |
| `tsc --noEmit`         | 0 errors                                                 |
| `pnpm lint`            | 0 errors                                                 |
| `vitest run`           | 3 pre-existing failures — `agentWorkspaceDecoupling`, `AcpMcpConsent`, `AgentSidebar.engineSessions` (WIP on main, not rename-caused) |

**One code commit has landed since without recorded gates:** `68ce85ee`, the
Syndicate removal, which deleted native commands, frontend surface, and two
dependencies. Re-run the gates before trusting the tree — that is the cheapest
first action of the next session.

Environment-dependent gates (packaged acceptance, real-host matrices, real
microphone, live PacketAgent e2e) have not run. They are tracked in
`backlog.md` under *Release and real-environment proof*.

## Next

1. **Re-run the local gates.** `pnpm rust:check`, `pnpm rust:test`,
   `npx tsc --noEmit`, `pnpm lint`, and a scoped `vitest run`. The Syndicate
   removal is unverified past its own review.
2. **Decide the GitHub repo rename.** The remote still points at `PacketADE`.
   GitHub's redirect makes this cosmetic today, but it will confuse anyone
   cloning. Renaming the repo also means re-pointing the remote and checking
   `dev/` links.
3. **Rename the build output directory.** `src-tauri/.cargo/config.toml` still
   redirects to `packetade-build`. It is local-only and git-excluded, so the
   rename commit could not reach it. Point it at a `packetbench-build` path and
   let the old tree go.
4. **Tag, or stop implying releases.** Three versions are recorded as shipped
   or in flight past the newest tag. Either tag `v0.10.4`/`v0.10.5` from their
   release sources or note in `CHANGELOG.md` that tagging stopped at `v0.10.3`.
5. **Package `0.11.0` for Windows and run the acceptance matrix.** No installer
   of the renamed product has ever been built. The rename touched the bundle
   identifier and the data/keyring/localStorage migration paths, so a packaged
   run is the only way to prove the one-shot migrators fire correctly on a real
   install — this is now the sharpest untested path in the tree.
6. **Close the PacketCode ACP fold-in leftovers** (backlog Owner decision 5):
   (a) wire or delete the cost statusline behind `packetbench:agents:show-cost`,
   which is implemented, tested, and unreachable; (b) retire the PTY-scraping
   adapter `src/agents/packetcode.ts` now the structured transport is at parity;
   (c) decide what "archive packetcode-gui" means.
7. **Run PacketAgent PH10 live e2e** — separately hosted close/relaunch/
   reconnect and evidence-return, the last open item on that handoff.
8. **Finish local-model routing:** `3C-3` and the local-opt-in banner.

## Cross-repo state

PacketBench sits in a family of sibling repos. **No session writes to another
repo's tree.**

- **PacketCode** (`D:\projects\packetcode`) — the sibling TUI that reclaimed the
  old product name. PacketBench drives it over ACP as the `api-packetcode` row.
  Engine-owned credentials; PacketBench never holds a key for it.
- **PacketAgent** — the worker contract is pinned by commit digest.
  `PACKET_AGENT_CONTRACT_COMMIT` in `src/types/packet-agent.ts:12` reads
  `cf910c170261d40e03fe82666c6d2363cf72a4b0`. Both halves are source complete;
  PH10 live e2e is the open gate.
- **PacketRelay** (`D:\projects\packetrelay`) — the standalone Rust relay that
  Remote Agents will extend. The program is paused (see below); the reference
  device-half implementation of the controller relay protocol is preserved in
  history at `d87fb125` (`syndicate_relay.rs`).
- **Syndicate** — separated from the family on 2026-08-27. No live integration,
  no coordination document, nothing owed in either direction. Do not send the
  archived `device.refresh` proposal; do not run the archived expiry runbooks.

## Context — decisions made, so they are not relitigated

- **No 1.0 milestone.** The 2026-08-05 review's Windows-only signed v1.0.0
  definition was **rejected** by the owner on 2026-08-16. PacketBench continues
  the 0.x cadence, now at 0.11.0.
- **Code signing is deferred on cost** (2026-08-27), not neglected. Nothing is
  spent on signing until the first build goes to someone who is not the owner.
  When that fires: Azure Trusted Signing at ~$10/month billed monthly, alone;
  skip the OV hedge; defer Apple's $99/year until macOS v1.1 actually starts.
  Unsigned local builds are fine meanwhile — SmartScreen's *More info → Run
  anyway* is one click per build.
- **The Tauri updater keypair was deliberately NOT generated.** The plugin is
  not installed and no `updater` block exists, so nothing would consume it, and
  an un-backed-up updater private key is a liability: lose it and every install
  signed with it can never be updated again. Generate it as step one of wiring
  the updater, and back it up twice immediately.
- **Global Undo is a time-boxed undo toast** (2026-08-16). Durable
  soft-delete/restore was declined. Confirmations remain the safety net until
  the toast is implemented; it is not yet scheduled.
- **Remote Agents is paused** (owner, 2026-08-16) with the E2EE gate ratified —
  encrypted agent, approval, and file payloads are a hard requirement before any
  external beta. Authentication is parked as the first pickup action; the
  runbook is `dev/remoteagents/10-pause-record.md`.
- **`api-claude-oauth` is a historical id, not an OAuth row.** It is the Claude
  Agent SDK on an Anthropic API key. The id is unchanged because persisted
  conversations store it and must resume verbatim. No API row uses a Claude.ai
  or ChatGPT subscription login; PTY CLI sessions are unaffected and keep theirs.
- **Retired provider ids go read-only, not remapped.** A conversation on
  `api-openai-codex` stays readable, cannot start a turn, and says so. The
  automation-only fallback in `RETIRED_API_AGENT_REPLACEMENTS` is never applied
  to a user's conversation.
- **The rename kept legacy identity constants rather than a migration script.**
  `LEGACY_*` in both brand modules points at the immediately-prior name, and the
  existing one-shot migrators do the work on next launch. The earlier
  `packetcode` migration has already run on existing installs.

## Gotchas

- **`CLAUDE.md` and `AGENTS.md` are gitignored** (`.gitignore:37-38`). Repo-wide
  sweeps — renames, API migrations, `git grep`-driven refactors — silently skip
  both, and nothing flags when they drift. The PacketADE → PacketBench rename
  missed them entirely and left instructions telling new code to use the old
  name. They were reconciled against source on 2026-08-27 and are now
  byte-identical except for the H1. Check them by name after any sweep.
- **Build output is redirected to the old product name.**
  `src-tauri/.cargo/config.toml` sets `target-dir` to
  `C:/Users/ianwalmsley/packetade-build`. The file is local-only and
  git-excluded (see `.git/info/exclude`), which is *why* the rename could not
  reach it. The redirect exists because the cross-machine-copied `target/` tree
  carries foreign-SID ACLs the current user cannot delete, and `tauri-build`
  must remove and recopy the bundled node on every build.
- **`node_modules` is in a mixed state.** The linked rollup binary is
  `@rollup/rollup-linux-x64-gnu` while `node_modules/.bin` carries Windows
  `.CMD` shims. Re-run `pnpm install` on the platform you intend to build from
  before a Tauri build. `pnpm tauri build` additionally runs
  `scripts/prune-sidecar.js`, a destructive hoisted prod-only reinstall — re-run
  `pnpm sidecar:install` afterwards to restore devDeps.
- **`pnpm rust:check` fails under WSL.** The GTK/webkit dev packages Tauri needs
  are absent and `pkg-config` is missing. Use the Windows toolchain, which is
  what actually builds this app:
  `cargo.exe check --manifest-path 'D:\projects\PacketBench\src-tauri\Cargo.toml'`.
  Rust is not on PATH for non-interactive shells; export
  `PATH="/c/Users/ianwalmsley/.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin:$PATH"`.
- **The PacketAgent contract fixture is pinned by digest — do not edit or
  rename-sweep.** `src/lib/__tests__/fixtures/packetagent-worker-package-v1.json`
  is owned by the PacketAgent repo and pinned across both by
  `PACKET_AGENT_CONTRACT_COMMIT`. Its value is the byte-identity, not the
  accuracy of the strings inside; the rename commit excluded it deliberately.
  (The two Syndicate controller-protocol fixtures that carried the same warning
  were deleted with the integration — `src-tauri/tests/fixtures/` no longer
  exists.)
- **Test-fixture paths still say `PacketADE` on purpose.**
  `src-tauri/src/core/storage.rs:1591` and
  `src/lib/__tests__/apiAgentWorkspace.test.ts:21` use `D:/projects/PacketADE`
  as an arbitrary project-path string. They are not references to the working
  directory and do not need updating.
- **Vitest worker startup times out intermittently on DrvFs** (WSL over
  `/mnt/d`). A full `vitest run` collapses with `Failed to start threads worker`
  on most files while the same files pass in small sets. Prefer `--pool=threads`
  and a handful of files at a time. `Timeout waiting for worker to respond` is
  environmental, not a test failure. Native Windows git-bash on `D:` does not
  show this.
- **`git status` is unreliable from WSL in this clone.** On `/mnt/d` (DrvFs)
  hundreds of files show as modified on line endings alone. Use
  `git diff --ignore-cr-at-eol --numstat`. Native Windows git-bash reports the
  tree correctly.
- **`handoff.md` and `HANDOFF.md` are the same file.** The filesystem is
  case-insensitive; Git tracks it as `HANDOFF.md`.
