# Multi-Platform Build Guide

PacketADE is developed day-to-day on Windows x64, but the app is designed to
ship on macOS and Linux as well. This doc tells a future macOS or Linux
developer everything they need to produce a working local bundle on their
platform. If you are adding a new target triple, extend this doc.

## Supported target triples

| OS          | Triple                      | Bundle formats          |
| ----------- | --------------------------- | ----------------------- |
| Windows x64 | `x86_64-pc-windows-msvc`    | `.exe` + NSIS + MSI installers |
| macOS x64   | `x86_64-apple-darwin`       | `.app` + DMG            |
| macOS ARM64 | `aarch64-apple-darwin`      | `.app` + DMG            |
| Linux x64   | `x86_64-unknown-linux-gnu`  | AppImage + DEB          |
| Linux ARM64 | `aarch64-unknown-linux-gnu` | AppImage + DEB (cross)  |

Add a target with `rustup target add <triple>` before building.

## Per-platform prerequisites

### macOS

- Xcode Command Line Tools: `xcode-select --install`
- Rust stable: `rustup toolchain install stable`
- Node 24.15 and pnpm (`corepack enable` is enough on recent Node)
- **Codesigning** is optional for local dev; required for distribution. An
  Apple Developer ID is needed to sign and later notarize the DMG — see
  "Not covered here" below.

### Linux (Debian / Ubuntu)

```bash
sudo apt-get update
sudo apt-get install -y \
  libgtk-3-dev \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  build-essential \
  curl wget file
```

Ubuntu 20.04 and older ship the older `libwebkit2gtk-4.0-dev` instead of 4.1.
PacketADE targets 4.1 by default; on 20.04 you will need to either upgrade
the distro or patch `src-tauri/Cargo.toml` to pin an older `tauri` that still
allows 4.0.

### Linux (Fedora / RHEL)

```bash
sudo dnf install -y \
  webkit2gtk4.1-devel \
  openssl-devel \
  curl wget \
  libappindicator-gtk3-devel \
  librsvg2-devel
```

### Windows

MSVC Build Tools (the "Desktop development with C++" workload) plus Rust
stable; this is the current developer box and is documented in the top-level
`README.md`.

## Build flow (same on every platform)

```bash
pnpm install        # postinstall runs the sidecar install too
pnpm sidecar:build  # compile agent-sidecar/dist
pnpm fetch-node     # download host-matching Node into src-tauri/binaries/
pnpm tauri build    # prebundle chain + Tauri bundler
pnpm run release:readiness
```

`pnpm tauri build` invokes the `prebundle` script via Tauri's
`beforeBuildCommand`, so in most cases just running `pnpm install` followed
by `pnpm tauri build` is enough. The explicit commands above make the order
visible when debugging.

`pnpm run release:readiness` is the beta distribution gate. It confirms the
package and Tauri versions match, bundle artifacts exist for the current host
target, release quality-gate scripts are present, and signing / updater
signals are visible. It does not require certificates to be present on
ordinary developer machines and does not print secret values.

Set `PACKETADE_RELEASE_TARGET=windows`, `macos`, or `linux` when checking
artifacts for a target other than the current host.

For cross-compiling (e.g. producing an ARM64 Linux bundle on an x64 host),
set `TAURI_TARGET` so `scripts/fetch-node.js` pulls the right runtime:

```bash
rustup target add aarch64-unknown-linux-gnu
TAURI_TARGET=aarch64-unknown-linux-gnu pnpm fetch-node
pnpm tauri build --target aarch64-unknown-linux-gnu
```

`pnpm fetch-node:all` downloads every supported Node binary at once —
useful for populating a release matrix cache. `pnpm fetch-node` alone picks
the host's target; use `--target=<triple>` or the `TAURI_TARGET` env
var to select one explicitly.

## Target-specific considerations

### macOS

- Unsigned local builds get a Gatekeeper warning the first time the `.app`
  is launched. The workaround for testing is:

  ```bash
  xattr -cr /Applications/PacketADE.app
  ```

  This removes the quarantine xattr. **Do not ship this workaround to end
  users** — distribute a signed + notarized DMG instead.

- DMG signing needs an Apple Developer ID. See the "Not covered here"
  section at the bottom.

### Linux

- AppImage is the portable option (one file, runs anywhere with a reasonable
  glibc). DEB is the native option and is the right default for
  Debian/Ubuntu derivatives.
- Distros without `libwebkit2gtk-4.1-0` at runtime (Ubuntu 20.04 and older)
  will reject the binary; users on those versions should upgrade or use the
  AppImage from a newer build box.

### Cross-compilation

- Rust targets must be added explicitly: `rustup target add <triple>`.
- Tauri's bundler picks up the right `externalBin` per target using the
  triple-suffixed filename (e.g. `node-aarch64-apple-darwin`). The Node
  fetcher reads `TAURI_TARGET` and downloads the matching Node binary.
- Cross-compiling **Windows from macOS/Linux** or **macOS from anywhere
  else** is not supported by this setup. Use a native runner for that OS.

## Installer sizes (for reference)

| Bundle         | Expected size |
| -------------- | ------------- |
| Windows NSIS   | ~78 MiB       |
| macOS DMG      | ~80–90 MiB    |
| Linux DEB      | ~80–100 MiB   |
| Linux AppImage | ~80–100 MiB   |

Wildly different numbers usually mean the sidecar `node_modules` was not
pruned — `pnpm sidecar:prune` runs automatically in the `prebundle` chain.

## Known non-issues / gotchas

- **Node binary permissions** — on Unix, `scripts/fetch-node.js` `chmod +x`'s
  the downloaded binary. You do not need to do this yourself.
- **Symlink-free sidecar `node_modules`** — pnpm's default symlinked store
  does not bundle cleanly. The sidecar is installed with a hoisted / pruned
  layout (v2 Tier 1 fix). No action needed.
- **`PACKETADE_SIDECAR_PATH` / `PACKETADE_NODE_PATH`** — at runtime these
  override the bundled locations, useful when running a packaged build
  against a working-copy sidecar.
- **Release readiness warnings** — warnings from `pnpm run release:readiness`
  are expected until signing identities, notarization credentials, and updater
  manifests are configured for the release machine. Failures should block a
  beta handoff.

## Not covered here

These are deliberate out-of-scope items. Each is its own task if / when we
pursue it:

- Code signing setup (macOS Developer ID, Windows Authenticode)
- macOS notarization (`notarytool`)
- Snap and Flatpak packaging for Linux
- Cross-compiling Windows from macOS or Linux
- Auto-update channel signing (covered separately in
  [`dev/updater-setup.md`](./updater-setup.md))
