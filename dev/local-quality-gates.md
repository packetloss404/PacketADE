# Local Quality Gates

PacketADE intentionally has no GitHub CI workflows. Release confidence is built from local checks run before merging or shipping.

## Quality Ladder

1. **Preflight: fast local check**
   - Use the preflight command when you want a quick signal before handing work off.
   - Run `pnpm preflight`.
   - It stays focused on common regressions: format check, bounded lint, Vitest, and frontend build.

2. **Check: full local release confidence**
   - Use the full check command before release-oriented work or larger changes.
   - Run `pnpm check`.
   - It covers the complete local quality surface: preflight, Playwright, sidecar checks and smoke tests, schema validation, Rust check, and Rust tests.

3. **Release readiness: beta distribution gate**
   - Use the readiness check after `pnpm check` and after producing local Tauri bundles.
   - Run `pnpm run release:readiness`.
   - It reports release metadata, signing signals, updater manifest readiness, bundle artifact presence, and the required quality commands for the release handoff.
   - Run `pnpm run release:readiness:report` when you only need a non-failing status snapshot during setup.

## Individual Gates

- **Lint scripts**
  - Run `pnpm lint` or `pnpm lint:src` for TypeScript, React, and shared frontend rules over `src/` and `e2e/`.
  - Run `pnpm lint:strict` when you want warnings to fail the command.

- **Format check**
  - Run `pnpm format:check` before submitting changes.
  - It checks the repo surfaces that currently have a stable Prettier baseline: package/config files, this quality-gates doc, and Playwright specs.
  - Keep broader source formatting fixes separate from unrelated edits when possible so reviews stay readable.

- **Vitest**
  - Run `pnpm test` for frontend unit and store-level coverage.
  - Prefer targeted Vitest runs while iterating, then include the full local test run for broader confidence.

- **Playwright**
  - Playwright coverage is local web-mode only.
  - Run `pnpm e2e` for browser smoke and interaction checks.
  - Use it for browser-facing frontend behavior that can run under the Vite web app. It does not exercise the native Tauri shell or desktop-only APIs directly.

- **Rust check and test**
  - Run `pnpm rust:check` for fast Rust compile confidence.
  - Run `pnpm rust:test` for Rust tests.
  - Run Rust tests locally when backend command, provider, state, or orchestration behavior changes.

- **Sidecar smoke scripts**
  - Run `pnpm sidecar:check` after changes to `agent-sidecar/`, provider routing, protocol types, or supervisor integration.
  - These scripts validate the Node sidecar protocol and basic provider registry behavior without requiring the full desktop app.

- **Schema check**
  - Run `pnpm check:tauri-schema` after changing shared contracts, generated types, persisted state shapes, or request/response payloads.
  - Schema failures should be fixed before any release-confidence check is considered complete.

- **Release readiness**
  - Run `pnpm run release:readiness` before publishing a beta installer.
  - The script does not read certificate contents or secrets. It only checks for config/env signals, signed-updater manifest shape, expected bundle artifacts for the host platform, and whether the required quality-gate package scripts exist.
  - Warnings mean distribution work is still incomplete, usually signing or updater setup. Failures mean the local release handoff is structurally blocked, such as missing artifacts, mismatched versions, or missing gate commands.

## Notes

- No GitHub Actions, workflow files, or remote CI gates are expected for this repository.
- Local checks are the source of truth; document any skipped gate in the handoff when it is relevant.
- There is no need to run every gate for every small edit, but release-facing changes should climb the full ladder.
