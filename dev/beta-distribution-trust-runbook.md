# Beta Distribution Trust Runbook

Last updated: 2026-05-28

This is the current trust checklist for public beta builds. The goal is to keep
release friction boring: versions line up, sidecar assets are embedded, updater
readiness is explicit, and signed/notarized release candidates fail fast when
required credentials are missing.

## Local Release Gate

Run the lightweight gate before any installer build:

```bash
pnpm run release:gate
```

It checks:

- `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`
  share the same version.
- Tauri bundling is enabled.
- the build pipeline runs `prebundle` and the frontend build.
- the bundled Node runtime and `agent-sidecar` resources are configured.
- `agent-sidecar/dist/index.js` and the Windows Node runtime exist.
- the updater runbook is present.

For release-candidate packaging, use the strict mode:

```bash
pnpm run release:gate:strict
```

Strict mode additionally requires a clean git tree, at least one signing
credential hint, and updater signing configuration. The strict gate is expected
to fail on ordinary dev machines until certificate and updater secrets are
available.

## Trust Gates

| Gate                           | Status                                                      | Owner notes                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows executable build       | Active                                                      | `pnpm tauri build` produces NSIS and MSI installers.                                                                                                                  |
| Sidecar + Node embedding       | Active                                                      | `prebundle` fetches Node, builds sidecar, prunes production deps.                                                                                                     |
| Version drift check            | Active                                                      | `pnpm run release:gate`.                                                                                                                                              |
| Signing credential check       | Active gate, credentials pending                            | strict mode fails unless signing env is present.                                                                                                                      |
| Updater signing check          | Active gate, updater deferred                               | strict mode fails until updater config and signing key are wired.                                                                                                     |
| Windows SmartScreen reputation | Pending real certificate                                    | requires signed releases and reputation over time.                                                                                                                    |
| macOS codesign/notarization    | Pending Apple credentials; owned by `macos-release-plan.md` | Enrollment is the day-0 long pole. Entitlements, hardened runtime, `notarytool`, and stapling are specified in [`macos-release-plan.md`](./macos-release-plan.md) §4. |

## Release Candidate Flow

1. Update versions in all three manifests.
2. Run `pnpm run release:gate`.
3. Run the normal local verification suite for the release branch.
4. Run `pnpm tauri build`.
5. On the release machine, run `pnpm run release:gate:strict`.
6. Sign/notarize installers and upload artifacts.
7. If updater is enabled for that release, generate and sign `latest.json`.

## Credential Hints

The strict gate recognizes these environment variables:

- Windows: `WINDOWS_SIGNTOOL_CERT_SHA1`, `WINDOWS_SIGNING_CERT_PATH`
- Tauri updater: `TAURI_SIGNING_PRIVATE_KEY`,
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- macOS: `APPLE_SIGNING_IDENTITY`, `APPLE_CERTIFICATE`, `APPLE_API_KEY`,
  `APPLE_API_KEY_PATH`

Do not commit private keys or certificate material. Keep release credentials in
the release machine, CI secret store, or platform keychain.
