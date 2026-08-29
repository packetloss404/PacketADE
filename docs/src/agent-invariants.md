# Invariants & tripwires

Rules in this codebase that look like tidy-up opportunities and are not. Each
entry states the rule, why breaking it looks reasonable, what actually goes
wrong, and the test that fails when you try. If you are about to "simplify" one
of these, read its entry first.

> **Important:** Several of these are pinned by *filesystem fences* that walk
> the whole source tree, not by tests near the code they protect. A change in
> `src/components/` can fail a test in `scripts/`. That is deliberate.

## Memory: search and injection are separate scorers

**Rule.** `corpusRelevanceScores` powers **search** (the Ask box). It matches by
exact token, stem, prefix, raw substring, camelCase split and a small acronym
table. `relevanceScores` decides what memory is **injected into an agent's
system prompt**. It matches exact tokens only, drops two-character tokens, and
has none of the widening rules. Nothing on the injection path may call the
search scorer.

Both live in `src/stores/memoryStore.ts`.

**Why breaking it looks safe.** They are near-identical IDF scorers sitting
twenty lines apart, one of them strictly more capable. Collapsing them into one
function with a flag — or just calling the better one everywhere — is the
obvious refactor and removes real duplication.

**What actually goes wrong.** Search failing to find something costs the user a
second query. Injection matching too loosely silently pushes unrelated project
context into an agent's prompt: it burns tokens, dilutes the actually-relevant
patterns, and can carry material from a scope the user did not intend to share
with that agent. The scorers are asymmetric because the *cost of a false
positive* is asymmetric.

The injection path additionally has a confidence gate, per-source caps and
recency windows that search does not. "Widen the scorer" therefore also means
"bypass three other filters".

**Pinned by.**

- `src/stores/__tests__/corpusRelevance.test.ts` —
  *"leaves the injection scorer narrow — the two must never be conflated"*
  asserts `relevanceScores("auth", ["authentication uses JWT"])[0]` is exactly
  `0`, and *"still leaves the injection scorer untouched by any of this"*
  pins the same for camelCase splitting and acronym expansion.
- `src/stores/__tests__/memoryBriefs.test.ts` — *"widens Ask without widening
  injection"* builds a corpus that Ask finds and `composeMemoryBrief` must not
  include, then asserts the brief text contains none of it.

> **Note:** A curated synonym map was evaluated for search and **rejected**:
> against a held-out query set it recovered 0% of misses while inflating result
> sets 2.75x. The `CORPUS_ACRONYMS` table is expansions (facts about words), not
> synonyms (guesses about intent). Keep it short; do not let it grow into a
> synonym map. Embeddings were declined too — the measurement is in
> `backlog.md`.

## Memory capture never depends on an LLM

**Rule.** `learnFromSession` records the `session_completed` event **first**,
with `summary: null`, and persists it. Only then does phase 2 read the
transcript and ask a model for a summary, patching the same event in place.
Every failure in phase 2 leaves the phase-1 event intact and surfaces the
reason in the Memory header.

**Why breaking it looks safe.** Writing an event with a null summary and then
mutating it is awkward. Building the complete record once — summarise, then
append — is cleaner code and produces the same result on the happy path.

**What actually goes wrong.** Summarisation is a network call to a provider the
user may not have configured. Making the record depend on it means a machine
with no API key silently records nothing at all: the Memory timeline stays
empty, and the user has no way to tell whether nothing happened or everything
was dropped. It also means one wedged call can starve every later session.

Three guards ride along with the ordering: a per-session in-flight set (so two
panes closing together are both recorded, and a hung enrichment does not block
later sessions), an idempotence check against existing events (the natural-exit
path and the unmount path can both fire for one session), and scope resolved
exactly once at the top so the stamped key and the aux-LLM argument cannot
disagree.

**Pinned by.** `src/stores/__tests__/memoryStoreSettings.test.ts`:

- *"records the session even when the summarizer rejects"* — mocks
  `summarizeSession` to reject with "no API key is configured" and asserts the
  event exists with `summary: null`.
- *"records the session but skips the LLM when summarization is disabled"* —
  asserts `readPtyTranscript` is never called and the event is still there.
- *"records a session only once even if capture fires twice"*.

## Scope keys have exactly one write choke point

**Rule.** Every memory record's `projectPath` field is stamped by
`memoryWriteKey` in `src/stores/memoryStore.ts`, and by nothing else.

| Scope | Key written |
| --- | --- |
| local | the plain filesystem path, unchanged |
| ssh | `ssh:<serverId>:<normalized remote path>` |
| workspace | **never written** — read-side alias only |

`memoryAuxScopeArg` is defined as `memoryWriteKey` by design, so the stamped
scope and the scope attributed to the aux-LLM call cannot drift apart.

**Why breaking it looks safe.** There are only four capture sites. Formatting
the key inline at each one is two lines and saves an import.

**What actually goes wrong.** That is precisely how remote memory used to be
empty *by construction*: all four sites stamped a plain path, so nothing ever
matched an `ssh:` scope on read. The bug is invisible — capture succeeds,
retrieval silently returns nothing — and it reappears the moment a fifth site
is added by hand.

The `workspace:<id>` half matters too. It is matched by
`createProjectScopeMatcher` but deliberately never stamped: writing it today
would sever every local record from its project path, breaking parent matching
and every path-shaped display, in exchange for an affordance nobody has asked
for yet.

**Pinned by.** `src/stores/__tests__/memoryRemoteScope.test.ts` — *"keys a
remote scope by server + path and leaves a local scope as its path"*, *"never
stamps a workspace key for a local scope"*, *"prefers remotePath over the
mirrored projectPath"*, *"stamps a session and a flight retrospective with the
same key"*, and *"hands the aux-LLM command the scope label, not a stale local
path"*. Retrieval symmetry is pinned separately: same path on a different
server, and a different path on the same server, must both miss.

## Nothing writes `.gitignore`, and watching never creates `.agents/memory`

**Rule.** No PacketBench operation writes, creates or modifies a project's
`.gitignore`. Separately, arming the project-memory watcher must not create the
`.agents/memory` directory — only an actual note write may create it.

**Why breaking it looks safe.** Both look like courtesies. The app writes
`.agents/memory` into the user's repository; adding an ignore entry (or at
least making sure the directory exists so the watcher has something to watch)
seems considerate, and `memory_root(path, true)` was right there.

**What actually goes wrong.**

`.gitignore` is the user's file and often a reviewed, shared one. Silently
appending to it puts an unexplained diff in someone's next commit, and the
decision of whether project memory is committed belongs to the project, not to
the tool. It is a one-line change that a tool has no standing to make.

The watcher half is a real regression that shipped: because arming the watcher
called `memory_root(project_path, true)`, merely **opening** a project created
a new untracked directory in it — visible in `git status`, in every repository
PacketBench touched, including ones that had never opted into project memory.
`watch_target` is now read-only and falls back to the nearest existing
ancestor.

**Pinned by.** `src-tauri/src/commands/project_memory.rs`:

- `no_project_memory_operation_ever_touches_gitignore` — runs create, update,
  archive, list and search against a project with a `.gitignore` present, then
  byte-compares the file.
- `project_memory_never_creates_a_gitignore` — the absent-file half.
- `a_gitignored_agents_directory_still_reads_and_writes_normally` — `.agents/`
  being ignored changes nothing, and we still do not "fix" the ignore file.
- `resolving_a_watch_target_never_creates_the_memory_directory`.

## `issueStore.assignToFlight` is the authoritative write

**Rule.** The Flight↔Issue link is owned by `issue.flightId`.
`flight.issueIds` is a derived array. On every hydrate,
`flightStore.reconcileIssueIdsFromIssues` rebuilds each flight's `issueIds`
from `issueStore`. Call both at UI sites — `addIssueToFlight` is the optimistic
paint — but never rely on `addIssueToFlight` alone.

**Why breaking it looks safe.** You are on the Flight screen, you have the
flight in hand, and `addIssueToFlight(flightId, issueId)` reads exactly like
the right call. The UI updates immediately and looks correct.

**What actually goes wrong.** A one-sided `assignToFlight` self-heals — the
next reconcile rebuilds the flight's array from the issue record. A one-sided
`addIssueToFlight` **silently vanishes** on the next hydrate, because the
reconcile sees no issue naming that flight and writes an empty array over your
addition. The failure surfaces after a restart, far from the code that caused
it.

Deletion mirrors this from the other side: `flightStore.deleteFlight` walks
`flight.issueIds` and calls `assignToFlight(id, null)` before dropping the
flight, and `unlinkDeletedIssueFromFlights` does the same when an issue is
deleted, so no flight is left holding a dangling id.

**Pinned by.** `src/stores/__tests__/flightStore.test.ts` — *"reconciles flight
issueIds from issue flight assignments"* creates a flight carrying
`issueIds: ["stale_issue"]` with no matching issue record and asserts the
reconcile wipes it to `[]`. *"reconciles issue links after backend hydration"*
asserts the reverse: an issue naming a flight repopulates that flight's array
even when the persisted flight arrived with an empty one.
`flightDeleteCleanup.test.ts` pins the unlink-on-delete direction.

## The repository fences in `scripts/`

Three `*.test.mjs` files walk the entire source tree looking for banned idioms.
They run under `pnpm test` alongside ordinary unit tests, so a violation
anywhere in `src/` fails the suite regardless of what you were working on.

They exist because each banned shape *reads as correct* and survives review.
A unit test would only catch the one call site it covers; a fence catches the
next one too.

> **Note:** Each fence caches file contents at module scope. They used to
> re-read the tree per assertion, taking 9–25 s alone and blowing vitest's 5 s
> default under a full parallel run — failing with timeouts rather than
> assertion failures, on a different set of tests each time. Do not reintroduce
> per-assertion tree walks. Each fence declares a 30 s timeout.

### `confirm-idiom.test.mjs` — no native `window.confirm`

**Rule.** No source file may call the global `confirm`. Destructive
confirmations go through `src/components/ui/ConfirmDeleteModal.tsx`.

**Why breaking it looks safe.** `if (confirm("Delete this?"))` is one line, has
no imports, and works.

**What actually goes wrong.** It is unstyled, blocks the entire webview, renders
as OS chrome that does not name the application, and cannot be asserted on in a
component test — so any deletion path guarded by it is untestable.

**How it is matched.** The regex is
`/(?<![\w$.])(?:(?:window|globalThis|self)\??\.)?confirm\s*\(/`, applied after
blanking quoted spans and comments per line. The lookbehind keeps it off
`showConfirm(`, `onConfirm(`, `reconfirm(` and `dialog.confirm(`. The fence
pins both directions: eight true-positive shapes (bare call, `window.`,
`globalThis.`, `self.`, optional chaining, spaced call, not-first-line, after a
stripped string) and ten false positives it must ignore (test titles containing
the word, identifiers ending in it, comments, user-facing copy, a URL in a
string). That second half is not decoration — an earlier version matched any
`confirm (` outside a comment and made a test *title* fail the build.

### `attempt-provider-mapping.test.mjs` — never strip `api-`

**Rule.** No source file may derive a backend provider id from an agent-config
id by stripping the `api-` prefix. Every attempt or session spec resolves it
through `attemptProviderFor` in `src/lib/attemptRouting.ts`.

**Why breaking it looks safe.** `agentConfigId.replace(/^api-/, "")` produces
the correct provider for seven of the eight executors. It is obviously right at
a glance.

**What actually goes wrong.** It is wrong for the **default** one:
`api-claude` → `"claude"`, which the Rust `get_provider` dispatch rejects. The
real mapping is not a prefix strip at all — `api-claude` → `anthropic`,
`api-claude-oauth` → `claude-oauth`, `api-packetcode` → `packetcode-acp`,
`api-custom` → `custom`. `AttemptTargetSpec.provider` is forwarded verbatim by
`src-tauri/src/commands/flight_attempts.rs` into `start_api_agent_session`, and
neither the sidecar nor the Rust dispatch knows anything about agent-config ids.

There is a second reason the identity map keeps entries for retired rows:
dropping `api-openai-codex` would send every legacy Codex conversation through
the unknown-agent fallback and bill it to the user's Anthropic key. Identity
still resolves; only routing is withdrawn.

**How it is matched.** True positives include the regex `replace`,
`replaceAll`, a spaced variant, and `slice("api-".length)`. False positives it
must ignore include `startsWith("api-")` (classification, not derivation),
comments describing the ban, an unrelated `replace(/^cli-/, "")`, and the
helper being used correctly. The fence also asserts the helper exists and that
`src/components/flights/pickedToSpec.ts` and `src/stores/asyncFlightStore.ts`
still import it, so a silent revert to an inline derivation drops the import
and shows up.

`src/lib/__tests__/attemptRouting.test.ts` is the single allowlisted file — it
demonstrates the broken derivation in order to assert the helper diverges from
it.

### `workspace-agents-boundaries.test.mjs` — the Workspace/Agents split

**Rule.** Three boundaries, all matched across the whole tree:

1. New GUI-agent creation stays out of Workspace entry surfaces. No file may
   call `addDraft(`, and `WorkspaceView.tsx`,
   `WorkspaceCreationModal.tsx` and `AddSessionPicker.tsx` may not reference
   `launchConversation`, `API_PROVIDERS`, `addConversationPane` or
   `useAgentTaskStore` at all.
2. Saved conversation panes stay *read*-compatible with no new attachment
   producer: `openSession(`, `addConversationPane`,
   `ensureConversationWorkspace`, `attachConversationToWorkspace`,
   `openConversationAlongsideWorkspace` and `DraftTile` must appear nowhere.
   `sessionGlue.ts` must still export `openConversationInAgents` and
   `removeConversationPanes`.
3. Every secondary native window stays on the reviewed Monitor path: no Rust
   file outside `commands/monitor_windows.rs` may use `WebviewWindowBuilder`,
   no frontend file may use `new WebviewWindow`, and
   `src-tauri/capabilities/monitor.json` must scope to `["monitor-*"]` while
   carrying none of `shell:default`, `fs:default` or `process:default`.

**Why breaking it looks safe.** Each individual addition is small and useful —
a "new agent" button on the workspace screen, a helper that attaches a
conversation to the current workspace, a second window for a preview.

**What actually goes wrong.** Together they re-couple two engines that were
deliberately separated, and they materialise wrapper workspaces around
conversations that should be able to exist without one. The third boundary is a
security posture, not an architecture preference: the Monitor window is
read-only, and that is enforced at the invoke boundary
(`command_allowed_for_window`) and in its capability file, not by hiding
buttons in its frontend.

## `CLAUDE.md` and `AGENTS.md` are gitignored twins

**Rule.** The two files must be byte-identical except for their H1
(`# PacketBench — CLAUDE.md` vs `# PacketBench — AGENTS.md`). Both are listed
in `.gitignore` and are untracked.

**Why breaking it looks safe.** Nothing enforces it. There is no test, no
fence, and no CI. A repo-wide rename or refactor appears to have succeeded
because `git status` is clean.

**What actually goes wrong.** Being gitignored means:

- `git grep`, `git ls-files`, and any tool that respects `.gitignore` — which
  is most of them, including `rg` by default — **skip both files**. A sweep
  that renames a symbol everywhere leaves the two most important orientation
  documents in the repository stale, and nothing flags it.
- They are not in the history, so drift between them cannot be spotted in a
  diff and cannot be recovered from an earlier revision.

Both files carry the same warning in their own preamble, which is the only
place it is recorded in-repo.

**How to check.** There is no automated pin. Do it by hand after any edit:

```bash
diff <(tail -n +2 CLAUDE.md) <(tail -n +2 AGENTS.md) && echo "in sync"
```

Edit one, then copy it over the other. They were last reconciled against source
on 2026-08-27.

## Shorter tripwires

Same class, less to say about each.

**Store isolation is lint-enforced.** `agentTaskStore` and `workspaceStore` may
not import each other, in either direction, per `no-restricted-imports` rules
in `eslint.config.js`. `sessionGlue.ts` is the only bridge. The point is that a
conversation without a tile stays a first-class citizen.

**`src/generated/tauri-schema.ts` is generated.** It comes from the ignored
`export_api_bindings` test in `src-tauri/tests/api_schema.rs`. Hand-editing it
passes `tsc` and fails `pnpm check:tauri-schema`, which regenerates and
byte-compares. Note that the check runs cargo with `cwd: src-tauri`, because
Cargo discovers `.cargo/config.toml` from its working directory rather than
from `--manifest-path`.

**MCP trust is frozen per session.** Sidecar protocol v11 takes an
`mcpTrustSnapshot` at session start, so editing Settings mid-session cannot
widen a running agent's server, tool or root authority. Re-reading live
settings inside the session loop would undo the entire point.

**`fix_path_for_gui_launch()` must stay the first statement in
`lib.rs::run()`.** It calls `std::env::set_var`, sound only while the process is
single-threaded. Moving it after `init_tracing()` — which starts a log-writer
thread — corrupts the environment such that a later PTY `fork()`+`exec()`
aborts in the child with "crashed on child side of fork pre-exec".

**Never hardcode the product name.** Import from `src/lib/brand.ts` or
`src-tauri/src/core/brand.rs`. The `LEGACY_*` constants there are one-shot
migration inputs for the immediately-prior name only; do not add a third
generation, and do not "clean up" the `packetcode` classification logic in
`migration.rs` — it exists to avoid destroying a *live sibling product's* data
directory.

## Next

- [Agent orientation](agent-guide.html) — layout, command/binding workflow,
  gates and traps.
- [Memory internals](dev-memory.html) — the mechanism behind the first four
  entries here.
- [Testing & gates](dev-testing.html) — what each suite covers and when to run
  it.
