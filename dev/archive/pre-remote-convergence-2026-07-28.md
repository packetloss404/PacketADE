# Pre-Remote Loop Convergence — 2026-07-28

Status: **locally converged; post-convergence source gaps closed; external
runtime gates isolated**

Baseline: **v0.10.2**

> **Provider correction (2026-08-01):** this is a dated convergence record.
> References below to the former Codex subscription chat provider and its MCP
> trust proxy describe the July 28 runtime only. `api-openai-codex` and that
> proxy were removed on July 31; the current live/packaged matrix covers the
> API-key-backed Claude Agent SDK, OpenAI Agents SDK, and in-process providers.

## Scope and stop boundary

This record closes the locally executable portion of the user-confirmed
pre-Remote queue:

1. Flight supervision proof
2. Dictation reliability
3. Trust and provenance
4. Project-local Memory Hub
5. Local-first MCP Hub
6. Combined convergence

Remote Agents was not started. PacketAgent and the sibling PacketCode
repository were not modified. No external release, signing, updater
publication, secret change, or protected-branch bypass was performed.

## Combined result

- The implemented Flight supervision stack passed its focused automated
  proof. Packaged interaction and real SSH behavior remain manual gates.
- Dictation now has stable device identity/doctor output, bounded capture and
  recovery, opt-in global shortcuts, safe editor/PTY targeting, private timing
  telemetry, and platform packaging metadata. This Windows host reported no
  active capture endpoint, so physical microphone behavior and DV17 engine
  benchmarking remain evidence-gated.
- Trust and provenance now share a versioned TypeScript/Rust/sidecar envelope,
  legacy-unknown migration, compact UI, risky-action enforcement, downstream
  lineage, and bounded redacted audit.
- Project Memory now uses a bounded `.agents/memory` Markdown repository with
  revisions, safety checks, links/backlinks/health, unified retrieval,
  capture, UI, and permission-gated MCP access.
- The MCP Hub now unifies catalog review, config, diagnostics, trust,
  provenance, suite resources, and explicit reconnect. Protocol v11 freezes
  authority for PacketBench-managed MCP runtimes.
- Codex subscription MCP now receives a generated MCP configuration that
  exposes PacketBench's frozen session snapshot through a local trust proxy.
  The proxy advertises only allowlisted servers/tools and re-checks write,
  credential, protected-publish, and workspace-root denial floors before
  forwarding calls. The deterministic target/proxy smoke is green; a real
  Codex CLI and packaged remote-profile matrix remains environment-gated.

## Convergence findings fixed

- Added the three new dictation events to the browser-mode Tauri contract so
  the no-console-error E2E gate remains meaningful.
- Hardened the Workspace navigation smoke against the initial parallel
  CLI-detection render exceeding Playwright's five-second default.
- Corrected the curated Filesystem server disclosure: its first `npx` launch
  may download the package even though the running MCP server is local.
- Made the release-readiness reporter resolve Cargo's effective target
  directory, including a local `.cargo/config.toml`, so it finds the bundles
  Tauri actually produced.

## Verification evidence

| Gate                                | Result                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                 | pass                                                                                                                             |
| `pnpm lint`                         | pass, 0 errors; 9 existing Fast Refresh warnings                                                                                 |
| `pnpm test`                         | pass, 156 files / 1,207 tests                                                                                                    |
| `pnpm build`                        | pass, production frontend                                                                                                        |
| `pnpm e2e`                          | pass, 7/7 Chromium web-mode smokes                                                                                               |
| `pnpm run sidecar:check`            | pass, protocol v11 and deterministic provider/MCP smokes                                                                         |
| Live Anthropic multi-turn           | gated; two 60-second attempts produced no terminal event, deterministic suite now requires `PACKETBENCH_LIVE_ANTHROPIC_SMOKE=1`    |
| `cargo fmt --check`                 | pass                                                                                                                             |
| `cargo check`                       | pass; existing ts-rs `missionId` alias warning only                                                                              |
| `cargo test --no-run`               | pass; both Rust test executables compiled                                                                                        |
| `pnpm check:tauri-schema`           | pass after adding a linker-level Common Controls v6 manifest dependency; the native schema and Rust unit-test executables launch |
| `pnpm tauri build`                  | pass; unsigned Windows standalone EXE, MSI, and NSIS installer                                                                   |
| `pnpm run release:readiness:report` | 0 failures, 6 expected signing/updater warnings                                                                                  |
| `git diff --check`                  | pass; CRLF future-normalization warnings only                                                                                    |

## Unsigned local artifacts

| Artifact                                                                                  |       Size | SHA-256                                                            |
| ----------------------------------------------------------------------------------------- | ---------: | ------------------------------------------------------------------ |
| `C:\Users\ianwalmsley\packetbench-build\release\packetbench.exe`                              |  42.25 MiB | `E69A6973180293590C1A467473B19579173716A45F7BC09F322B2409B31EC352` |
| `C:\Users\ianwalmsley\packetbench-build\release\bundle\msi\PacketBench_0.10.2_x64_en-US.msi`  | 131.76 MiB | `95B04AC1AC4E3F1F4CDD6AB2AE99EFC45C8AFA3CEE2D498414CEE6F9B77C0A4F` |
| `C:\Users\ianwalmsley\packetbench-build\release\bundle\nsis\PacketBench_0.10.2_x64-setup.exe` |  84.37 MiB | `F566D88D2A220015D2FC03A8525EF854B31601EC149CF4DFA8DC0EA0B6209C3A` |

These artifacts prove local compilation and bundling only. They are unsigned
and were not installed, published, or represented as release candidates.

## Remaining gates

- Flight supervision: packaged local interaction plus a configured,
  host-key-pinned SSH matrix.
- Dictation: an active physical microphone, Windows paste/PTT matrix, packaged
  macOS/Linux permission/runtime matrix, and DV17 evidence.
- Trust/provenance: live local/SSH provider parity and packaged visual/manual
  inspection.
- Project Memory: real external-editor watch storms, partial writes,
  rename/restart recovery, and packaged dirty/gitignored project behavior.
- MCP Hub: real Codex/stdio/SSH crash/reload/version-skew, offline
  install/removal, HTTP/SSE diagnostics beyond the current stdio doctor, and
  remote-profile parity.
- Distribution: Windows/macOS signing credentials, notarization, updater
  configuration, and a signed updater manifest.

The authoritative open items remain in `backlog.md`. Remote Agents remains the
next product decision boundary, not an automatically started implementation.

## Post-convergence follow-up — 2026-07-29

The cleanup tranche after the baseline above also landed the PacketAgent W9
consumer, Issue⇄Flight P1–P3 I/O/UI, read-only Agent/Flight Monitor windows,
the SSH attempt `serverId` wire rename with legacy aliases, auth-watcher hard
max/flush behavior, corrected Codex flat-output handling, bounded PacketAgent
responses, Ollama usage capability negotiation, worktree ID validation,
fail-closed hook payload serialization, PTY error-kind logging, prompt-template
command-palette launch, review-packet diff routing, and the carried test gaps.

PacketAgent's live close/restart/reconnect gate, packaged GitHub/Gitea mirror
proof, packaged multi-display Monitor proof, and the existing hardware/SSH/
provider/signing gates remain in `backlog.md`. Remote Agents was still not
started.

The final post-convergence `pnpm check` passed on 2026-07-29:

- Prettier and ESLint: pass, zero errors and the same nine Fast Refresh
  warnings.
- Vitest: 158 files / 1,217 tests passed.
- Production frontend build: pass.
- Playwright: 7/7 Chromium web-mode flows passed.
- Sidecar: build plus all deterministic provider, protocol-v11, permission,
  MCP, and Codex trust-proxy smokes passed; the live Anthropic round trip
  remained explicitly opt-in.
- Generated Tauri schema: native exporter passed and matched the checked-in
  bindings.
- Rust: format/check plus 423 unit tests, the application harness, schema
  integration test, and doc tests passed; two real-user-state tests remain
  intentionally ignored.
- `git diff --check`: pass after generated-schema whitespace normalization.

The same final pass also made the Git fixtures independent of a developer's
global `core.autocrlf` setting and changed the Mission-to-Flight migration test
from whitespace-sensitive string matching to structural JSON assertions.
