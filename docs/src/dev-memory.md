# Memory internals

The memory layer is the part of PacketBench with the most subtle invariant in
the codebase: **search and injection are two different scorers, on purpose, and
widening one must never widen the other.** This page explains the whole
subsystem — what gets captured, where it persists, how scope keys are minted,
and how a brief actually reaches a model's prompt.

For the user-facing behaviour, see [Memory](memory.html).

## Four kinds of memory

There is no single "memory store". There are four surfaces with four different
persistence models.

| Kind | Type | Lives in |
| --- | --- | --- |
| Memory events | `MemoryEvent` (`src/types/memory.ts:62`) | `state.v1.json` → `memory_events` |
| Learned patterns | `LearnedPattern` (`src/types/memory.ts:92`) | `state.v1.json` → `memory_patterns` |
| Project notes | Markdown files | `<project>/.agents/memory/*.md` |
| Memory settings | plain object | localStorage `packetbench:memory-settings` |

> **Note:** Memory events and patterns are **not** in localStorage, which
> surprises people. `saveMemorySlice` (`src/stores/memoryStore.ts:446`) invokes
> `save_memory_slice`, which lands in `storage::save_memory`
> (`src-tauri/src/core/storage.rs:743`) and writes into the one
> `~/.packetbench/state.v1.json` the rest of the app shares.

### Event types

`MemoryEventType` is `session_completed | task_completed | flight_completed |
manual_note` (`src/types/memory.ts:5`). `task_completed` is dead on write — the
autonomous task scheduler that emitted it was removed in July 2026, and the type
and its renderer survive only so pre-removal persisted events still deserialize.

### One write bypasses the slice

`toggle_pinned_pattern` mutates the pattern in place inside
`state.memory_patterns` and only bumps `state.version` **on a hit**
(`src-tauri/src/core/storage.rs:758`): an unknown id must not rewrite the file
and must not bump the version, so the save is conditional.

### In-process only

Two pieces of state are deliberately never persisted:

- `injectedPatternsByFlight` (`src/stores/memoryStore.ts:938`) — a flight that
  only settles in a later app run simply goes unrerated. Best-effort by design.
- `learningSessions` (`src/stores/memoryStore.ts:944`) — a per-session
  enrichment guard that replaced a global `isLearning` boolean.

## The load-bearing invariant: search ≠ injection

There are two scorers in `src/stores/memoryStore.ts`. They look similar. They
are not interchangeable, and conflating them is a prompt-safety regression, not
a search-quality regression.

### `relevanceScores` — injection

`src/stores/memoryStore.ts:486`.

- Tokenizer `relevanceTokens` (`:470`): lowercase, split on `/[^a-z0-9]+/`,
  **drop tokens shorter than 3 characters**, drop `RELEVANCE_STOPWORDS`.
- Matching is **exact token-set membership only** — `set.has(t)`. No stemming,
  no prefixes, no substrings, no camelCase splitting, no acronym expansion.
- Score is matched IDF over total IDF, with `idf = log(1 + n/df)`. Query terms
  present in no candidate are excluded because they do not discriminate.
- A degenerate query returns all zeros, so the caller falls back to
  confidence-based ordering.

### `corpusRelevanceScores` — Ask / search

`src/stores/memoryStore.ts:632`. Returns `{ score, matched[] }` per candidate.

- Tokenizer `corpusTokens` (`:556`): keeps **2-character** tokens, splits
  camelCase and PascalCase, and expands a small acronym table
  (`CORPUS_ACRONYMS`, `:527`: pty, acp, mcp, idf, dto, sdk, cli, tofu, ssh, ade).
- Per-term weight is best-rule-wins (`termWeight`, `:608`): exact token `1`,
  stem match `1`, prefix `0.75`, raw substring `0.5`, else `0`.
- A degenerate query does **not** return zeros — it falls back to whole-phrase
  substring scoring.
- Final score is `coverage * 0.8 + (phrase ? 0.2 : 0)`, clamped to `[0,1]`,
  where `phrase` means the candidate contains the verbatim lowercased query.
  The headroom is reserved so the phrase bonus is visible even when coverage
  saturates at 1, which is the common case for short queries.

It tokenizes from the **original casing** on purpose: lowercasing first would
destroy the camelCase boundaries `corpusTokens` splits on, so a `SshConfig` query
would never yield `ssh` + `config` (`:639`).

### The contract, in the source's own words

`src/stores/memoryStore.ts:628`:

> Deliberately separate from `relevanceScores`, which stays the injection
> scorer: widening what Ask can find must never widen what gets injected into an
> agent's prompt. Nothing on the injection path calls this.

### Who calls which

| Scorer | Callers |
| --- | --- |
| `relevanceScores` | `computeContextItems` (patterns `:1074`, lessons `:1123`, project notes `:1189`) and the Timeline search `searchMemoryEvents` (`:709`) |
| `corpusRelevanceScores` | `searchMemoryCorpus` in `src/lib/memorySearch.ts:300` — and nothing else |

### The tests that pin it

Three files, and they are the tripwire. Do not "fix" a failure here by relaxing
the assertion.

`src/stores/__tests__/corpusRelevance.test.ts:63` —
*"leaves the injection scorer narrow — the two must never be conflated"*:

```ts
expect(relevanceScores("auth", ["authentication uses JWT"])[0]).toBe(0);
```

`src/stores/__tests__/corpusRelevance.test.ts:94` —
*"still leaves the injection scorer untouched by any of this"*:

```ts
expect(relevanceScores("SshConfig", ["the ssh config record"])[0]).toBe(0);
expect(relevanceScores("pseudoterminal", ["the PTY exited"])[0]).toBe(0);
```

`src/stores/__tests__/memoryBriefs.test.ts:246` — the end-to-end gate,
*"widens Ask without widening injection"*: a fixture set containing a
0.3-confidence pattern, a 10-day-old flight, a 3-day-old session and a manual
note asserts the brief does **not** contain the low-confidence item while Ask
returns all five kinds.

`src/lib/__tests__/memorySearch.test.ts` adds a per-rule pin for each injection
limit search deliberately defeats: low-confidence unpinned (`:100`), beyond the
cap of 10 (`:106`), outside the 7-day window (`:114`), outside the 48-hour
window (`:120`), manual notes the injection path never surfaced at all (`:126`),
flight `whatFailed` (`:133`), and "applies no character budget to the result
list" (`:211`).

> **Warning:** If you make Ask smarter, the change belongs in
> `corpusRelevanceScores` or in `src/lib/memorySearch.ts`. If a change to Ask
> makes you want to touch `relevanceScores`, stop — that is the exact regression
> the tests above exist to catch.

## Scope keys

A memory record's `projectPath` is not always a filesystem path. It is a scope
key:

| Scope | Format | Example |
| --- | --- | --- |
| Local | plain normalized path | `d:/projects/packetbench` |
| Remote | `ssh:<serverId>:<remotePath>` | `ssh:srv-7:/home/ian/work/api` |
| Workspace (read-side alias only) | `workspace:<id>` | `workspace:ws-3` |

`normalizePath` (`src/stores/memoryStore.ts:30`) converts backslashes to
slashes, collapses `//`, strips trailing separators (keeping a bare `/`) and
lowercases. Before that existed, `C:\foo` and `c:/foo/` were different scopes
and silently dropped memory under `exact` matching.

### One choke point

Every new record's `projectPath` is stamped by `memoryWriteKey`
(`src/stores/memoryStore.ts:355`):

```ts
export function memoryWriteKey(input: MemoryScopeInput): string {
  const scope = normalizeScopeInput(input);
  if (scope.kind === "ssh" && scope.serverId) {
    return remoteMemoryProjectKey(scope.serverId, scope.remotePath || scope.projectPath);
  }
  return scope.projectPath;
}
```

Its four callers are the four capture sites: `captureFlightCompleted` (`:1292`),
`captureManually` (`:1351`), `learnFromSession` (`:1364`), and `refreshPatterns`
(`:1476`).

> **Important:** This function exists because remote memory used to be empty by
> construction — all four capture sites stamped a plain local path. If you add a
> fifth capture site, it stamps through `memoryWriteKey` or it is a bug.

`memoryAuxScopeArg` (`:371`) is literally `return memoryWriteKey(input)`. The
comment explains why it is a separate name rather than a call: the stamped scope
and the attributed scope must never disagree, and having one name per role makes
a future divergence obvious in review.

`workspace:<id>` is a **read-side alias only** and is deliberately never written
by `memoryWriteKey` (`:329`): stamping it today would sever every local record
from its project path. `src/stores/__tests__/memoryRemoteScope.test.ts:67` pins
that.

### The isolation rule

`createProjectScopeMatcher` (`src/stores/memoryStore.ts:998`) is the read side.
Under an ssh scope it matches only by exact key identity. Under a **local**
scope, line `:1028` is the whole security property:

```ts
if (isMemoryScopeKey(recorded)) return false;
```

Without it, `global` matching — and any `parent` prefix collision — would pull
another server's remote memory into a local project's brief, which is the one
thing ssh isolation must never allow.

The three match modes (`exact` / `parent` / `global`) are documented at `:989`
and configured in `src/stores/memorySettingsStore.ts:14`.

### Where scope comes from

- `deriveMemoryScope` (`src/lib/memoryScope.ts:50`) is the single derivation
  from a workspace. Line `:80` says it plainly: *"Remote. Never fall back to the
  local mirror — that fallback IS the bug."*
- Reads go through the `useMemoryScope` hook (`src/hooks/useMemoryScope.ts:13`).
- Writes go through `writeScopeForWorkspace` / `memoryScopeForWorkspace`
  (`src/lib/memoryWriteScope.ts:22`). Every writer resolves scope from a
  workspace id it already holds, never from "whatever workspace is active right
  now".

`src/lib/__tests__/memoryScope.test.ts:34` asserts a remote scope
`JSON.stringify` contains no trace of the local project name.

### Rust-side validation

`validate_memory_scope` (`src-tauri/src/commands/mod.rs:85`) enforces non-empty,
under `MAX_MEMORY_SCOPE_LEN`, no NUL, and — if the key starts with `ssh:` —
that both halves are present, so a bare `"ssh:"` cannot be used to skip
validation entirely. Otherwise it defers to `validate_project_path`.

> **Note:** `summarize_session` and `extract_patterns` use it;
> `summarize_flight` still calls `validate_project_path`
> (`src-tauri/src/commands/memory.rs:182`), which is why
> `enrichFlightRetrospective` gates itself to local scopes
> (`src/stores/asyncFlightStore.ts:1000`). That asymmetry is real, not a
> documentation slip.

## How a brief reaches a prompt

`composeMemoryBrief` (`src/stores/memoryStore.ts:1757`) is the only producer of
injected memory. Injection is **entirely frontend TypeScript** — the Rust side
never assembles or injects a memory brief.

### The brief

```
## PacketBench Memory Brief
Use this project memory when relevant. Prefer current repository files over stale notes.

<patterns>       ← relevanceScores reorders; pinned always first
<lessons>        ← flight retrospectives, 7-day window
<sessions>       ← session summaries, 48-hour window
<project notes>  ← .agents/memory, local scopes only
```

Group order is fixed (`:1791`). `pushLine` measures the whole joined text before
appending; on overflow it sets `truncated = true` and **breaks out of the group
loop entirely** — later groups are dropped, not squeezed. Each line is
whitespace-collapsed and capped at 260 characters.

Character budget: `clampBriefChars` — default **1800**, floor 400, ceiling 4000
(`src/stores/memoryStore.ts:294`, constants at `:105`).

### Per-source eligibility (`computeContextItems`, `:1041`)

| Source | Gate | Cap |
| --- | --- | --- |
| Patterns | `pinned \|\| confidence >= 0.6` | `contextMaxPatterns`, default 10 |
| Lessons | flight completed within 7 days | `contextMaxLessons`, default 5 |
| Sessions | within 48 hours, `summary !== null` | `contextMaxSessions`, default 5 |
| Project notes | none (but ssh scopes get `[]`) | `MAX_CONTEXT_PROJECT_NOTES = 5` |
| `manual_note` | **no branch at all — never injected** | — |

For patterns, relevance only *reorders*; it never admits. The blend is
`0.6 * relevance + 0.4 * confidence`, with pinned patterns sorted first.

Project notes are filtered by `projectNotesFor` (`:1223`), which returns `[]`
for ssh scopes: `.agents/memory` is read off *this* machine's filesystem, so it
can only ever belong to a local scope.

### The three call paths

**1. API conversation launch** — `agentTaskStore.createApiConversation`. The
system-prompt assembly order is documented at
`src/stores/agentTaskStore.ts:1099`, lowest in the prompt to highest:

1. `AGENTS.md` / `CLAUDE.md` from the project root (local only)
2. The PacketBench memory brief, gated on `memoryContextEnabled`
3. The profile or explicit `systemPromptOverride` — last, so it wins conflicts
   of intent

The toggle is **per-conversation**, named `memoryContextEnabled`, surfaced as
the "Memory" row in `src/components/agents/chat/HeaderOverflowMenu.tsx:263`.
Defaults differ by entry point: `false` for `/new` inheritance and for plan
mode, `true` for async flight launches.

**2. Async flight launch** — `composeAsyncLaunchPrompt`
(`src/stores/asyncFlightStore.ts:801`), gated on the `injectIntoFlightPrompts`
memory setting (opt-out). It carries a scope-agreement guard: a mixed local/ssh
fan-out, an ssh fan-out spanning two servers, or disagreeing paths gets **no
brief rather than an arbitrary one**.

**3. Preview only** — `AgentChatPane` and `HeaderOverflowMenu` recompute the
same brief for display. `memoryBriefStats` (`:81`) derives its counts from *the
same* `composeMemoryBrief` call the launch pipeline uses, so previews cannot
overstate what will actually be sent. The token estimate is
`Math.round(brief.text.length / 4)`.

> **Note:** `getContextForSession` (`:1718`) is the older Markdown-preview
> renderer with no character budget. MemoryView abandoned it
> (`src/components/views/MemoryView.tsx:287`); it survives mostly as a mocked
> seam in around twenty test files.

## Capture

| Trigger | Site |
| --- | --- |
| PTY exit / pane unmount | `src/hooks/useTerminalSession.ts:338` and `:481` |
| Flight settle | `src/stores/asyncFlightStore.ts:979` |
| Manual note | `captureManually` |

Session capture is gated on `tab.durationMs > MIN_MEMORY_CAPTURE_MS`
(`10_000`, `src/hooks/useTerminalSession.ts:81`). The comment at `:331` records
the bug this replaced: gating on `!wasRequested` meant every ordinary way of
ending a session skipped capture, which is why the Memory pane stayed empty.

`learnFromSession` (`src/stores/memoryStore.ts:1361`) is deliberately two-phase
— the event is written and persisted **before** the summarization call, so the
Timeline is populated even when no aux provider is configured, the model returns
junk, or the call hangs. Transcript input is trimmed to the last 4000 characters
and the call is bounded by `SUMMARIZE_TIMEOUT_MS = 60_000`.

### Pattern distillation

Two triggers, both landing in `refreshPatterns`
(`src/stores/memoryStore.ts:1470`):

- **Automatic**, after each successful session summary, when
  `summariesSinceLastRefresh >= patternRefreshThreshold` (default **3**). That
  counter is rebuilt from persisted data on hydrate (`:1267`) — it used to reset
  to 0 every launch, so the threshold in practice was never reached.
- **Manual**, the Refresh button in the Memory pane.

The distillation corpus is the **last 10** scoped items, joined by `\n---\n`,
and includes session summaries *plus* manual notes *plus* flight
summary-and-lessons — because a user whose memory consisted of notes and
retrospectives could otherwise never extract a single pattern. Results are kept
at `confidence >= 0.5`, sliced to `maxPatterns` (default 20), stamped with the
write key, and merged with previously-pinned patterns.

### Confidence rerating

`CONFIDENCE_BUMP = 0.05`, `CONFIDENCE_DECAY = 0.1`, floor `0.1`, ceiling `1`
(`src/stores/memoryStore.ts:908`). Asymmetric on purpose: a burned pattern loses
trust faster than an unproven one earns it. Applied at flight settle; a `paused`
(all-cancelled) flight clears provenance without rerating.

## The auxiliary LLM seam

Summarisation, pattern extraction and flight retrospectives do not use the
conversation providers. They go through `src-tauri/src/core/aux_llm.rs`, which
exists as a **compliance boundary** as much as a convenience: everything routes
through the in-process `LlmProvider` trait against an OS-keyring `api-key-*`
credential, and *no path in the module can reach a subscription-OAuth provider*
(`src-tauri/src/core/aux_llm.rs:14`).

- `AuxTaskClass` has 16 classes; the memory ones are `MemoryScan`,
  `SessionSummarize`, `PatternExtract` and `FlightRetrospective`
  (`aux_llm.rs:91`), wire ids `memory-scan`, `session-summarize`,
  `pattern-extract`, `flight-retrospective`.
- **There is no fixed model.** `resolve_aux_route` (`:338`) honours a per-task
  pin, else auto-selects the *cheapest configured* candidate from
  `AUX_PROVIDERS` (`:214`): `claude-haiku-4-5`, `o4-mini`, `MiniMax-M2`,
  `anthropic/claude-haiku-4-5` via OpenRouter, and `qwen3:32b` on Ollama.
  Ranking is priced from `shared/model-pricing.json` at 20 000 input / 1 500
  output tokens; unpriced models rank last and are *never* treated as free.
- Ollama has `needs_api_key: false`, so it is never auto-selected — a local
  daemon that happens to be running should not silently become the summariser.
- Turn shape (`build_request`, `:474`): one user message, **no tools**, thinking
  disabled, `max_tokens = 8192`, `temperature = 0.2` so a re-run of the same
  input produces the same draft.
- Ollama connection failures get exactly one retry after 2 s and then a typed
  error with **no cloud escalation**.
- Every aux turn appends to `~/.packetbench/usage.jsonl` with `source: "aux"`.

## Project notes on disk

`src-tauri/src/commands/project_memory.rs` owns `<project>/.agents/memory`. The
module header states the design: the repository derives its graph and revisions
from files. There is no side database and no implicit migration of the global
memory corpus.

Constants (`project_memory.rs:25`): schema version 1, at most 2 000 notes,
256 KiB per note, 4 KiB per query, 20 search results, 600-character excerpts.

### File format

YAML frontmatter plus Markdown body:

```markdown
---
schemaVersion: 1
id: 9f2c8a1e-...
title: Deploy checklist
createdAt: 1756400000
updatedAt: 1756400000
archived: false
tags: [ops]
provenanceIds: []
---
# Deploy checklist
...
```

Filename is `<slug(title)>-<id[..8]>.md`, slug lowercased alphanumeric with
dash-runs collapsed and capped at 60 characters.

A frontmatter-less `.md` file is still a legitimate note: id becomes
`md:<relative-path>`, title comes from the first `#` heading or the file stem,
timestamps from the filesystem, tags `["unmanaged"]`.

> **Warning:** The BOM is stripped before the `---\n` test
> (`project_memory.rs:407`). Without that, a Notepad- or PowerShell-written note
> silently degraded from managed to unmanaged: its real id vanished and
> update-by-id stopped resolving.

### Rejections are warnings, not failures

Every parse problem surfaces as a `ProjectMemoryWarning { relative_path, code,
message }` rather than failing the scan: `unreadable`, `symlink_rejected`,
`oversized`, `binary_rejected`, `empty`, `invalid_utf8`,
`malformed_frontmatter`, `unsupported_schema`, `invalid_metadata`, plus
scan-level `orphaned_backup` and `count_limit` and graph-level `duplicate_id`
and `ambiguous_link`.

The `empty` case is its own regression guard: a truncate-then-write editor's
zero-length file used to pass the frontmatter test and become a titled,
selectable ghost note that displaced the real one.

### Safety properties

- **Atomic writes.** `write_atomic` (`:656`) renames a `NamedTempFile` over the
  destination, so a reader sees either the old note or the new one, never a gap.
  It falls back to backup/remove/rename only when the rename fails, leaving a
  recoverable `.packetbench-backup`.
- **Confinement.** `memory_root` canonicalizes and re-checks
  `canonical.starts_with(&project)`; the update path re-verifies the parent.
  Callers never supply a file path — ids are resolved by scanning.
- **Optimistic locking.** A SHA-256 revision over the raw bytes. A mismatch
  yields "Project-memory conflict: the note changed outside PacketBench. Reload
  before saving."
- **Secret refusal on write.** `validate_content` rejects binary, oversize, and
  `suspected_secret` (PEM and OpenSSH headers plus a pattern match).

### The watcher

Trailing-edge debounce, 180 ms quiet period with a 1500 ms ceiling so a
continuous storm cannot starve refresh; emits `project-memory:changed`. At most
8 watchers with LRU eviction.

> **Note:** `watch_target` deliberately does **not** create the directory.
> Arming the watcher used to `mkdir -p .agents/memory`, so merely opening the
> Memory pane wrote a new untracked directory into every repository PacketBench
> touched.

### Link graph

`[[wiki]]` and `[text](file.md)` links are resolved by id, then title, then file
stem, producing `outbound_ids`, `backlink_ids`, `broken_links` and `orphaned`.

### Search

TF-IDF with `idf = ln((N+1)/(df+1)) + 1`, archived notes excluded. The perf
rewrite is documented at `:822` — the previous shape was
O(notes² × tokens-per-note × query-terms), which is to say a hang.

## Dead surfaces

Documenting these so nobody spends a day wiring up something that is already
wired to nothing.

**`search_project_memory`** is half dead. The Tauri command is registered and
`src/lib/tauri.ts:568` exports a `searchProjectMemory` wrapper — but nothing
calls the wrapper. The Ask tab uses the TypeScript `askMemory` path instead. The
underlying `search_project_memory_inner` *is* live, reached through the MCP
server (`src-tauri/src/mcp_server/mod.rs:480`) rather than through Tauri.

Everything else is live: `list_project_memory`, `create_project_memory`,
`update_project_memory`, `archive_project_memory` and `watch_project_memory` via
`src/stores/projectMemoryStore.ts`; `summarize_session` and `extract_patterns`
via `memoryStore`; `summarize_flight` via `asyncFlightStore`;
`toggle_pinned_pattern` and `save_memory_slice` via `memoryStore`;
`scan_codebase_memory` via `memoryStore.scanCodebase` (see below).

## Codebase scan

The Memory pane header's **Scan codebase** button →
`memoryStore.scanCodebase` → `scan_codebase_memory`. The command resolves the
`memory-scan` auxiliary route *before* touching the disk (no provider means no
filesystem read at all), then `core::aux_context::assemble_project_manifest`
walks the project under hard bounds — depth, entries, listed files, excerpt
count and bytes, and a 10s wall clock — skipping symlinks/junctions,
dot-entries, `SKIP_DIRS`, secret-shaped filenames and binary content. One
auxiliary turn turns that manifest into `[{path, summary}]`.

The command returns `CodebaseScanResult`: the model's raw `response` plus the
walk's own stats. `truncated` / `timedOut` come from `ScanStats`, never from
the model, because only the walk knows whether a bound clipped it — a partial
index is labelled `(partial)`, tagged `#partial`, says `PARTIAL:` in its body,
and leaves a caveat on the pane's status chip.

The result is stored as an ordinary `manual_note` whose `source` is
`codebase-scan` (`CODEBASE_SCAN_SOURCE`), so it needs no new persisted event
type and inherits Timeline, Ask/search and both exports; `refreshPatterns`
also treats it as pattern source material. It is deliberately NOT part of
`computeContextItems`, so a scan is searchable but not silently injected into
every launch brief. Re-running replaces the scope's existing scan note rather
than stacking near-duplicates, and the button reads "Re-scan codebase" once one
exists. Local scopes only — the walk reads this machine's filesystem, so the
button is disabled under a remote (`ssh:`) workspace.

## Agents reach memory over MCP too

`src-tauri/src/mcp_server/mod.rs` exposes `read_memory_context` (learned
patterns), `search_project_memory`, `read_project_memory`, and — gated on
`allow_writes` — `create_project_memory`, `update_project_memory` and
`archive_project_memory`, plus `packetbench://memory/patterns` and per-workspace
project-memory resources.

Every project-memory MCP tool resolves its path through
`local_workspace_path(&args.workspace_id)`: a workspace id, never a
caller-supplied path.

## Related

- [Memory](memory.html) — the user-facing pane
- [Invariants & tripwires](agent-invariants.html) — the search/injection split as a rule
- [Testing & gates](dev-testing.html) — where those tests run
