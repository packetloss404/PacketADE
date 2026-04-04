# FlightDeck Review - Security, Reliability, Performance

## Security

### High

- Arbitrary command execution surface from renderer to host.
  - Evidence: `src-tauri/src/commands/pty.rs`, `src-tauri/src/core/pty.rs`, `src-tauri/capabilities/default.json`
  - Why it matters: if the renderer is compromised, the host execution surface is broad.
- Transcript path traversal risk through unsanitized `session_id`.
  - Evidence: `src-tauri/src/commands/pty.rs`, `src-tauri/src/core/pty.rs`
- Git commit flow stages everything by default.
  - Evidence: `src/components/layout/Toolbar.tsx`, `src-tauri/src/core/git.rs`

### Medium

- `.env` and `.env.local` are included in normal directory listing behavior.
- state and transcript files are persisted in plaintext without retention policy.
- project path validation is not uniformly applied across all process-launch paths.

## Reliability

### High

- Pause/cancel semantics do not reliably stop live work.
- Fast session exit can outrun task/session linkage.
- Multiple stores can overwrite each other's persisted-state updates.
- Desktop approval and exit states are not fully canonical.

### Medium

- hydration/recovery failures are too quiet
- milestone resume logic has edge cases
- manual overrides can bypass review expectations
- TUI and desktop can disagree on final lifecycle state

## Performance

### High

- heavy session logic can remain mounted while the sessions view is hidden
- per-pane PTY event listeners scale poorly with pane count
- transcript writes are unbounded and transcript reads still do expensive full-file IO before slicing

### Medium

- whole-state persistence is heavy and repetitive
- main frontend bundle is large enough to trigger Vite chunk warnings
- statusline scans and cache strategy will need more care on long-lived machines

## Security Recommendations

1. narrow the PTY command trust boundary or at least add explicit operator consent and clearer policy
2. sanitize transcript/session identity rigorously
3. hide secret-bearing files by default in file browsing
4. change commit behavior from stage-all to reviewed/scoped flows
5. add transcript retention and data-storage documentation

## Reliability Recommendations

1. make process control atomic with task/flight state transitions
2. centralize persistence writes behind a patch API
3. unify exit-state handling across pane, tab, task, and flight layers
4. elevate approval-needed into canonical runtime state
5. surface recovery/hydration problems to operators

## Performance Recommendations

1. suspend or unmount terminal-heavy views when hidden
2. move PTY event fan-in to a single store/app-level listener
3. rotate transcripts and implement tail reads without full-file loads
4. debounce or delta-encode persistence
5. lazy-load terminal-heavy route segments where possible
