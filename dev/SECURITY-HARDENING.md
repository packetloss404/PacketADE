# PacketCode Security Hardening

**Date:** 2026-04-03
**Method:** Direct code audit of backend command modules, core modules, and configuration files

---

## Verified Security Issues

### CRITICAL

#### SEC-01: GitHub Token Stored as Plaintext on Disk

- **File:** `src-tauri/src/commands/github.rs`, lines 36-43
- **Issue:** `persist_token()` writes the GitHub PAT to `~/.packetcode/github-token` via `std::fs::write` with no file permissions restriction or encryption. Any process on the machine can read this file.
- **Fix:** Use OS credential store via `keyring` crate. Add `zeroize` crate to clear token from memory after use.

---

### HIGH

#### SEC-02: Transcript Path Traversal

- **File:** `src-tauri/src/core/pty.rs`, lines 359-362
- **Issue:** `transcript_path()` joins an unsanitized `session_id` directly into a file path. A crafted `session_id` like `../../etc/passwd` traverses out of the transcript directory. Both `read_transcript` and `append_transcript` are affected.
- **Fix:** Validate `session_id` matches UUID v4 format (`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`) before constructing the path.

#### SEC-03: Git Branch Name Not Sanitized

- **File:** `src-tauri/src/core/git.rs`, lines 133-138
- **Issue:** `branch_name` is passed directly as a git argument with no validation. A name starting with `--` could be interpreted as a git flag (e.g., `--exec=malicious-command`).
- **Fix:** Reject branch names starting with `-`, or use `--` end-of-options separator before the branch name in all git commands.

#### SEC-04: `localhost:1420` in Production CSP

- **File:** `src-tauri/tauri.conf.json`, line 26
- **Issue:** The Vite dev server URL `http://localhost:1420` persists in the production `connect-src` CSP directive. This allows the webview to make requests to any service running on that port, which could be exploited if another process binds to it.
- **Fix:** Remove `http://localhost:1420` from the CSP in production builds. Use Tauri's build-time CSP configuration to have different policies for dev vs production.

---

### MEDIUM

#### SEC-05: Synchronous I/O on Main Thread

- **Files:** `src-tauri/src/commands/fs.rs`, `src-tauri/src/core/git.rs`
- **Issue:** All filesystem reads (`std::fs::read_dir`) and git subprocess calls (`Command::new("git")`) are synchronous. Under heavy load or with large directories/repos, these block the Tauri main thread, causing UI freezes and potential denial-of-service.
- **Fix:** Wrap blocking I/O in `tokio::task::spawn_blocking()` for all Tauri command handlers.

#### SEC-06: `.env` Filter is Allowlist-Based (Maintenance Risk)

- **File:** `src-tauri/src/commands/fs.rs`, line 46
- **Issue:** Currently safe -- `.env` files are filtered from directory listings. However, the filtering is allowlist-based, meaning new sensitive file patterns (e.g., `.env.production`, `credentials.json`, `.secret`) would need to be explicitly added. A future refactor could inadvertently remove the filter.
- **Fix:** Add an explicit sensitive-file blocklist pattern (e.g., `.*env*`, `*credential*`, `*secret*`, `*.pem`, `*.key`) in addition to the current filter.

#### SEC-07: Git Commit Message Unbounded

- **File:** `src-tauri/src/core/git.rs`, line 89
- **Issue:** No size limit on the commit message passed to `git commit -m`. An extremely large message could cause process memory issues or be used to inject content.
- **Fix:** Apply `validate_input_size` (which already exists in the codebase for other inputs) to commit messages.

---

### LOW

#### SEC-08: `get_cwd` Information Disclosure

- **File:** `src-tauri/src/commands/fs.rs`, line 17
- **Issue:** Returns the Rust process's current working directory to the webview. While not directly exploitable, it leaks host filesystem structure information.
- **Fix:** Consider whether this command is necessary, or scope it to return only the configured project path.

#### SEC-09: External Domain in CSP

- **File:** `src-tauri/tauri.conf.json`
- **Issue:** `specs-gen.vercel.app` is included in both `connect-src` and `frame-src` CSP directives. This allows the webview to load content from and communicate with this external domain.
- **Fix:** Document why this domain is trusted (Vibe Architect feature). Consider making it configurable or removing it if the feature is disabled.

---

## Code Signing Status

**Not configured.** The `tauri.conf.json` bundle section contains no signing fields:
- No `windows.certificateThumbprint`
- No `windows.digestAlgorithm`
- No `windows.timestampUrl`
- No macOS signing identity or entitlements

**Impact:** Windows SmartScreen will display "Windows protected your PC" / "Unknown Publisher" warning. macOS Gatekeeper will block execution entirely with "cannot be opened because the developer cannot be verified."

**Required for public distribution:**
1. Obtain a Windows code signing certificate (EV or OV)
2. Configure macOS signing identity + notarization
3. Add signing config to Tauri build pipeline
4. Set up CI secrets for automated signing

---

## Positive Security Findings

These security measures are already in place and should be preserved:

- **PTY command allowlist** -- `create_pty_session` validates commands against a known-good list
- **Workspace boundary checks** -- `fs.rs` uses path canonicalization to prevent traversal in directory listings
- **Protected branch push guard** -- `core/git.rs` blocks pushes to `main`/`master`
- **Stage-all disabled** -- Git commit rejects if no files are explicitly staged (no `git add .` behavior)
- **Input size limits** -- `validate_input_size` exists and is used for some inputs
- **GitHub response sanitization** -- Markdown content from GitHub is not directly injected into the DOM
- **Fast-forward-only pull** -- `git pull` uses `--ff-only` to prevent unexpected merges
