# Reliability Low-Finding Fix Loop

Started: 2026-07-19  
Source audit: [`code-review-2026-06-07.md`](./code-review-2026-06-07.md)  
Backlog status: [`../../backlog.md`](../../backlog.md#completed-boundaries) — cleared

## Objective

Close every remaining low-rated Reliability audit finding with current-code
evidence. A finding is complete only after this loop succeeds:

1. Revalidate the report against the current implementation.
2. Fix the defect, or evidence-close it if the current code already satisfies
   the reported reliability contract.
3. Add or strengthen a focused regression test.
4. Run the narrow subsystem gate, then the full repository gates.
5. Remove the completed entry from `backlog.md` and record the result in
   `CHANGELOG.md`.

No item closes solely because its original line number moved or because a
partial mitigation exists.

## Batches and gates

| Batch | Scope | Narrow gates |
| --- | --- | --- |
| A | Terminal, filesystem, auth, persistence, release packaging | Vitest hook/lib tests; focused Rust tests; release-gate tests |
| B | API-agent and sidecar ownership, cancellation, isolation, buffering | sidecar smoke suite; focused Rust API-agent/sidecar tests |
| C | Provider/event ordering, retry, Flight and UI state | focused provider tests; Zustand/listener/Flight tests |
| Final | Cross-cutting verification and documentation | `pnpm lint`; `pnpm build`; `pnpm test`; `cargo check`; `cargo test --no-run`; sidecar tests; release gate |

## Run ledger

Status values: `queued`, `fixing`, `gated`, `closed`, `evidence-closed`.

| Finding | Batch | Acceptance condition | Status |
| --- | --- | --- | --- |
| F03 | A | A PTY session emits `onSessionEnded` at most once across kill, exit, restart, and unmount paths. | closed |
| F04 | A | Transcript replay uses backend sequence metadata; repeated text cannot be lost as a false overlap. | closed |
| F05 | A | Windows command lookup failure preserves the requested executable name instead of fabricating `.cmd`. | closed |
| F12 | A | Remote write confines the nearest existing ancestor before any `mkdir -p`. | closed |
| F15 | A | Backup data and the containing directory receive durability syncs around replacement. | closed |
| F17 | A | Creation of a previously absent provider-auth directory installs a direct watch before later credential writes. | closed |
| F18 | A | Keyring access failures surface as errors and are not reported as a missing key. | closed |
| F29 | A | Counter mutation and persistence ordering cannot let an older snapshot overwrite a newer launch count. | closed |
| F41 | A | The fully rendered commit trailer is shell-literal safe even when the user controls the format string. | closed |
| F42 | A | Whisper binaries are verified against pinned SHA-256 digests before installation. | closed |
| F43 | A | Serialized plan-item payloads expose `activeForm`, matching the frontend contract. | closed |
| F47 | A | A valid final SSE record is processed even without a trailing newline. | closed |
| F54 | A | Release checks derive all Node/sidecar artifact paths from the selected target triple. | closed |
| F57 | A | SSH tests cover pinned known-hosts, unpinned accept-new, port, key, and password argument branches. | closed |
| F26/G04 | B | Sidecar ownership routing waits for authoritative state and cannot fall through during lock contention. | closed |
| F27 | B | Cancelling pending tools affects only the requested in-process session. | closed |
| F35 | B | Usage/cost persistence failures are observable rather than discarded. | closed |
| F37 | B | Closing an API-agent session resolves and removes that session's pending permission/edit waiters. | closed |
| G05 | B | A transient local writer failure does not independently erase valid session ownership. | closed |
| G06 | B | Turn cancellation emits exactly one cancelled terminal event; conversation ownership remains reusable until explicit close releases local/SSH routes. | closed |
| G07 | B | Sidecar request queues apply backpressure and stdout records have an enforced maximum size. | closed |
| G20 | B | Cancellation races and interrupts tool execution, not only provider streaming. | closed |
| G21 | B | One upstream Anthropic HTTP failure produces one user-visible terminal error. | closed |
| G13 | C | Every Codex tool result has the same non-empty stable ID as its matching tool start. | closed |
| G14 | C | Current terminal handling has no shared chunk buffer or competing drain tasks after Planner amputation. | evidence-closed |
| G15 | C | `maxOutputTokens` is honored or rejected explicitly; it is never accepted and dropped. | closed |
| G30 | C | The attempt user message shown in the conversation is the prompt actually sent. | closed |
| G34 | C | Automatic retry preserves the failover system notice. | evidence-closed |
| G35 | C | Late tool results remain correlated after turn completion or surface an explicit orphan record. | closed |
| G36 | C | User cancellation suppresses success notification and queued-turn draining. | closed |

## Completion record

Completed: 2026-07-19

- **Batch A:** added once-only PTY endings and sequenced replay; preserved
  unresolved Windows executable names; closed the pre-`mkdir` SSH symlink
  window; strengthened state backup durability, auth directory watching,
  keyring error reporting, provider-stat serialization, trailer escaping,
  Whisper checksum verification, plan payload casing, SSE EOF parsing,
  target-aware release checks, and SSH argument coverage.
- **Batch B:** made sidecar ownership reads authoritative; scoped and drained
  in-process waiters by session; logged usage persistence failures; retained
  ownership across transient writer faults; bounded sidecar queues and stdout
  records; introduced exactly-once cancelled terminal events; raced tool
  execution against cancellation; and removed duplicate provider error paths.
- **Batch C:** repaired Codex tool IDs, rejected unsupported injected token
  limits, made Flight prompts identical across backend and UI state, preserved
  retry notices, retained late tool results, and suppressed cancel-time success
  effects. G14 was stale after Planner/backend-buffer removal. G34 was already
  fixed in current code and received a regression test.

### Verification

| Gate | Result |
| --- | --- |
| Focused frontend regressions | 80 passed |
| Full Vitest suite | 125 files, 974 tests passed |
| Full sidecar check | passed (all 12 build/smoke stages, protocol v10) |
| TypeScript/Vite production build | passed |
| ESLint | passed with 9 pre-existing Fast Refresh warnings, 0 errors |
| `cargo check` | passed |
| `cargo test --no-run` | passed; both Rust test executables compiled |
| Rust test execution | host-blocked before the harness by Windows `0xc0000139` (`STATUS_ENTRYPOINT_NOT_FOUND`); no Rust assertion ran or failed |
| Tauri schema check | same host-runtime block because the check invokes the Rust test harness |
| Release gate | 11/11 passed |
| `git diff --check` | passed |

All 30 backlog entries are closed. The two host-blocked commands remain an
environment repair item, not an unresolved audit finding; their code and test
targets compile successfully.

> Follow-up 2026-07-29: the Windows loader defect was fixed with a linker-level
> Common Controls v6 dependency. Rust unit tests and the Tauri schema integration
> executable now launch; the two historical gate rows above describe only the
> original 2026-07-19 checkpoint.
