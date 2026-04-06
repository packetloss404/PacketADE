# Sprint 00: Security Hardening, Test Foundation & Lint Cleanup

**Date:** 2026-04-06
**Status:** Complete

## Sprint Goal

Fix all identified security vulnerabilities, stand up frontend test infrastructure, and clean up lint warnings — establishing a safe, testable foundation before Sprint 01 (Control Plane Hardening) begins.

---

## Completed Tasks

### Security Fixes

| ID | Severity | Issue | Fix | Files |
|----|----------|-------|-----|-------|
| SEC-01 | **Critical** | GitHub token stored as plaintext file | Migrated to OS credential store via `keyring` crate + `zeroize` for memory cleanup. Legacy file auto-migration included. | `commands/github.rs`, `Cargo.toml` |
| SEC-02 | **High** | Transcript path traversal via crafted session_id | Added UUID validation in `transcript_path()` before path construction | `core/pty.rs` |
| SEC-03 | **High** | Git branch name injection (`--flag` as branch name) | Added `validate_branch_name()` + `--` end-of-options separator in git args | `core/git.rs` |
| SEC-04 | **High** | Vite dev server URL in production CSP | Removed `http://localhost:1420` from `connect-src` (Tauri auto-allows devUrl in dev mode) | `tauri.conf.json` |
| SEC-05 | **Medium** | Synchronous I/O blocking main thread | Wrapped all 9 fs/git commands in `tokio::task::spawn_blocking()` | `commands/fs.rs`, `commands/git.rs` |
| SEC-06 | **Medium** | Sensitive file filter gaps | Added blocklist for `credentials.json`, `.pem`, `.key`, `.p12`, `.pfx`, `.keystore` | `commands/fs.rs` |
| SEC-07 | **Medium** | Unbounded git commit message | Applied existing `validate_input_size` (1MB limit) to commit messages | `commands/git.rs` |

### Test Infrastructure

| Item | Detail |
|------|--------|
| **vitest** | Installed vitest 4.x + jsdom + @testing-library/react + @testing-library/jest-dom |
| **Config** | `vitest.config.ts` with jsdom environment, `@/` path alias, globals |
| **Tauri mocks** | `src/__mocks__/@tauri-apps/api/core.ts` and `event.ts` stub `invoke`/`listen`/`emit` |
| **Smoke tests** | 4 tests in `src/lib/__tests__/storage.test.ts` exercising `loadFromStorage`/`saveToStorage`/`removeFromStorage` |
| **Scripts** | `pnpm test` (vitest run) and `pnpm test:watch` (vitest) added to package.json |

### CI Updates

- Added `pnpm test` step in frontend job (after ESLint, before build)
- Added `libdbus-1-dev` to Linux system dependencies (required by `keyring` crate)

### Lint Cleanup

- Fixed `react-hooks/exhaustive-deps` warning in `TerminalPane.tsx` (added `paneId` to useCallback deps)

---

## Verification Results

| Check | Result |
|-------|--------|
| `pnpm lint` | 0 warnings |
| `pnpm test` | 4 passing (was 0) |
| `pnpm build` | Clean |
| `cargo test` | 31 passing (was 15) |

### New Rust Tests Added

- `core::pty::tests` — 3 tests (path traversal, UUID validation)
- `core::git::tests` — 6 tests (branch name validation)
- `commands::fs::tests` — 3 tests (sensitive file blocklist)
- `commands::github::tests` — 4 tests (GitHub name validation)

---

## What This Unlocks

- **Sprint 01** can proceed without shipping known security vulnerabilities
- **Sprint 03** test infrastructure work (store tests, component tests) has a working vitest setup to build on
- **CI** now gates on both frontend tests and Rust tests
- **Public distribution** path is partially unblocked (keyring for secrets, CSP hardened)
