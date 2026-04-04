# FlightDeck Review - Testing And Release Readiness

## Command Results

### `pnpm lint`

Status: failed

Key failures:

- `src/agents/types.ts`
  - `no-control-regex`
- `src/components/views/FlightDeckView.tsx`
  - memoization/dependency mismatch around `getAttentionFlights`

### `pnpm build`

Status: passed

Notes:

- bundle built successfully
- Vite warned about dynamic import behavior not splitting some modules as expected
- main JS chunk was large enough to trigger the chunk size warning

### `cargo test`

Status: passed

Notes:

- 7 Rust tests passed
- visible coverage is concentrated in statusline helpers/parsers
- several dead-code warnings appeared in the TUI binary during compilation

## Testing Assessment

### High-confidence gaps

- no frontend `test` script in `package.json`
- no obvious frontend test suite under `src/`
- Rust tests appear concentrated in `src-tauri/src/commands/statusline/mod.rs`
- orchestration, persistence, PTY lifecycle, and git safety lack comparable visible coverage

## CI Assessment

### Strengths

- CI runs lint and build for the frontend
- CI runs `cargo test`
- CI builds Tauri bundles on Linux, macOS, and Windows

### Weaknesses

- `pnpm audit` and `cargo audit` are advisory only
- release workflow can build the wrong code for a manually provided tag because checkout does not pin the requested tag ref
- release flow does not visibly rerun the same verification stack as CI before drafting a release

## Readiness Verdict

### Current readiness

- internal use: yes
- design partner preview: almost
- broad external launch: no

### Why not yet

- testing depth is too shallow for the current orchestration/process-control risk surface
- lint is not clean
- lifecycle behavior is not yet trustworthy enough for unattended agent work
- release pipeline has correctness and assurance gaps

## Recommended Test Plan

1. frontend unit tests for `flightStore`, `orchestrationStore`, `layoutStore`, and status derivation
2. backend unit/integration tests for PTY lifecycle, transcript safety, storage migration, and git flows
3. cross-layer tests for persisted-state round-tripping between Rust and TS DTO mapping
4. end-to-end happy-path tests for create flight -> launch -> approval -> review -> completion
5. regression tests for pause/cancel/restart/recovery/detached-session flows
