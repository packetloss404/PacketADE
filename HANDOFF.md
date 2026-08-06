# PacketADE Handoff

Last reconciled: 2026-08-03

This is the restart document. It records the exact shipped baseline, the next
decisions, the remaining proof gates, and the guardrails that must survive.
Historical implementation narratives live in `CHANGELOG.md`, the State report,
and Git rather than being duplicated here.

## Restart state

- Branch: `main`, synchronized with `origin/main` at the end of the v0.10.3
  release/documentation pass.
- Functional release source: `61e06691c0679c7f7f6f0e313af61fbedbf872fa`.
- Annotated tag: `v0.10.3`, locally and remotely dereferencing to `61e0669`.
- Evidence-only documentation commit after the package:
  `e7eb01dab15edee1076bde2c6ee667fea94fde12`.
- Current application version: `0.10.3`; sidecar protocol: `v11`.
- Worktree was clean before this documentation-consolidation pass.

The documentation-consolidation commit that follows is intentionally not a new
application release. The v0.10.3 tag remains on the exact functional source
used to build the artifacts.

## What v0.10.3 contains

- Selectable raw local Terminal shells with app, Workspace, and pane precedence;
  Auto preserves the historical Windows PowerShell/POSIX Bash behavior.
- Detected PowerShell 7, Windows PowerShell, Command Prompt, Git Bash, and WSL
  profiles with bounded tests and install/recovery guidance.
- Raw Terminal headers identify the effective shell, including Auto resolution
  and selected WSL distribution.
- Claude Code panes self-bootstrap PacketADE's native model/context/cost status
  bar through a session-scoped `--settings` collector. No global
  `~/.claude/settings.json` edit or separately installed script is required.
- The 2026-08-01 correctness pass: terminal-pane confirmation, exact Anthropic
  edit correlation, acknowledgement-bound Agent Stop and Side Chat cancellation,
  Monitor failure visibility, canonical cancel-pending ownership, repository/
  Git-host authority guards, truthful Settings persistence, hidden unenforced
  controls, and OS-keyring SSH password lifecycle.

An existing Claude Code pane launched by an older executable will not gain the
session-scoped collector. Start v0.10.3 and create or restart the pane.

## Verified source and package evidence

- `pnpm preflight`: PASS
- Vitest: **1,875 / 1,875 across 229 files**
- ESLint: **0 errors**, 9 existing Fast Refresh warnings
- Production web build: PASS
- Rust: **606 passed / 0 failed / 2 ignored**
- Explicit Tauri schema export: **1 / 1**
- Sidecar deterministic checks: PASS
- Release gate: **11 / 11**
- Release readiness: **0 failures / 6 warnings**
- Claude statusline collector: Rust and React coverage plus debug/release command
  proof through Windows PowerShell and Git Bash
- Native Settings detection/Auto probe and direct commands for all five Windows
  shell profiles: PASS

Known non-failing warnings remain: unsigned/notarization/updater prerequisites,
`ts-rs` serde-alias warnings, Vite chunk/dynamic-import warnings, and stale
Browserslist data.

## Windows artifacts

Built 2026-08-02 from tagged release source `61e0669`. Sidecar development
dependencies were restored after the production prune.

| Artifact                         |       Size | SHA-256                                                            |
| -------------------------------- | ---------: | ------------------------------------------------------------------ |
| `packetade.exe`                  |  43.81 MiB | `B09463BA9F59D4AA4B1E6C807303C77FFE7F53F95F3F233F167A4ABCB92A04FB` |
| `PacketADE_0.10.3_x64-setup.exe` |  84.68 MiB | `6A2AA8F94721B55A098E1CC74782E4D60C67C2C7E8285FD5AF19DDFE3492D2DD` |
| `PacketADE_0.10.3_x64_en-US.msi` | 132.19 MiB | `A9631E279F15017D9DF11B379E94E9E5792CACBAC674AB3A0329F3EF5B7E4460` |

Paths:

- `C:\Users\ianwalmsley\packetade-build\release\packetade.exe`
- `C:\Users\ianwalmsley\packetade-build\release\bundle\nsis\PacketADE_0.10.3_x64-setup.exe`
- `C:\Users\ianwalmsley\packetade-build\release\bundle\msi\PacketADE_0.10.3_x64_en-US.msi`

All three artifacts are unsigned. Exact immutable evidence is also in
[`dev/release-v0.10.3.md`](./dev/release-v0.10.3.md).

## 2026-08-05 Fable 5 deep review

A seven-team review of the whole repo ran on 2026-08-05:
[`docs/reports/fable5-review-2026-08-05.md`](./docs/reports/fable5-review-2026-08-05.md)
(human edition with screenshots: `.html` sibling). Twelve consolidated P1
findings are registered in `backlog.md` under "Fable 5 review findings"; the
review's Windows-only v1.0.0 definition and two-week plan are owner decision
4 in `backlog.md`. The public `docs/*.html` site was repaired to v0.10.3 truth
in the same pass.

macOS is no longer out of reach: it builds, bundles a DMG, and runs on real
hardware today. [`dev/macos-release-plan.md`](./dev/macos-release-plan.md) owns
signing, entitlements, and notarization end to end and targets a signed arm64
DMG for v1.1, with Apple Developer enrollment starting alongside the Windows
signing application.

## Decide before starting major work

1. **Remote Agents auth provider.** Product-grade OIDC/passkey service versus a
   carefully scoped in-house passkey/magic-link implementation. Dev-only auth
   may support internal smoke tests but is not a beta decision.
2. **Remote Agents E2EE timing.** Current recommendation: require encrypted
   agent/approval/file payloads before external beta; TLS-only is internal-only.
3. **Global Undo.** Durable soft-delete/restore with retention versus a
   time-boxed delayed-delete toast.

Remote Agents remains paused until decisions 1 and 2 are resolved. Extend the
standalone Rust relay at `D:\projects\packet-relay`; do not create a Cloudflare
or provider-specific second relay.

## Recommended next execution order

1. Run the v0.10.3 packaged Windows dogfood matrix, including real Terminal
   panes, Claude statusline, app close, Monitor, and multi-display behavior.
2. Run any immediately available GitHub/Gitea, OS-keyring, microphone, and
   pinned-SSH proof. Record evidence; do not invent source changes to replace a
   missing environment.
3. Decide Undo, then implement only the selected scope.
4. Close the bounded Settings/MS4 source work: stable identities, provider-aware
   validation, diagnostics, labels, ARIA, responsive overflow, and creation
   semantics.
5. Resolve Remote Agents auth and E2EE, then execute its Sprint-0 plan against
   the existing Rust relay.
6. Acquire signing credentials and wire hosted CI/updater distribution.

The complete item-level register is [`backlog.md`](./backlog.md).

## Product state that must not regress

- Workspaces are CLI/PacketCode-first. Agents is the first-class same-window
  GUI-agent surface. Do not reintroduce new Workspace conversation attachments;
  preserve saved-pane compatibility.
- `Open alongside Workspace` is retired.
- Flight Deck Option B is the live planning model: a normal read-only
  conversation, explicit plan application, and user-launched attempts. Do not
  restore autonomous Planner v1.
- PacketAgent and PacketCode are separate products/repositories. PacketADE owns
  their integration contracts, not their runtimes.
- Monitor v1 is read-only and backend capability-restricted. A Monitor must not
  mount or own a live PTY.
- Git-host tokens and SSH passwords remain in the OS keyring; repository,
  Workspace, and host identity changes must invalidate stale authority.
- Both in-process and sidecar API-agent transports emit the same
  `api-agent:*` event contract. Sidecar protocol v11 freezes per-session MCP
  trust authority.
- New branding values come from the Rust/TypeScript brand modules; do not add
  hardcoded product identity strings in source.

## External/package gates still open

- Authenticode, macOS signing/notarization, hosted CI, updater signing/config,
  and `latest.json`
- packaged local/SSH Flight supervision
- live PacketAgent W9 close/relaunch/reconnect
- PacketCode signed clean-machine release and compatibility
- packaged GitHub/Gitea and Issue-to-Flight mirroring
- Project Memory real-editor watch behavior
- MCP/provenance local/SSH/provider parity
- Dictation hardware and macOS/Linux matrices
- Monitor lifecycle/denial proof
- Workspace/Settings OS-keyring and pinned-SSH proof

## Canonical reading order

1. [`HANDOFF.md`](./HANDOFF.md)
2. [`backlog.md`](./backlog.md)
3. [`ROADMAP.md`](./ROADMAP.md)
4. [`docs/reports/state-of-the-ade-2026-07-30.md`](./docs/reports/state-of-the-ade-2026-07-30.md), Section 0
5. [`dev/README.md`](./dev/README.md)
6. A linked implementation plan or runbook only when working that item

Ignore `dev/archive/` as a task source. It is historical evidence.

## Suggested first prompt

> Read `HANDOFF.md`, `backlog.md`, and Section 0 of the State of the ADE. Confirm
> the worktree and current release evidence. Then run the v0.10.3 packaged
> Windows dogfood matrix and update only the canonical proof/backlog records.
