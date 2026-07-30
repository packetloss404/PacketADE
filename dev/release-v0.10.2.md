# PacketADE v0.10.2 Release Record

Release date: 2026-07-28

Platform built: Windows x64

Signing: unsigned local beta build

## Source and version

- Application, Tauri, and Rust package version: `0.10.2`
- Source tag: `v0.10.2`
- Release contents: Flight supervision/bounded-autonomy baseline, PacketCode
  integration, GitHub/Gitea/SSH/Memory work already accumulated under
  Unreleased, the repaired Dictation pipeline, refreshed product decisions, and
  the paused pre-Remote-Agents loop queue.

## Verification

- `pnpm run preflight`
  - Prettier check passed.
  - ESLint passed with zero errors and nine known Fast Refresh warnings.
  - Vitest: 148 files, 1,174 tests passed.
  - TypeScript/Vite production build passed.
- `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- `cargo test --manifest-path src-tauri/Cargo.toml commands::dictation --no-run`
  compiled both native test executables.
- `pnpm tauri build` passed, including pinned Node fetch verification, sidecar
  install/build/prune, frontend build, optimized Rust build, MSI, and NSIS.
- `pnpm sidecar:install` restored development dependencies after bundling.

Known non-failing output remains the repository's `ts-rs` serde-alias warning,
one unrelated `tool_web.rs` parentheses warning, the nine React Fast Refresh
warnings, and existing Vite chunk/dynamic-import notices.

## Local artifacts

| Artifact | Size | SHA-256 |
|---|---:|---|
| `packetade.exe` | 41.31 MiB | `AB36B18E9085B8B81CB4F09ABD7514B0AB0E84023DF1FD45CF4477E51464D106` |
| `PacketADE_0.10.2_x64_en-US.msi` | 131.47 MiB | `E71575AD9236FA43787332FC5D34839052D048202A99E1AA705A0FA6FBAC73EF` |
| `PacketADE_0.10.2_x64-setup.exe` | 84.16 MiB | `89212D33A21EFD67F50FFA4B5FFADFED72C5AF83FFA63D67E82FEEF8C4F5061E` |

The standalone executable and NSIS executable both report product version
`0.10.2`. These artifacts are local build evidence; they are not signed,
uploaded, or claimed as trusted public distribution.

## Post-tag local development rebuild — 2026-07-30

After the Workspace/Agents completion and six-group Settings implementation,
`pnpm tauri build` succeeded again from functional commit `a7feb4a`. This build
still reports `0.10.2`; it is a post-tag development build, not a replacement
tag or a newly published release.

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `packetade.exe` | 42.65 MiB | `23E954FDF0C10A1CA2E5CF2198334CB6D268B1925EA155F83EC1C8FCC91FBA1A` |
| `PacketADE_0.10.2_x64_en-US.msi` | 131.90 MiB | `AB307CFE7BD1FE0149C97FC047F08CB21A61AFBA9611444B98FE84F0C7E30E5D` |
| `PacketADE_0.10.2_x64-setup.exe` | 84.47 MiB | `E4A1119396EF6E7E9BF4511F8BAFC3E2B076FF37011C8C36101870B959A2BDD6` |

The optimized Rust release compile, MSI, and NSIS packaging passed. Sidecar
development dependencies were restored afterward. The artifacts remain
unsigned and local-only.
