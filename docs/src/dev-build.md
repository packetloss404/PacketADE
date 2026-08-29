# Build & release

PacketBench builds three artifacts that have to agree with each other: a Rust
binary, a JavaScript bundle, and a Node sidecar with its own dependency tree and
its own pinned Node runtime. This page covers the dev loop, what
`pnpm tauri build` actually does, and the gates that stand between a build and a
release.

## Prerequisites

| Tool | Notes |
| --- | --- |
| Node.js | The dev toolchain. The *bundled* runtime is separately pinned to 24.15.0 (`scripts/node-runtime.js:57`) |
| pnpm 9.15.4 | Pinned via `packageManager` in `package.json` |
| Rust stable | Plus the target triple you are building for |

On Windows the Rust toolchain must be on `PATH` for Tauri builds:

```bash
export PATH="/c/Users/<you>/.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin:$PATH"
```

Per-platform system dependencies (CMake on macOS for `whisper-rs-sys`, GTK and
WebKit dev packages on Linux) are in `dev/multi-platform-build.md` in the
repository.

## The dev loop

```bash
pnpm install          # also runs postinstall -> sidecar install
pnpm tauri dev        # Vite on :1420 + cargo run, hot reload on the frontend
```

`pnpm install` has a `postinstall` hook that installs the sidecar's own
dependencies (`node scripts/run-pnpm-no-deprecation.mjs -C agent-sidecar install`),
so a fresh clone is one command.

For sidecar work, run `pnpm sidecar:dev` (`tsc --watch`) in a second terminal.
The supervisor loads `agent-sidecar/dist/index.js`, so an un-rebuilt sidecar
change simply does not take effect.

Fast individual checks:

```bash
pnpm build            # tsc && vite build
pnpm lint             # eslint src e2e
pnpm test             # vitest run
pnpm rust:check       # cd src-tauri && cargo check
pnpm rust:test        # cd src-tauri && cargo test
```

> **Tip:** `PACKETBENCH_SIDECAR_PATH` and `PACKETBENCH_NODE_PATH` redirect the
> supervisor at a sidecar build and Node binary of your choosing. In a *release*
> build they are ignored unless `PACKETBENCH_DEV_SIDECAR=1` is also set — and
> the refusal is logged, so a confused bug report is answerable.

## What `pnpm tauri build` actually runs

`beforeBuildCommand` in `src-tauri/tauri.conf.json:8` is
`pnpm run prebundle && pnpm run build`, and `prebundle` is a five-step chain
(`package.json:44`):

```
clean:dmg-scratch  →  fetch-node  →  sidecar:install  →  sidecar:build
                   →  sidecar:prune  →  release:gate
```

Then `pnpm run build` (`tsc && vite build`) produces `dist/`, and Tauri compiles
the Rust binary and bundles.

```
pnpm tauri build
├─ beforeBuildCommand
│  ├─ prebundle
│  │  ├─ clean:dmg-scratch   detach leaked macOS DMG scratch images (no-op elsewhere)
│  │  ├─ fetch-node          download + SHA-256 verify Node 24.15.0 → src-tauri/binaries/
│  │  ├─ sidecar:install     pnpm -C agent-sidecar install
│  │  ├─ sidecar:build       tsc → agent-sidecar/dist/
│  │  ├─ sidecar:prune       DESTRUCTIVE prod-only reinstall  ⚠
│  │  └─ release:gate        11 preconditions; exits 1 on any FAIL
│  └─ build                  tsc && vite build → dist/
└─ cargo build --release + bundle
   externalBin: binaries/node
   resources:   agent-sidecar/dist, agent-sidecar/package.json,
                agent-sidecar/node_modules, LICENSE, NOTICE
```

### The sidecar prune is destructive

> **Warning:** `scripts/prune-sidecar.js` runs
> `pnpm -C agent-sidecar install --prod --ignore-scripts`. After any production
> build, `agent-sidecar/node_modules` is **missing `typescript` and
> `@types/node`**, so `pnpm sidecar:build` will fail until you run
> `pnpm sidecar:install` again. This is documented in the script header at
> `scripts/prune-sidecar.js:17` and it catches everyone once.

The prune does more than strip devDependencies. It:

1. Refuses to proceed if `agent-sidecar/dist/` is absent — it will not silently
   re-run the build for you (exit 1).
2. Temporarily injects pnpm's `supportedArchitectures` into
   `agent-sidecar/package.json` so the **target** platform's native packages
   materialise, then restores the file byte-exact.
3. Prints a size and file-count summary so build logs show what is about to be
   bundled.
4. Asserts the target's `@anthropic-ai/claude-agent-sdk-<os>-<cpu>` platform
   package is present with a non-empty `claude` executable, **and** that no
   foreign-platform variant leaked in. Either failure exits 1 and aborts the
   whole Tauri build.

### Node runtime staging

`scripts/fetch-node.js` downloads a pinned Node into `src-tauri/binaries/` under
Tauri's `externalBin` triple-suffix convention. Five targets are supported
(`scripts/node-runtime.js:88`):

| Triple | Archive |
| --- | --- |
| `x86_64-pc-windows-msvc` | `node-v24.15.0-win-x64.zip` |
| `x86_64-apple-darwin` | `node-v24.15.0-darwin-x64.tar.gz` |
| `aarch64-apple-darwin` | `node-v24.15.0-darwin-arm64.tar.gz` |
| `x86_64-unknown-linux-gnu` | `node-v24.15.0-linux-x64.tar.gz` |
| `aarch64-unknown-linux-gnu` | `node-v24.15.0-linux-arm64.tar.gz` |

Target selection order: `--target=<triple>` / `--all-targets` →
`TAURI_ENV_TARGET_TRIPLE` (Tauri injects this) → `TAURI_TARGET` → host
detection.

> **Important:** Authenticity is checked against a **reviewed SHA-256 digest
> pinned in `scripts/node-runtime.js`**, not against the `SHASUMS256.txt` served
> alongside the download. The live shasums file is fetched only as an advisory
> cross-check and can never relax the pinned value. Bumping `NODE_VERSION`
> requires replacing all five digests in the same commit.

The fetch is idempotent: a sibling `.sha256` marker records nodeVersion, target,
pinned archive digest and the on-disk digest, and is re-validated against the
pin on every run, so a cache poisoned by one bad fetch does not survive.

> **Warning:** `resolveTarget` **throws** when `TAURI_TARGET` and
> `TAURI_ENV_TARGET_TRIPLE` disagree (`scripts/target-triple.test.mjs:137`). A
> stale export used to silently redirect `fetch-node`, `prune-sidecar` and
> `release-gate` all to the same wrong target, so they agreed with each other
> and the gate could not see the problem.

## The release gate

`scripts/release-gate.mjs` runs inside every `pnpm tauri build` via `prebundle`.
It collects PASS / FAIL / WARN rows and exits 1 if any row is FAIL.

Unconditional checks, in order:

| # | Check |
| --- | --- |
| 1 | Version alignment across `package.json`, `tauri.conf.json`, `Cargo.toml` |
| 2 | `bundle.active === true` |
| 3 | `beforeBuildCommand` includes both `prebundle` and `build` |
| 4 | `bundle.resources` includes `agent-sidecar/dist` and `agent-sidecar/node_modules` |
| 5 | `bundle.externalBin` includes `binaries/node` |
| 6 | `agent-sidecar/dist/index.js` exists |
| 7 | Build target resolves |
| 8 | Sidecar native platform package for the target exists and is non-empty |
| 9 | No **foreign** `claude-agent-sdk-*` directories alongside the target's |
| 10 | `verifyStagedNodeRuntime` — binary exists, `.sha256` marker exists, marker `nodeVersion` matches the pin, marker `target` matches the build triple, marker `archiveSha256` matches the pin, and the recomputed on-disk digest matches the marker |
| 11 | `dev/updater-setup.md` present (**WARN only**) |

Three more run behind flags — `--require-clean`, `--require-signing`,
`--require-updater`, or the `PACKETBENCH_RELEASE_REQUIRE_*=1` env equivalents.
`pnpm release:gate:strict` sets all three.

> **Warning:** `TAURI_SIGNING_PRIVATE_KEY` is the **updater minisign key**, not
> a code-signing certificate. Counting it once produced a false "Signing
> credentials present" PASS on a build with zero Authenticode configuration. It
> is excluded from the signing evidence, and
> `scripts/target-triple.test.mjs:235` regex-extracts the `authenticodeEnv` and
> `appleEnv` arrays to assert neither contains it. Do not "fix" that by adding
> it back.

Check 10 exists because the Node runtime is an `externalBin` signed along with
the installer: "the file exists" is not a useful gate, because *any* binary at
that path would ship.

## Release readiness

`pnpm release:readiness` (`scripts/release-readiness.mjs`) is the wider,
slower report — it executes the quality gates *and* inspects the distribution
surface. Five sections in order:

1. **Release metadata** — versions across all three manifests, `bundle.active`,
   `bundle.targets`
2. **Signing signals** — Windows Authenticode, macOS codesign, macOS
   notarization, updater env. All WARN, never FAIL
3. **Updater readiness** — config plus `latest.json` shape
4. **Bundle artifacts**
5. **Required quality gates** — the nine leaves, executed

The nine gates, in execution order: `format:check`, `lint:src`, `test`, `build`,
`e2e`, `sidecar:check`, `check:tauri-schema`, `rust:check`, `rust:test`. Each
runs as `pnpm run <name>` with a per-gate timeout of 45 minutes by default
(`PACKETBENCH_RELEASE_GATE_TIMEOUT_MS`).

`pnpm run check` is reported as **derived**, not re-executed, because it expands
to exactly those nine. The script re-parses `package.json` on each run and, if
the leaf set has drifted, emits a WARN telling you to update
`requiredQualityScripts` rather than claiming a pass it did not verify.

`--report-only` implies `--skip-gates` and suppresses the exit code. Skipped
gates render as `WARN … NOT EXECUTED` — never as a pass that was not earned.

> **Note:** Bundle-root resolution follows `CARGO_TARGET_DIR` →
> `[build] target-dir` in `src-tauri/.cargo/config.toml` → `cargo metadata` →
> default `src-tauri/target`, and the provenance is printed in the header. This
> repo redirects build output to a machine-local, git-ignored directory, so the
> default is usually wrong here. The script also handles WSL, translating
> drive-letter paths and hinting at `PACKETBENCH_RELEASE_TARGET=windows`.

## Platform notes

### macOS: use the wrapper

```bash
pnpm build:macos      # not `pnpm tauri build`
```

Tauri's DMG step runs a cosmetic Finder-arranging AppleScript that is flaky —
it fails on roughly half of first attempts and, when it does, abandons its
mounted read-write scratch image and aborts the whole build.
`scripts/build-macos.mjs` runs the build once, and on failure detaches the
leaked image and retries just the DMG bundling. Rust artifacts are cached, so
retries are cheap. On non-macOS it passes straight through to `tauri build`.

`scripts/clean-dmg-scratch.mjs` is the pre-build half, wired into `prebundle`:
it detaches any attached PacketBench scratch image and deletes leftover
`rw.*.dmg` files. No-op off macOS.

### Linux

Debian dependencies are declared in the bundle config
(`src-tauri/tauri.conf.json`): `libgtk-3-0`, `libwebkit2gtk-4.1-0`,
`libasound2`. Ubuntu 20.04 and older ship `libwebkit2gtk-4.0-dev` instead of
4.1; you will need to upgrade the distro or pin an older `tauri`.

Linux targets pass the signing gate trivially with "produces unsigned Linux
packages".

### Windows

Bundles as `.exe` + NSIS + MSI. Nothing is code signed today.

## The auto-updater is not enabled

There is no `tauri-plugin-updater` dependency in `src-tauri/Cargo.toml`, no
`tauri_plugin_updater::init()` in `src-tauri/src/lib.rs`, and no `updater` block
in `src-tauri/tauri.conf.json`. Users install new versions manually.

`dev/updater-setup.md` in the repository is a runbook for enabling it with a
**full-installer** strategy. Diff-patch
updates are deliberately out of scope because of the bundled sidecar and the
`externalBin` Node runtime. Enabling it needs a signing keypair and an HTTPS
update server, both intentionally deferred, so it is an ops task rather than a
code change.

## Cutting a release

There is no CI. Every gate is local — see
[Testing & gates](dev-testing.html).

1. Bump the version in **all three** manifests: `package.json`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`. Release gate check 1
   fails otherwise.
2. `pnpm check` — the full ladder.
3. `pnpm tauri build` (or `pnpm build:macos`).
4. `pnpm sidecar:install` to restore the devDependencies the prune removed.
5. Record the artifacts in `CHANGELOG.md`: filename, size, SHA-256, the commit
   they were built from, and the gate counts at that commit. Existing entries
   are the template.
6. Note honestly what has *not* been verified. The 0.12.1 entry is the model
   here: it states plainly that the artifacts were built, not accepted, and that
   no installed upgrade of any PacketBench package has ever been performed.

> **Note:** `CHANGELOG.md` is shipped history only. Outstanding work goes in
> `backlog.md`; direction goes in `ROADMAP.md`. Do not use the changelog as a
> task list.

## Where builds actually go

The repo redirects Cargo output via `src-tauri/.cargo/config.toml`, so bundles
do not land in `src-tauri/target/` here. The 0.12.1 artifacts were written to a
machine-local directory outside the repository, which is why they are recorded
in the changelog by hash rather than committed.

## Related

- [Testing & gates](dev-testing.html) — what `pnpm check` runs and why
- [Agent event contract](dev-agent-contract.html) — the sidecar the bundle carries
- [Install & first run](install.html) — the user-facing side of all this
