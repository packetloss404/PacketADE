# Contributing

There is no `CONTRIBUTING.md` in the repository and no pull-request template.
The conventions live in `CLAUDE.md` / `AGENTS.md`, in the linters, in four
repository fences, and in the commit history. This page collects them.

## Orientation first

`CLAUDE.md` at the repository root is the canonical orientation document:
project structure, key conventions, the nine-row provider table, the sidecar
protocol, entry-point resolution, and the auth probe. Read it before your first
change.

> **Important:** `CLAUDE.md` and `AGENTS.md` are byte-identical except for their
> `# H1`, and **both are listed in `.gitignore`**. Repo-wide sweeps never touch
> them and nothing flags when they drift from source. If you edit one, copy it
> over the other by hand. They were last reconciled against source on
> 2026-08-27.

The planning surfaces are separate and should not be conflated:

| File | Role |
| --- | --- |
| `README.md` | Public overview and setup |
| `ROADMAP.md` | Direction: Now / Next / Later |
| `backlog.md` | The master ledger for outstanding work |
| `dev/README.md` | Canonical planning index; plans, runbooks, archives |
| `CHANGELOG.md` | Shipped history **only** — never a task list |

New open items go in `backlog.md`. Do not let an old planning doc become a task
register.

## Naming and brand

The product has been renamed twice: PacketCode → PacketADE → **PacketBench**
(2026-08-26, commit `5404fb85`).

> **Warning:** Never hardcode `"PacketBench"`, `"packetbench"` or
> `"packetbench:"`. Import from `src-tauri/src/core/brand.rs` (Rust) or
> `src/lib/brand.ts` (TypeScript) so the next rename is a one-file change
> instead of a ~400-file churn.

The `LEGACY_*` constants in those files point at the *immediately prior* name
only (`packetade`, `.packetade`, `packetade:`) and exist solely to migrate
keyring secrets, the data dir and localStorage forward on first launch. The
earlier `packetcode` migration has already run.

Expect lingering references to both old names in historical files (mostly
`dev/archive/` and `docs/reports/`), in comments, and in one-shot migration
code. All **new** code uses PacketBench.

> **Note:** The GitHub repository has been renamed to
> `git@github.com:packetloss404/PacketBench.git`. The old `PacketADE` URL still
> redirects, so an existing clone keeps working, but it prints a "This
> repository moved" notice on every push — run
> `git remote set-url origin git@github.com:packetloss404/PacketBench.git` to
> clear it. "PacketCode" now belongs to the sibling TUI project at
> `D:\projects\packetcode`; do not create a junction or symlink back to either
> old path.

## Vocabulary

**Flight, not Mission.** The left-nav surface is labelled "Flight Deck" and work
units are "Flights". The `CoreView` route is `"flights"`, rendered by
`FlightsView.tsx`. "Mission" survives only in intentional persisted-data
compatibility aliases — there is even a startup migration
(`core::migration::migrate_mission_to_flight`) that canonicalises leftover
`missionId` keys. Use Flight terminology in all new code.

**Provider id, not agent-config id.** `api-claude` is an `AgentCli`;
`"anthropic"` is a provider id. They are different vocabularies and one is not
derivable from the other. See [Agent event contract](dev-agent-contract.html).

## Where things go

| Adding | Put it |
| --- | --- |
| A view | `src/components/views/`, routed via the `AppView` union in `appStore.ts` |
| A Tauri command | `src-tauri/src/commands/`, register in `lib.rs`, add a TS binding in `src/lib/tauri.ts` |
| A Zustand store | `src/stores/`, `create<StoreInterface>()`, localStorage key via `storageKey()` |
| A modal | Use the shared wrapper in `src/components/ui/Modal.tsx`; `NewSessionModal` and `LaunchAsyncFlightModal` are the reference implementations |
| A shared constant | `src/lib/flight-colors.ts` (status/priority), `src/lib/time.ts` (formatting), `src/lib/colors.ts` (labels/priority) |

Registering a command without a TS binding leaves a dead surface. Several
already exist — see the list in [Memory internals](dev-memory.html) and the
report at the end of this page — and they cost real confusion.

## UI conventions

- **Theme tokens only.** Never raw Tailwind colours. Use `bg-bg-primary`,
  `text-text-secondary`, `text-accent-green` and friends.
- **Font sizes** are mostly `text-xs` (12px), with `text-[11px]` and
  `text-[10px]` for compact chrome.
- **Icons** are lucide-react, typically `size={12}` in toolbars and `size={14}`
  in headers.
- **No native `confirm()`.** Use `ConfirmDeleteModal`. This is fenced — see
  `scripts/confirm-idiom.test.mjs` and [Testing & gates](dev-testing.html).

## Architectural rules the linters enforce

These are not style preferences; breaking them fails a gate.

| Rule | Enforced by |
| --- | --- |
| `agentTaskStore` and `workspaceStore` may not import each other; `sessionGlue` is the only bridge | `no-restricted-imports` in `eslint.config.js` |
| No `window.confirm` / bare `confirm(` in `src/` | `scripts/confirm-idiom.test.mjs` |
| No deriving a provider id by stripping `api-` | `scripts/attempt-provider-mapping.test.mjs` |
| `WebviewWindowBuilder` only in `commands/monitor_windows.rs`; `new WebviewWindow` nowhere in the frontend | `scripts/workspace-agents-boundaries.test.mjs` |
| Workspace views may not reach into the Agents launch path | `scripts/workspace-agents-boundaries.test.mjs` |

## Rules the linters do **not** catch

- **`issueStore.assignToFlight` is the authoritative write** for the Flight ↔
  Issue link. `flightStore.reconcileIssueIdsFromIssues` rebuilds every flight's
  `issueIds` from `issueStore` on hydrate, so a one-sided `assignToFlight`
  self-heals while a one-sided `addIssueToFlight` silently vanishes on the next
  hydrate. Call both at UI sites — `addIssueToFlight` is the optimistic paint —
  but never rely on `addIssueToFlight` alone.
- **Always populate `SshConfig.host_fingerprint`** from
  `ServerConfig.hostFingerprint` so host-key pinning is enforced. Without it the
  Rust side falls back to TOFU `accept-new` and logs a warning.
- **Never persist tokens** in frontend state, workspace DTOs or ordinary files.
  Git-host and SSH credentials live in the OS keyring.
- **Do not revive the autonomous planner.** Its UI, FSM, journal and Rust /
  sidecar backend were removed in July 2026. Legacy `planner_*` DTO fields
  remain read-compatible only. Flight planning is a normal read-only
  conversation that the user applies.
- **Do not add a cost dashboard.** Spend is measured to *enforce* budget caps,
  not to present a running readout. `CostDashboardView` was removed on
  2026-07-31 on purpose.
- **Keep event names feature-scoped** — `insights:chunk`, `side-chat:chunk`,
  `api-agent:*`. Build names through the helpers in `src/lib/events.ts`, never
  by interpolation at a call site.

## Commit style

Conventional Commits, lowercase subject, imperative mood, optional scope. From
the recent history:

```
feat(memory): capture and retrieve memory for remote (SSH) workspaces
fix(dictation): harden capture, transcription, delivery and UI
docs(site): add a Markdown-sourced documentation site generator
test: make the filesystem fences deterministic under a full parallel run
chore: bump to 0.12.1
refactor: remove the Syndicate execution-target integration
```

Scopes in use include `memory`, `dictation`, `acp`, `aux`, `settings`,
`scripts`, `site`, `changelog`, `backlog`.

### Bodies do the real work

This repository's commit bodies are unusually substantial, and that is the
convention rather than an accident. A good body says **what was wrong, why the
obvious fix was wrong, and what was deliberately not done**. The `docs(site)`
commit that introduced this documentation site is a fair model: it explains the
one-dependency decision, why the output goes to `docs/guide/` (an earlier
iteration wrote over the marketing landing page), and that nineteen declared
pages were still unwritten.

Sign off agent-assisted commits with the trailer already in use:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

## Before you push

```bash
pnpm preflight    # format:check, lint:src, test, build
```

For anything touching the backend, the sidecar, provider routing, persisted
state shapes or generated contracts, climb further:

```bash
pnpm check        # + e2e, sidecar:check, check:tauri-schema, rust:check, rust:test
```

> **Warning:** Run the bare `pnpm test`, not `vitest src`. Scoping to a
> directory silently skips all four repository fences, because they are pulled
> in by the `scripts/**` glob in `vitest.config.ts`.

Match the gate to the change:

| Changed | Also run |
| --- | --- |
| `agent-sidecar/`, provider routing, protocol types, supervisor | `pnpm sidecar:check` |
| Shared contracts, generated types, persisted state, request/response payloads | `pnpm check:tauri-schema` |
| Backend commands, providers, state, orchestration | `pnpm rust:test` |
| Anything user-facing in the browser | `pnpm e2e` |

`dev/local-quality-gates.md` is the canonical ladder document — and note that it
is itself covered by `format:check`, so editing it with the wrong Prettier
formatting breaks `preflight`.

## Documentation changes

This site is Markdown in `docs/src/`, rendered by `node scripts/build-docs.mjs`
(`pnpm docs:build`) into `docs/guide/`. The output directory is deliberately
*not* `docs/` — an earlier iteration wrote `index.md` straight over the
marketing landing page at `docs/index.html`.

To add a page: create `docs/src/<name>.md` starting with a single `# Title`,
then add an entry to `docs/src/nav.json` with `page`, `title` and
`description`. `##` and `###` headings become the on-this-page rail, so make
them specific. A page declared in `nav.json` with no Markdown file is reported
as missing and skipped rather than failing the build.

Callout syntax is a blockquote opening with a bolded keyword:

```markdown
> **Note:** …
> **Tip:** …
> **Warning:** …
> **Important:** …
```

## Reviewing

The bar this codebase actually holds itself to, judging by the comments left
behind in it:

- **Explain the failure mode, not the fix.** Nearly every non-obvious line in
  `src-tauri/src/lib.rs`, `storage.rs` and `apiAgentListeners.ts` carries a
  comment naming the bug it prevents. That is what makes the ordering
  constraints survivable.
- **Prefer a fence to a comment** when the wrong shape is one that *survives
  review* — a plausible idiom that is correct in most instances and quietly
  wrong in one.
- **A test that pins a deliberate narrowness is not redundant.** The
  injection-scorer assertions in `src/stores/__tests__/corpusRelevance.test.ts`
  exist to make a future "improvement" fail loudly.
- **Say what you did not do.** The changelog entries and commit bodies here name
  their gaps explicitly. That is why the 0.12.1 entry can be trusted.

## Related

- [Architecture](dev-architecture.html) — the shape you are contributing to
- [Testing & gates](dev-testing.html) — every gate in detail
- [Invariants & tripwires](agent-invariants.html) — the rules that look safe to break
- [Agent orientation](agent-guide.html) — the machine-facing version of this page
