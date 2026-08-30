# Agent orientation

A briefing for an AI coding agent working in the PacketBench repository. It
assumes no prior context, states what is true rather than what would be nice,
and points at the file that settles each question. Read
[Invariants & tripwires](agent-invariants.html) next — it covers the rules that
look safe to break and are not.

> **Important:** `CLAUDE.md` (identical to `AGENTS.md` below the H1) is the
> canonical in-repo orientation document and takes precedence over this page if
> they ever disagree. Both are **gitignored**, so they will not appear in
> `git ls-files`, `git grep`, or any repo-wide sweep. Read them explicitly.

## What this is

A Tauri v2 desktop application. Rust backend, React 19 + TypeScript frontend
(Vite), Zustand for state, Tailwind with custom theme tokens, xterm.js over
`portable-pty` for terminals, plus a separate Node package
(`agent-sidecar/`) that hosts two provider SDKs and is bundled into installers.

Version 0.13.1. Package manager pnpm 9.15.4. There is **no CI** — local gates
are the source of truth (`dev/local-quality-gates.md`).

The product was renamed twice: PacketCode → PacketADE → **PacketBench**
(2026-08-26). Historical files, `dev/archive/`, `docs/reports/` and one-shot
migration code still carry the old names on purpose. All new code uses
PacketBench.

## Repository layout

```text
src/                      React frontend
  App.tsx                 view routing + global event listeners
  components/
    agents/               chat, composer, review, diff, tool cards
    flights/              launch modal, planning card, attempt grid
    issues/ layout/ session/ ui/ workspace/ views/ monitor/
  hooks/                  useGitInfo, useStatusLine, useVoiceInput, ...
  lib/
    tauri.ts              EVERY invoke wrapper + event helper (~4.1k lines)
    brand.ts              APP_NAME, STORAGE_PREFIX, storageKey()
    api-models.ts         API_PROVIDERS — the nine picker rows
    attemptRouting.ts     agent-row id -> backend provider id
    settingsNavigation.ts SETTINGS_GROUPS (six groups)
  stores/                 Zustand stores, one concern each
  types/                  shared TS interfaces
  generated/
    tauri-schema.ts       AUTO-GENERATED from Rust DTOs — do not hand-edit
  modules/registry.ts     Code Quality + Dictation module manifests

src-tauri/                Rust backend
  src/lib.rs              app builder, startup order, command registration
  src/commands/           one file per feature; #[tauri::command] entry points
  src/core/
    brand.rs              APP_NAME, DATA_DIR_NAME, KEYRING_SERVICE, ...
    migration.rs          one-shot rename migrations
    storage.rs            PersistedState + state.v1.json
    llm_provider.rs       LlmProvider trait; llm_*.rs implementations
    execution.rs          SshConfig; worktree.rs; git_host.rs; orchestrator.rs
  src/acp/                Agent Client Protocol transport (PacketCode engine)
  tests/                  api_schema.rs, acp_stream.rs, ollama_e2e.rs
  capabilities/           default.json, monitor.json

agent-sidecar/            separate Node package (its own pnpm install)
  src/protocol.ts         SidecarRequest/SidecarEvent, PROTOCOL_VERSION = 11
  src/session-registry.ts provider factory map
  src/providers/          anthropic.ts, openai-agents.ts, echo.ts, base.ts
  test/                   *.mjs smoke gates

scripts/                  build helpers AND the repository fences
  confirm-idiom.test.mjs            \
  attempt-provider-mapping.test.mjs  > filesystem fences, run by vitest
  workspace-agents-boundaries.test.mjs /
  target-triple.test.mjs            (an ordinary unit test, not a fence)
dev/                      planning index, runbooks, archive
e2e/                      Playwright, web-mode only
```

## Three backends, one event contract

This is the single most load-bearing architectural fact. Conversations are
served by three different transports and the frontend cannot tell which:

| Transport | Rows | Entry point |
| --- | --- | --- |
| In-process Rust | `api-claude`, `api-openai`, `api-minimax`, `api-openrouter`, `api-ollama`, `api-custom` | `core/llm_provider.rs` |
| Node sidecar | `api-claude-oauth` (Claude Agent SDK), `api-openai-agents` | `commands/agent_sidecar/` |
| ACP subprocess | `api-packetcode` | `src/acp/routing.rs` |

All three emit `api-agent:{kind}:{sessionId}` Tauri events. `kind` ∈ `chunk`,
`thinking`, `thinking-stop`, `tool-start`, `tool-result`,
`permission-request`, `pending-edit`, `edit-baseline`, `plan-block`,
`tool-output-extended`, `turn-summary`, `mcp-sources`, `done`, `error`. Global
app events: `provider-auth:changed`, `sidecar-status:changed`.

`commands/api_agent.rs` branches at the top: `crate::acp::routing::is_acp_provider`
first, then sidecar routing, then in-process. If you add a transport, it emits
this vocabulary or the frontend does not see it. Details in
[Agent event contract](dev-agent-contract.html).

## Adding a Tauri command

Four steps, in this order.

**1. Write the command** in `src-tauri/src/commands/<feature>.rs`:

```rust
/// Doc comment explains WHY, not what — this codebase's comments carry the
/// reasoning, and reviewers rely on that.
#[tauri::command]
pub async fn do_the_thing(project_path: String, count: u32) -> Result<ThingDto, String> {
    super::validate_project_path(&project_path)?;
    // ...
    Ok(dto)
}
```

Errors are `Result<T, String>` — the frontend receives the string. Validate any
path argument; there are shared helpers in `commands/mod.rs`.

**2. Register it** in `src-tauri/src/lib.rs`, inside the
`guarded_invoke_handler![ ... ]` list, in the section for its feature.

> **Warning:** `guarded_invoke_handler!` is not plain `generate_handler!`. It
> wraps the handler with a per-window check: any window whose label starts with
> `monitor-` may only invoke commands in `MONITOR_ALLOWED_APP_COMMANDS`
> (`commands/monitor_windows.rs`). Everything else is rejected with a message.
> A new command is main-window-only unless you deliberately add it to that
> allowlist — and widening the Monitor's read-only posture is a reviewed
> decision, not a convenience.

**3. Add the TS binding** in `src/lib/tauri.ts` — every `invoke` in the app
goes through this file, none are scattered in components:

```ts
export async function doTheThing(projectPath: string, count: number): Promise<Thing> {
  return invoke<Thing>("do_the_thing", { projectPath, count });
}
```

Tauri converts `snake_case` Rust parameters to `camelCase` on the JS side; pass
`camelCase` keys.

**4. If you touched a shared DTO**, regenerate the schema:

```bash
pnpm generate:tauri-schema   # writes src/generated/tauri-schema.ts
pnpm check:tauri-schema      # fails if the checked-in file is stale
```

`src/generated/tauri-schema.ts` is produced by the ignored `export_api_bindings`
test in `src-tauri/tests/api_schema.rs`. Never hand-edit it.

## Store patterns

Zustand, `create<StoreInterface>()`, one store per concern, 58 of them in
`src/stores/`. Three persistence shapes coexist:

**Backend-authoritative.** Flights, workspaces, servers, agent configs and the
memory slice live in `~/.packetbench/state.v1.json` via `commands/state.rs`.
The store calls a `save*Slice` wrapper from `lib/tauri.ts` after mutating.

**localStorage.** UI preferences, agent profiles, MCP trust, cost guardrails.
Always build the key with `storageKey()` from `@/lib/brand`:

```ts
import { storageKey } from "@/lib/brand";
const STORAGE_KEY = storageKey("agent-profiles"); // -> "packetbench:agent-profiles"
```

**Both.** Issues are the notable case: `localStorage` `packetbench:issues` is
the authoritative cold-start cache, and every mutation is *also* mirrored into
`PersistedState.issues` so Rust-side consumers (the `Fixes #N` commit-trailer
close loop in `commands/git.rs`) see the same set. Route new mutations through
`saveState` so they inherit both.

### Store isolation is lint-enforced

`agentTaskStore` (headless conversations) and `workspaceStore` (pane placement)
**must not import each other**. `eslint.config.js` carries a
`no-restricted-imports` rule in both directions. `src/stores/sessionGlue.ts` is
the only bridge; `sessionIndex` is a read-only projection. A conversation with
no tile is a first-class citizen, and that is what the rule protects.

## The rules that are not negotiable

### Theme tokens, never raw Tailwind colours

`tailwind.config.ts` defines a semantic palette backed by CSS custom
properties, so the app can be re-themed at runtime:

- backgrounds: `bg-bg-primary`, `bg-bg-secondary`, `bg-bg-tertiary`,
  `bg-bg-elevated`, `bg-bg-hover`, `bg-bg-border`
- lines: `border-line-soft`, `border-line-strong`
- text: `text-text-primary`, `text-text-secondary`, `text-text-muted`,
  `text-text-faint`
- accents: `accent-green`, `accent-amber`, `accent-blue`, `accent-red`,
  `accent-purple`, plus `accent-soft` / `accent-line` fills

Writing `bg-gray-800` or `text-red-500` hardcodes a colour outside that system
and breaks the light theme. Type scale is compact: `text-xs` (12px) as the
default, `text-[11px]` / `text-[10px]` for dense chrome, plus the semantic
`text-ui` / `text-meta` / `text-body` / `text-chip` sizes. Icons are
lucide-react at `size={12}` in toolbars, `size={14}` in headers.

### Never hardcode the product name

Import from `src/lib/brand.ts` (TS) or `src-tauri/src/core/brand.rs` (Rust).
Literals of `"PacketBench"`, `"packetbench"` or `"packetbench:"` in new code
are a defect: they are what made the last rename a ~400-file change.

The `LEGACY_*` constants in both modules point at the *immediately prior* name
(`packetade`, `.packetade`, `packetade:`) and exist only for the one-shot
migrations of keyring secrets, the data directory and localStorage. The earlier
`packetcode` migration has already run. Do not add a third generation.

> **Note:** `PacketCode` is not a legacy alias to sweep away. It is a live
> sibling TUI product at `D:\projects\packetcode`, and it is also the name of
> the ACP engine row inside PacketBench. `migration.rs` classifies a
> `~/.packetcode` directory partly to avoid destroying that product's data.

### Flight, not Mission

The work unit is a **Flight**; the surface is the **Flight Deck**; the route is
`"flights"`; the view is `FlightsView.tsx`; the store is `flightStore.ts`.

"Mission" survives only as read-side persisted-data compatibility — a
`missionId` key deserializes into `flight_id` through a serde alias, and
`core::migration::migrate_mission_to_flight` canonicalises it on the next save.
Do not introduce Mission terminology anywhere new, and do not remove the alias
without a release of lead time.

### Modals, confirms and dropdowns

Use the shared wrappers: `src/components/ui/Modal.tsx`,
`ConfirmDeleteModal.tsx`, `Dropdown.tsx`. Native `window.confirm` is banned and
fenced (see below). `NewSessionModal` and `LaunchAsyncFlightModal` are the
reference implementations.

## Running the gates

There is no CI. The ladder, from `dev/local-quality-gates.md`:

```bash
pnpm preflight   # format:check + lint:src + vitest + tsc/vite build
pnpm check       # preflight + e2e + sidecar:check + tauri-schema + rust:check + rust:test
```

Individual gates, for iterating:

```bash
pnpm lint                 # eslint over src/ and e2e/
pnpm build                # tsc --noEmit equivalent + vite build
pnpm test                 # vitest (unit, stores, AND the scripts/ fences)
pnpm e2e                  # Playwright, web-mode only — not the Tauri shell
pnpm rust:check           # cargo check
pnpm rust:test            # cargo test
pnpm sidecar:check        # install + build + 13 protocol/provider smoke scripts
pnpm check:tauri-schema   # generated bindings are current
```

Choose by what you touched: Rust command/provider/state changes need
`rust:check` + `rust:test`; `agent-sidecar/` or protocol changes need
`sidecar:check`; shared DTO changes need `check:tauri-schema`. Release-facing
work climbs the whole ladder, then `pnpm release:readiness`.

> **Tip:** `vitest` runs `src/**/*.{test,spec}.{ts,tsx}` **and**
> `scripts/**/*.{test,spec}.{mjs,ts}`. The `scripts/*.test.mjs` files are
> filesystem fences that walk the whole source tree; they are why `pnpm test`
> can fail without any test file near your change.

## Traps

Ordered by how much time they cost when they bite.

**`CLAUDE.md` and `AGENTS.md` are gitignored.** A repo-wide refactor, a
`git grep`, or a "rename every occurrence" sweep silently skips both. They must
also stay byte-identical below the H1. Edit one, copy it to the other, verify
with `diff <(tail -n +2 CLAUDE.md) <(tail -n +2 AGENTS.md)`.

**`src-tauri/.cargo/config.toml` may redirect the build output.** On the
maintainer's machine it sets `[build] target-dir` to a path outside the repo. It
is local-only (excluded via `.git/info/exclude`), and Cargo discovers it from
its *working directory*, not from `--manifest-path` — which is why
`check-tauri-schema.mjs` runs cargo with `cwd: src-tauri`. Bundles will not be
where you expect if you ignore this.

**Startup order in `lib.rs::run()` is load-bearing.**
`core::shell_path::fix_path_for_gui_launch()` calls `std::env::set_var`, which
is only sound while the process is single-threaded, so it must remain the very
first statement — before `init_tracing()` starts its log-writer thread.
Mutating the environment after another thread exists corrupts it such that a
later PTY `fork()`+`exec()` aborts in the child. Then, in order:
`migrate_data_dir` → `migrate_mission_to_flight` → panic hook →
`reprice_historical_costs` → `reap_orphaned_pty_children` →
`recover_flights_on_startup`. Each depends on the data directory having settled.

**The PTY allowlist is closed.** `commands/pty.rs` accepts only `claude`,
`codex`, `opencode`, `packetcode`, the shells, and `ssh`. Matching is on the
*program name*, and on Windows a `.cmd` wrapper is spawned as
`cmd.exe /c <name>.cmd`, which changes how the process tree is killed.

**`src/lib/tauri.ts` is the only place that calls `invoke`.** Adding one in a
component works at runtime and will be rejected in review; there is no
type-level safety net for it, only convention.

**Cost is a control input, not a dashboard.** The cost-reporting surface was
removed on 2026-07-31; there is no `CostDashboardView`. Spend is measured to
enforce budget guardrails at launch. Do not resurrect a dollar readout.

**The autonomous planner is gone.** Removed July 2026 (~13,300 net lines).
`planner_*` fields on DTOs remain read-compatible so old records hydrate
losslessly. Flight planning is a normal read-only conversation whose
`packetbench-flight-plan` block you apply. Do not rebuild the runtime.

**No API-agent row uses a subscription login.** Every keyed row uses an API key
from the OS keyring. `api-claude-oauth` is a historical id for the Claude Agent
SDK on `api-key-anthropic`; `api-openai-codex` is retired. PTY `claude` /
`codex` panes keep their own CLI logins — that is ordinary end-user use and is
unaffected.

**Windows is the day-to-day dev platform.** Paths in comments and tests are
often Windows-shaped, and path normalisation matters. macOS and Linux builds
are supported but exercised far less; see `dev/multi-platform-build.md`.

## Documentation map

| File | Use it for |
| --- | --- |
| `CLAUDE.md` / `AGENTS.md` | canonical orientation (gitignored) |
| `backlog.md` | the master ledger of outstanding work — add items here |
| `ROADMAP.md` | Now / Next / Later product direction |
| `CHANGELOG.md` | shipped history only, never a task list |
| `dev/README.md` | planning index, runbooks, archive |
| `dev/local-quality-gates.md` | the gate ladder in full |
| `dev/multi-platform-build.md` | macOS / Linux build |
| `HANDOFF.md` | current restart point and build evidence |

Put new open work in `backlog.md`. Do not let a finished planning document
become a task register.

## Next

- [Invariants & tripwires](agent-invariants.html) — read this before editing
  memory, scope keys, provider routing, or anything under `.agents/`.
- [Architecture](dev-architecture.html) — how a turn actually flows.
- [Testing & gates](dev-testing.html) — what each suite covers.
