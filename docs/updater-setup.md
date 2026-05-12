# PacketADE Auto-Updater Setup

## Overview

PacketADE **does not auto-update today**. There is no `tauri-plugin-updater`
dependency in `src-tauri/Cargo.toml`, no `tauri_plugin_updater::init()` call
in `src-tauri/src/lib.rs`, and no `"updater"` / `"plugins.updater"` block in
`src-tauri/tauri.conf.json`. Users must install new versions manually by
downloading a fresh NSIS installer.

This document describes how to enable Tauri v2's updater for a
**full-installer** strategy that is compatible with the bundled Node sidecar
(`agent-sidecar/`) and the pinned Node 24.15.0 runtime shipped as a Tauri
`externalBin`. Diff-patch updates are deliberately **out of scope** — see
[Recommended strategy](#recommended-strategy-for-the-bundled-sidecar) below.

Enabling the updater is a **deployment / ops task**, not a feature. It
requires a signing keypair and an HTTPS update server (both intentionally
deferred), so this guide is a runbook, not a code change.

## Prerequisites

- **Tauri updater signing keypair**, generated via
  `pnpm tauri signer generate -w ~/.tauri/packetade.key`. The private key
  (`packetade.key`) stays offline; the public key (`packetade.key.pub`) is
  committed to the app config.
- **HTTPS-reachable location** to host signed manifests + installer
  downloads. GitHub Releases is fine and is the path of least resistance —
  the `{{target}}` / `{{current_version}}` template variables resolve
  against release asset URLs.
- **Tauri dev deps already installed** (`pnpm install` at repo root;
  `tauri-cli` is pulled in transitively).

## Step-by-step setup

### 1. Generate the keypair

```bash
pnpm tauri signer generate -w ~/.tauri/packetade.key
```

You will be prompted for a password. Store it in a password manager; the
release machine will need it later via `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Commit the **public** key to `src-tauri/tauri.conf.json`:

```json
{
  "plugins": {
    "updater": {
      "active": true,
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFCQ0QuLi4=",
      "endpoints": [
        "https://github.com/packetloss404/PacketADE/releases/latest/download/latest.json"
      ]
    }
  }
}
```

Do **not** commit the private key. Add `*.key` to `.gitignore` if it is not
already covered.

### 2. Add the plugin crate

In `src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri-plugin-updater = "2"
```

### 3. Initialize the plugin

In `src-tauri/src/lib.rs`, inside the Tauri builder chain:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::new().build())
    // ... existing plugins and handlers
```

### 4. Configure update endpoints

Tauri substitutes `{{target}}` (e.g. `windows-x86_64`) and
`{{current_version}}` into endpoint URLs at check time. For a simple
single-manifest setup pointed at GitHub Releases:

```json
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/packetloss404/PacketADE/releases/latest/download/latest.json"
      ],
      "pubkey": "<public key from step 1>",
      "windows": {
        "installMode": "passive"
      }
    }
  }
}
```

`installMode: "passive"` shows the NSIS progress UI without forcing user
interaction. Never use `"quiet"` for a dev tool — see
[What to watch for](#what-to-watch-for).

The `latest.json` manifest is a small signed descriptor of the form:

```json
{
  "version": "0.3.0",
  "notes": "Release notes here",
  "pub_date": "2026-05-01T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<sig from PacketADE_0.3.0_x64-setup.exe.sig>",
      "url": "https://github.com/.../PacketADE_0.3.0_x64-setup.exe"
    }
  }
}
```

Generate `latest.json` as part of the release process and upload it alongside
the signed installer artifacts.

### 5. Build signed releases

For the release build, point Tauri at the private key via environment
variables:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/packetade.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<password from step 1>"
pnpm tauri build
```

The bundler emits `PacketADE_<version>_x64-setup.exe` plus a matching
`.exe.sig` in `src-tauri/target/release/bundle/nsis/`. Upload **both**
files to the GitHub Release alongside `latest.json`.

If you want to keep updater config out of dev builds, split it into
`tauri.conf.updater.json` and pass `--config ./tauri.conf.updater.json` at
release build time.

### 6. Keep the private key offline

- Never commit `packetade.key`.
- Dev machines do not need it — only the release machine does.
- On the release machine, provide the private key + password as environment
  variables (`TAURI_SIGNING_PRIVATE_KEY`,
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) for the build step.

## Recommended strategy for the bundled sidecar

**Use full-installer updates only. Do NOT enable diff patches.**

The Tauri NSIS updater can deliver either:

1. A complete signed `*-setup.exe` installer (run, reinstall, relaunch).
2. A signed `.nsis.zip` patch layered over the existing install.

Diff patching has known friction with `externalBin` + `resources` across
versions. The bundled payload is:

- `binaries/node.exe` — pinned Node 24.15.0, ~66 MB.
- `agent-sidecar/node_modules/` — pruned production deps, ~256 MB
  uncompressed, thousands of small files.
- `agent-sidecar/dist/` — compiled sidecar, tiny but shifts every release.

Patch computation over that much churn is fragile. The compressed NSIS
installer is ~78 MB, which is well within acceptable download size for a
desktop dev tool. Always ship full installers.

On a major Node version bump (e.g. 20.x → 22.x), cut a normal release. The
supervisor's existing sidecar handshake (`ready` event's
`protocolVersion`) will surface any incompatibility immediately after the
user launches the updated build.

## What to watch for

- **User data preservation.** NSIS's default uninstaller preserves user
  data at `~/.packetade/` between upgrades. **Verify this explicitly**
  before enabling the updater in production — losing GitHub auth state,
  memory store, or flight history across updates would be a regression.
  Test by installing version N, creating a flight, updating to N+1, and
  confirming the flight survives.
- **Prompt before applying.** Tauri's updater surfaces a UI prompt by
  default. Keep it that way. A dev tool should not silently restart
  mid-session.
- **Signing secrets.** The private key is provided through
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` on the
  release machine. Rotate on key compromise — existing installs will stop
  accepting updates signed with a new key unless you ship a migration release
  first.
- **Endpoint availability.** Failed update checks should be silent in the
  UI (a toast at most). Never block app startup on the updater's HTTP
  request.

## Frontend integration

Once the plugin is wired, surface update availability in the UI. Minimal
example (from the `@tauri-apps/plugin-updater` JS bindings):

```ts
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export async function checkForUpdate() {
  const update = await check();
  if (!update?.available) return null;
  return {
    version: update.version,
    notes: update.body,
    install: async () => {
      await update.downloadAndInstall();
      await relaunch();
    },
  };
}
```

Wire this into `StatusBar` or the `TitleBar` "About" affordance — a small
dot + "Update available" label is the usual pattern. See the
[Tauri updater docs](https://v2.tauri.app/plugin/updater/) for the full
API (download progress events, `shouldUpdate`, custom manifest shapes).

## Not implemented here

This slice is **documentation only**. No changes to `tauri.conf.json`,
`src-tauri/Cargo.toml`, or `src-tauri/src/lib.rs`. Enabling the updater
requires:

- A signing keypair (prerequisite, deferred).
- A hosted `latest.json` manifest + release pipeline (ops work, deferred).
- A UI surface for the update prompt (small frontend change, deferred).

Until those land, PacketADE remains a manual-install app.
