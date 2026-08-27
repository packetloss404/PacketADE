# PacketBench v0.10.3 Release Record

Release date: 2026-08-02

This is the immutable source/package record for v0.10.3. Later documentation
commits do not change the binaries described here.

## Source identity

- Functional source commit:
  `61e06691c0679c7f7f6f0e313af61fbedbf872fa`
- Commit subject: `fix: self-bootstrap Claude statusline`
- Annotated tag: `v0.10.3`
- Local and remote tag dereference: `61e0669`
- Branch at package time: pushed `main`
- Sidecar protocol: `v11`

## Shipped changes

- Selectable raw local Terminal shells with app/Workspace/pane precedence and
  exact Auto compatibility.
- Detection, WSL distribution discovery, bounded command probes, install help,
  and custom-shell allowlisting.
- Effective shell identity in raw Terminal pane headers.
- PacketBench-owned Claude Code status collector injected through a session-
  scoped `--settings` file; global Claude settings remain untouched.
- Visible `Collecting session status...` state before the first Claude model,
  context, cost, and duration snapshot.

## Verification

| Gate                         | Result                                     |
| ---------------------------- | ------------------------------------------ |
| `pnpm preflight`             | PASS                                       |
| Vitest                       | 1,875 / 1,875 across 229 files             |
| ESLint                       | 0 errors; 9 existing Fast Refresh warnings |
| Production frontend build    | PASS                                       |
| Rust tests                   | 606 passed / 0 failed / 2 ignored          |
| Explicit Tauri schema export | 1 / 1                                      |
| Sidecar deterministic checks | PASS                                       |
| `pnpm release:gate`          | 11 / 11                                    |
| Release readiness report     | 0 failures / 6 warnings                    |

Additional focused proof:

- Rust collector normalization tests: 3 passed
- React Claude status-bar tests: 2 passed
- Debug helper invocation: PASS
- Release-mode helper invocation through Windows PowerShell: PASS
- Release-mode helper invocation through Git Bash: PASS
- Native Settings detection and Auto probe: PASS
- Direct PowerShell 7, Windows PowerShell, Command Prompt, Git Bash, and WSL
  command probes: PASS

The remaining shell gate is interactive packaged pane/persistence/
unavailable-profile/CLI/SSH proof. An existing Claude pane launched by an older
binary must be restarted because collector injection occurs at session launch.

## Windows artifacts

All artifacts were produced by `pnpm tauri build` from `61e0669`. The production
prebundle pruned sidecar development dependencies; `pnpm sidecar:install` was
run afterward to restore them.

| Artifact                         |       Bytes |       Size | SHA-256                                                            |
| -------------------------------- | ----------: | ---------: | ------------------------------------------------------------------ |
| `packetbench.exe`                  |  45,935,616 |  43.81 MiB | `B09463BA9F59D4AA4B1E6C807303C77FFE7F53F95F3F233F167A4ABCB92A04FB` |
| `PacketBench_0.10.3_x64-setup.exe` |  88,796,209 |  84.68 MiB | `6A2AA8F94721B55A098E1CC74782E4D60C67C2C7E8285FD5AF19DDFE3492D2DD` |
| `PacketBench_0.10.3_x64_en-US.msi` | 138,613,880 | 132.19 MiB | `A9631E279F15017D9DF11B379E94E9E5792CACBAC674AB3A0329F3EF5B7E4460` |

Local paths:

- `C:\Users\ianwalmsley\packetbench-build\release\packetbench.exe`
- `C:\Users\ianwalmsley\packetbench-build\release\bundle\nsis\PacketBench_0.10.3_x64-setup.exe`
- `C:\Users\ianwalmsley\packetbench-build\release\bundle\msi\PacketBench_0.10.3_x64_en-US.msi`

## Distribution status

The artifacts are unsigned. The six readiness warnings are distribution
prerequisites rather than build failures: Windows signing, macOS signing and
notarization, updater signing, updater configuration, and hosted `latest.json`.
No installer-install or complete interactive package acceptance claim is made
by this record.
