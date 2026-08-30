# Testing & gates

There is no CI. Every gate in this project is local, run from `package.json`
scripts, and the repository says so deliberately —
`dev/local-quality-gates.md:3` states it outright. This page is therefore also
the CI documentation: if you do not run these, nobody does.

## The three rungs

```
pnpm preflight   format:check → lint:src → test → build
       │
pnpm check       preflight → e2e → sidecar:check → check:tauri-schema
       │                   → rust:check → rust:test
       │
pnpm release:readiness   executes those nine, plus the distribution report
```

| Command | What it is for |
| --- | --- |
| `pnpm preflight` | The everyday pre-commit pass |
| `pnpm check` | Everything. Genuinely long — Playwright plus 13 sequential sidecar smokes plus ~970 Rust tests |
| `pnpm release:readiness` | The nine gates plus signing, updater and artifact inspection |

> **Note:** `pnpm check` is slow enough that `release-readiness.mjs` defaults to
> a **45-minute per-gate** timeout (`PACKETBENCH_RELEASE_GATE_TIMEOUT_MS`). That
> is a fair indicator of the magnitude.

## What was green at the last release

Recorded in `CHANGELOG.md` for 0.13.1 at commit `8dc13780`:

| Gate | Result |
| --- | --- |
| `cargo check` | clean |
| Rust lib tests | 976 passing, 2 ignored |
| `acp_stream` integration | 31 passing |
| `tsc --noEmit` | 0 errors |
| `pnpm lint` | 0 errors (9 warnings, all pre-existing) |
| `vitest run` | 2765 / 2765 across 286 files |
| `check:tauri-schema` | clean |

> **Tip:** A static count of Rust test attributes comes out a little higher
> (856 inline plus 33 in `tests/`). Seven inline tests are `#[cfg(unix)]`-gated
> and nine are `#[ignore]`d, so the number that actually runs on a Windows box
> is lower than the number you can grep. Trust the run, not the grep.

## Frontend: vitest

`vitest.config.ts` is 18 lines and every one matters:

```ts
environment: "jsdom",
setupFiles: ["./src/test/setup.ts"],
include: ["src/**/*.{test,spec}.{ts,tsx}", "scripts/**/*.{test,spec}.{mjs,ts}"],
globals: true,
```

266 files: 262 under `src/` (168 `.test.ts` + 94 `.test.tsx`) and 4 under
`scripts/`. Tests concentrate heavily — `src/lib/__tests__` and
`src/stores/__tests__` are about 59% of the frontend suite.

`src/test/setup.ts` imports `@testing-library/jest-dom` and polyfills an
in-memory `localStorage` on both `window` and `globalThis` when jsdom's is
missing.

> **Warning:** There is **no coverage tooling**. `vitest.config.ts` has no
> `coverage` block and no `@vitest/coverage-*` package is installed, so
> `--coverage` fails. Do not promise a coverage number.

> **Important:** The `scripts/**` include glob is the only reason the four
> repository fences run. Running `vitest src` — scoping to a directory, as you
> would when iterating — **silently skips all four**. Run the bare
> `pnpm test` before you push.

## The repository fences

Four files under `scripts/` are not unit tests of application code. They scan
the source tree for banned idioms and fail the build when one appears. They are
written as vitest suites (none use `node --test`), so a violation turns
`pnpm test`, `preflight` and `check` red.

Three of the four share the same preamble: a read-once `FILE_CONTENTS` cache
and `FENCE_TIMEOUT_MS = 30_000`. The reason is recorded at
`scripts/confirm-idiom.test.mjs:14` — re-reading the tree per pattern took 9-25 s
and timed out against vitest's 5 s default whenever the disk was busy, and *"a
fence that fails for reasons unrelated to what it guards is worse than no
fence."*

### `scripts/confirm-idiom.test.mjs`

Bans the native confirm dialog. The regex at `:52` is

```js
/(?<![\w$.])(?:(?:window|globalThis|self)\??\.)?confirm\s*\(/
```

The lookbehind is what keeps `showConfirm(`, `onConfirm(` and `dialog.confirm(`
legal. It sanitizes in a specific order — strip block comments, blank quoted
spans per line, then strip line comments — because doing it any other way
produced false positives; there is a recorded incident where a *test title*
containing the words failed a build.

It also asserts positively: `ConfirmDeleteModal` is still exported, and 14 named
files still import it, so a silent revert to a bare delete shows up.

### `scripts/attempt-provider-mapping.test.mjs`

Bans deriving a backend provider id by stripping the `api-` prefix:

```js
/(?:replace(?:All)?\s*\(\s*\/\^api-\/|slice\s*\(\s*["'`]api-["'`]\.length)/
```

This needs a source fence rather than a unit test because the derivation is
*right for seven of eight executors* and wrong only for the default
`api-claude` → `"claude"`, which `get_provider` rejects — "a shape that survives
review easily". One allowlist entry: the test that demonstrates the broken
derivation on purpose.

It also asserts `attemptProviderFor` is exported from
`src/lib/attemptRouting.ts` and referenced by both
`src/components/flights/pickedToSpec.ts` and `src/stores/asyncFlightStore.ts`.

### `scripts/workspace-agents-boundaries.test.mjs`

The broadest fence, and the only one that scans **both** `src/` (`.ts`/`.tsx`)
and `src-tauri/src/` (`.rs`). Three invariants:

1. **Workspace/Agents separation.** No `addDraft(` anywhere. `WorkspaceView`,
   `WorkspaceCreationModal` and `AddSessionPicker` may not mention
   `launchConversation`, `API_PROVIDERS`, `addConversationPane` or
   `useAgentTaskStore`. `AgentsView` must contain `launchConversation({` and
   must not have `onLaunched:`.
2. **Retired identifiers.** Six names banned repo-wide (`openSession(`,
   `addConversationPane`, `ensureConversationWorkspace`,
   `attachConversationToWorkspace`, `openConversationAlongsideWorkspace`,
   `DraftTile`), with `src/stores/sessionGlue.ts` required to export
   `openConversationInAgents` and contain `removeConversationPanes`.
3. **The Monitor window boundary.** `WebviewWindowBuilder` is banned in every
   Rust source except `src-tauri/src/commands/monitor_windows.rs`;
   `new WebviewWindow` is banned in all frontend sources. It then JSON-parses
   `src-tauri/capabilities/monitor.json` and asserts `windows === ["monitor-*"]`
   and that `permissions` excludes `shell:default`, `fs:default` and
   `process:default`.

Unlike the other two, this fence skips `__tests__` directories and `*.test.*`
files.

### `scripts/target-triple.test.mjs`

Mostly a genuine unit test of `scripts/target-triple.js` — the five supported
triples, `tripleToSupportedArchitectures`, `sidecarPlatformPackage`,
`detectHostTarget`, `resolveTarget`. The notable assertion is that
`resolveTarget` **throws** when `TAURI_TARGET` and `TAURI_ENV_TARGET_TRIPLE`
disagree, because a stale export used to silently redirect `fetch-node`,
`prune-sidecar` and `release-gate` all to the same wrong target — so they agreed
with each other and the gate could not see it.

Its last `describe` block *is* a fence, over `scripts/release-gate.mjs`: no
hardcoded `node-x86_64-pc-windows-msvc.exe`; `nodeBinaryRelPath(triple)`,
`verifyStagedNodeRuntime(releaseTarget)`, `nodeArchiveSha256(triple)` and
`createHash("sha256")` must all be present; and it regex-extracts the
`authenticodeEnv` and `appleEnv` arrays to assert neither contains
`TAURI_SIGNING_PRIVATE_KEY`.

> **Warning:** That last assertion is not pedantry. Counting the updater
> minisign key as code-signing evidence once produced a false "Signing
> credentials present" PASS on a build with zero Authenticode configuration.

### ESLint carries a fence too

`eslint.config.js` uses `no-restricted-imports` to forbid `agentTaskStore.ts`
importing `workspaceStore` and vice versa. `sessionGlue` is the only permitted
bridge.

## Rust tests

Mostly inline `#[cfg(test)]` modules — 93 files carrying them, densest in
`src/core/worktree.rs` (42), `src/commands/provider_auth.rs` (41),
`src/commands/dictation/analytics.rs` (28), `src/core/git.rs` (26) and
`src/commands/project_memory.rs` (26).

Three integration files under `src-tauri/tests/`:

| File | Shape |
| --- | --- |
| `acp_stream.rs` | 1207 lines, 31 `#[tokio::test]`. End-to-end ACP bridge streaming against `src-tauri/testdata/mock-engine.mjs`, spawned as `node … acp`. No `packetcode` binary required, so it runs in a plain `cargo test` |
| `api_schema.rs` | 11 lines, one `#[ignore]`d test — the TS-binding exporter |
| `ollama_e2e.rs` | 312 lines, one `#[ignore]`d `#[tokio::test]`. Needs a live Ollama daemon; preconditions skip with a message rather than failing |

`acp_stream.rs` bounds every await with `STEP = Duration::from_secs(10)` so a
wedged reader fails fast instead of hanging the suite.

### Hermetic storage tests

`src-tauri/src/core/storage.rs` carries a `#[cfg(test)]` **thread-local**
data-dir override (`TEST_DATA_DIR`, `:243`). It is thread-local rather than a
global or an env-var mutation so parallel tests each get an isolated temp
directory and never race. The whole facility is `#[cfg(test)]`, so production
`data_dir()` compiles byte-identically in release.

> **Warning:** Do not replace that with a `HOME` rewrite. The historic approach
> was `#[ignore]` plus a `HOME` mutation, which clobbered real user state.

## Sidecar smokes

Thirteen standalone `.mjs` scripts in `agent-sidecar/test/`, chained by
`pnpm sidecar:check`:

```
sidecar:install → sidecar:build →
  smoke, remote-project-smoke, registry-smoke, protocol-smoke,
  session-ordering-smoke, gating-smoke, anthropic-edit-correlation-smoke,
  anthropic-multi-turn-smoke, mcp-config-smoke, mcp-trust-smoke,
  mcp-trust-enforcement-smoke, remote-mcp-fromfs-smoke, anthropic-apikey-smoke
```

There is no test framework and no `test` script in `agent-sidecar/package.json`
— that file only has `build` and `dev`. Each smoke is invoked from the **root**
`package.json` as a bare `node <path>`.

The pattern is the same throughout: spawn `node agent-sidecar/dist/index.js`,
write an NDJSON request to stdin, parse the NDJSON event stream from stdout with
`readline`, assert against explicit pass criteria written as a comment block at
the top of the file, then exit 0 with "OK" or print diagnostics and exit 1.

They run against `dist/`, so `sidecar:install && sidecar:build` must precede
them — `echo-smoke.mjs` fails with an explicit instruction if `dist/index.js`
is missing.

> **Warning:** After any `pnpm tauri build`, the sidecar's devDependencies have
> been pruned away and `sidecar:build` will fail. Run `pnpm sidecar:install`
> first. See [Build & release](dev-build.html).

## Schema staleness check

`pnpm check:tauri-schema` runs `scripts/check-tauri-schema.mjs`, which is a
generate-diff-restore:

1. Read the current `src/generated/tauri-schema.ts` into memory.
2. Run `cargo test --test api_schema export_api_bindings -- --ignored --nocapture`,
   which overwrites the file.
3. Read the regenerated content, then **write the original back** — so the
   check never leaves the tree dirty.
4. Exit 1 with "Run pnpm generate:tauri-schema" if they differ.

It resolves paths from `import.meta.url`, not cwd, and it runs cargo with
`cwd: src-tauri` because **Cargo discovers `.cargo/config.toml` from its working
directory, not from `--manifest-path`** — running from the repo root would miss
this repo's `target-dir` redirect.

## End-to-end (Playwright)

`playwright.config.ts`: `testDir: "./e2e"`, chromium only, 30 s timeout, web
server `pnpm exec vite --host 127.0.0.1 --port 1420 --strictPort`. Nine `test()`
calls across six spec files.

> **Important:** These are **web-mode only**. Tauri IPC is mocked via
> `e2e/setup/mock-tauri.ts`. Nothing here exercises the native shell, the PTY
> layer, the sidecar or the keyring. An e2e pass is not evidence that a packaged
> install works.

## Known gaps

Be honest about these rather than discovering them at release time.

- **`format:check` does not cover `src/`.** It checks `package.json`,
  `eslint.config.js`, `dev/local-quality-gates.md` and `e2e/**` only. `pnpm
  format` writes `src/`, but no gate verifies it. Intentional per
  `dev/local-quality-gates.md:31`, but surprising. A corollary: editing
  `dev/local-quality-gates.md` with the wrong Prettier formatting breaks
  `preflight`.
- **`lint:src` allows warnings.** `preflight` and `check` use `lint:src`, not
  `lint:strict`. `react-refresh/only-export-components` and `no-unused-vars`
  are warnings and never block a gate.
- **The four fences are invisible in the script list.** They are not a named
  script; they exist only because of the `scripts/**` include glob.
- **CI-aware code exists with no CI.** `playwright.config.ts:17` branches on
  `process.env.CI` for `forbidOnly`, `retries` and the `"github"` reporter, and
  `eslint.config.js` comments talk about turning CI red. Accurate in spirit —
  a store-isolation regression does fail `lint:src` inside `preflight` — but
  there is no CI to turn red.
- **No packaged install has been through the full acceptance matrix.** The
  0.12.1 changelog entry says so explicitly. `pnpm check` being green is not the
  same as an installer working.

## Adding a test

- Frontend unit: `src/**/__tests__/*.test.ts(x)`. Follow the neighbours; the
  store tests in `src/stores/__tests__` are the richest examples.
- Rust unit: an inline `#[cfg(test)] mod tests` beside the code. If it touches
  the data dir, use the thread-local override in `storage.rs`.
- A **fence** rather than a unit test when the wrong shape is one that *survives
  review* — a plausible-looking idiom that is correct in most instances and
  quietly wrong in one. That is the stated criterion in
  `scripts/attempt-provider-mapping.test.mjs:5`.
- A sidecar smoke when the behaviour is on the wire. Copy `echo-smoke.mjs`,
  write the pass criteria as a header comment, and add both a script entry and
  a link in the `sidecar:check` chain.

## Related

- [Invariants & tripwires](agent-invariants.html) — what the fences protect
- [Build & release](dev-build.html) — the gates that run at bundle time
- [Contributing](dev-contributing.html) — conventions the linters do not catch
