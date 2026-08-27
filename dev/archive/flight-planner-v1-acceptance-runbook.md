# Flight Planner v1 — Live Acceptance Runbook

Operator-facing manual validation. Run this before signing off on a v1
release of the Flight Planner work-stream
([`flight-planner-plan.md`](./flight-planner-plan.md)).

Status: **active manual acceptance runbook**. Current open Flight Planner work
belongs in [`../../backlog.md`](../../backlog.md); the locked design remains reference.
For the dedicated reliability sprint, pair this manual runbook with
[`flight-planner-reliability-continuity-pack.md`](./flight-planner-reliability-continuity-pack.md).

- **Time budget**: 15–20 minutes end-to-end.
- **Mode**: real Claude Sonnet 4.6 OAuth (`api-claude-oauth`). No mocks.
- **Scope**: validates the headline acceptance test plus three regression
  guards (stop hygiene, approval gate, journal export).
  The continuity pack adds cold-start approval hydration, rate-limit replay,
  journal scale, compaction, and async collision gates.

If any **Pass / fail criteria** in §7 are missed, the build does not ship.

---

## 1. Preconditions

All boxes must be ticked **before** opening the app.

- [ ] Claude CLI is logged in:
  - File exists: `~/.claude/.credentials.json` (macOS/Linux) or
    `%USERPROFILE%\.claude\.credentials.json` (Windows).
  - The Anthropic auth badge on the Agents pane shows **ready** (green).
    If it shows `login_required`, run `claude login` in a terminal and
    wait for the badge to flip — `auth_watcher` should pick it up within
    ~2 seconds.
- [ ] The test workspace has **zero existing flights** in the Flights
      view, OR you are running against a fresh workspace
      (`%USERPROFILE%\.packetbench\workspaces\<fresh-id>\`). Existing flights
      hide the empty-state CTA we need to verify.
- [ ] The app is running, either:
  - Dev: `pnpm tauri dev` from `D:\projects\PacketADE`, **or**
  - Release: a freshly installed build from `pnpm tauri build` artifacts.
- [ ] Browser devtools console is open (right-click → Inspect, Console
      tab). You will watch for red errors throughout.
- [ ] The sidecar log directory exists and is writable:
      `%USERPROFILE%\.packetbench\logs\`. Leave a `Get-Content -Wait` tail
      open on the newest `sidecar-*.log` in a side terminal — most
      troubleshooting starts here.
- [ ] You have ~10 minutes of uninterrupted attention; the headline test
      alone can take ~5 minutes once the planner starts decomposing.

---

## 2. Test 1 — Happy path acceptance

This is the §"Acceptance — the headline test" in
`flight-planner-plan.md`. If this one passes, the bulk of the
sign-off is done.

- [ ] **2.1** Click the **Flights** icon in the left sidebar (or use the
      view shortcut if you have one bound). The `FlightsView` mounts.
- [ ] **2.2** Verify the empty state:
  - A single large **Start a flight** CTA is centered in the pane.
  - A smaller **Quick async launch** link sits below it.
  - No flight cards are listed.
  - _Expected: this is the new spec-mode empty state, not the legacy
    `LaunchAsyncFlightModal` button._
- [ ] **2.3** Click **Start a flight**. Within ~1 second the
      `FlightDetailPane` mounts and shows a `FlightSpecPane` chat surface.
  - The flight appears in the sidebar with status pill `spec`.
- [ ] **2.4** Within **5 seconds**, one of:
  - A "Planner is starting…" indicator appears and then disappears, OR
  - The first assistant greeting message renders.
  - _If neither appears after 10s, jump to §6 "Planner is starting…
    never advances"._
- [ ] **2.5** Type the locked test prompt verbatim:
  ```
  Build a dark-mode toggle for the app
  ```
  Press **Cmd/Ctrl+Enter** to submit. The user message appears in the
  chat history.
- [ ] **2.6** The planner replies conversationally (1–3 paragraphs).
      Common shapes:
  - A clarifying question (where in the UI? does it persist?), OR
  - A short confirmation + a single clarifying question.
  - _Expected: it does **not** start calling `create_milestone` yet —
    Launch hasn't been clicked. If it does, that's a regression._
- [ ] **2.7** Reply to the clarification:
  ```
  Make it persist via localStorage and toggle from the top-right of the header.
  ```
  Submit.
- [ ] **2.8** The planner acknowledges the spec, usually summarising it
      back. The **Launch flight** button in the header should now be
      enabled (per E3 — disabled until the planner has spec context).
- [ ] **2.9** Click **Launch flight**. Start a stopwatch (or note the
      wall-clock time).
- [ ] **2.10** Within **30 seconds** of clicking Launch, all of the
      following must be visible in the `FlightDetailPane`:
  - [ ] Flight status pill transitions: `spec → planning → active`.
        (You may not catch `planning` if decomposition is fast; that's fine
        as long as you end on `active`.)
  - [ ] `MilestonesCard` shows **2–4** milestone cards with titles +
        goals.
  - [ ] **4–10** task rows total across those milestones, each with a
        prompt visible (truncated is OK).
  - [ ] At least **one** task is in `running` state and shows an
        executor session id (short hash) attached.
  - [ ] The **Journal** tab badge increments; clicking into it shows
        chronological entries: a `user_message`, one or more
        `planner_message`, and multiple `tool_call` entries
        (`create_milestone`, `create_task`, …).
  - [ ] The `StatGrid` shows:
    - **Planner cost**: non-zero, typically **$0.10–$0.50**.
    - **Exec cost**: may be **$0.00** if executors haven't fired their
      first `turn_summary` yet. This is acceptable for Test 1; Test 4
      will revisit if it stays $0.00 long-term.

If all 6 sub-bullets of 2.10 fire within 30s, Test 1 **passes**.

---

## 3. Test 2 — Stop / restart hygiene

Validates the kill-switch and that flight state survives a planner stop.

- [ ] **3.1** With the Test 1 flight still in `active`, click **Stop
      planner** in the `FlightDetailPane` header.
- [ ] **3.2** A `window.confirm` dialog appears. Click **OK**.
- [ ] **3.3** Within ~2 seconds:
  - [ ] The **Compacting** pill (if it was visible) clears.
  - [ ] The planner session is removed from the sidecar registry — the
        tail on `sidecar-*.log` should show a `close_session` event for the
        planner session id.
  - [ ] The Stop planner button disappears or transitions to
        **Start planner** (depending on whether flight is terminal).
- [ ] **3.4** Flight state survives:
  - [ ] All milestones still listed.
  - [ ] All tasks still listed, with their executor sessions still
        running (their session pills don't go grey).
  - [ ] The Journal tab still shows the prior entries.
- [ ] **3.5** _(Optional)_ Click **Start planner** (or reload the app
      and reopen the flight). The planner re-attaches and emits a
      `planner_message` acknowledging resume. Cold-start spec behaviour:
      per the locked spec, flights in `active` on app restart flip to
      `paused` and require a manual resume — that's expected.

Test 2 **passes** if 3.3 and 3.4 both hold.

---

## 4. Test 3 — Approval gate

Validates `request_user_approval` and the `<PlannerApprovalGate>`
banner.

- [ ] **4.1** Return to the Flights view. Click **Start a flight**
      again to begin a fresh flight.
- [ ] **4.2** Type the deliberately-oversized prompt:
  ```
  Refactor the entire codebase from React to Vue, build full e2e Playwright tests
  for every page, and document every public API in JSDoc.
  ```
  Submit and let the planner reply once (it will likely warn about
  scope; that's fine).
- [ ] **4.3** Click **Launch flight**.
- [ ] **4.4** Within ~60 seconds, the `<PlannerApprovalGate>` banner
      should appear, citing a reason near the 60-task ceiling — the
      planner is calling `request_user_approval` with a question like
      _"Scope likely exceeds the 60-task ceiling — proceed in phases or
      reduce scope?"_ with selectable options.
  - _Expected event chain: planner emits `tool_call:request_user_approval`
    → Rust returns sentinel `pending_approval:<id>` → banner mounts._
- [ ] **4.5** Click one of the options (recommend "Reduce scope" to keep
      the test bounded).
- [ ] **4.6** The banner clears, and within ~10s a new
      `planner_message` appears acknowledging the choice. Flight status
      remains `active` or transitions to `active` if it was `planning`.

Test 3 **passes** if the banner renders **and** clicking an option
visibly unblocks the planner.

---

## 5. Test 4 — Journal export

Validates the on-disk journal artifact.

- [ ] **5.1** Open the Test 1 flight. Click the **Journal** tab.
- [ ] **5.2** Entries are ordered chronologically (oldest first) and
      each row shows a kind marker:
  - `user_message`, `planner_message`, `tool_call`, `tool_result`,
    `wake_trigger` should all be represented after Test 1.
- [ ] **5.3** Click **Export**. A toast or inline notice confirms the
      path was copied to clipboard. Expected path shape:
      `~/.packetbench/missions/F-<TAIL>_<flight_id>.md` (or
      `%USERPROFILE%\.packetbench\missions\F-<TAIL>_<flight_id>.md` on Windows),
      where `<TAIL>` is the uppercased last-4-chars shortId derived in
      `core/flight_journal.rs::journal_path` (mirrors `FlightsView.tsx::shortId`).
      _Note: the `missions/` directory literal is an intentional on-disk
      back-compat retention — the journal dir is not renamed to `flights/`._
- [ ] **5.4** Paste the path into a terminal (or your file explorer)
      and open the file in any markdown viewer (VS Code preview, Obsidian,
      glow, etc.).
  - [ ] The file opens without parse errors.
  - [ ] Headings render (flight title, milestones).
  - [ ] Conversation entries are readable; tool calls render as fenced
        blocks with the tool name + args.

Test 4 **passes** if the file is on disk, the path is on the clipboard,
and the markdown is human-readable.

---

## 6. Troubleshooting

Common failure modes encountered during dogfooding.

### "Planner is starting…" never advances

- **Sidecar didn't start.** Check `~/.packetbench/logs/sidecar-*.log` for
  the most recent entry. If you see _"node entrypoint not found"_ the
  resource-dir resolution failed — fall back to `pnpm tauri dev` and
  retry.
- **OAuth expired.** Look for `401 Unauthorized` in the sidecar log.
  Re-run `claude login` from a terminal and wait for the auth badge to
  flip to **ready** before re-clicking _Start a flight_.
- **Protocol-version mismatch.** Sidecar log warns
  `protocol version mismatch: expected 6, got N` (or a later expected version
  if the protocol has advanced again). Rebuild the sidecar:
  `pnpm sidecar:install && pnpm sidecar:build` then restart the app.

### No milestones populate after Launch

- Open the **Journal** tab. If there are **no `tool_call` entries**, the
  planner didn't receive the `[LAUNCH]` wake-trigger. Verify in the
  sidecar log that an `inject_user_turn` with `kind=launch` was emitted.
- If `tool_call` entries exist but milestones don't render, check the
  browser console for store-update errors in `flightPlannerStore.ts`.
- Verify the system prompt loaded all 8 wake-trigger kinds (search
  `dev/flight-planner-plan.md` for `compaction_resume` — the prompt
  must enumerate every wake kind the wake-bus can emit).

### Stop planner button missing

The button only renders for **in-flight** planners. If the flight is
already terminal (`done`, `failed`, `cancelled`) the header shows a
status-only label. Confirm the flight status pill — if it's `done`,
that's working as intended.

### Approval gate doesn't appear (Test 3)

The planner may have decided the scope was achievable without an
approval call. Re-prompt with more explicit scope-bloat language, e.g.
_"Do all of the above as a single flight with no phasing and no scope
cuts."_ If after two attempts the gate still doesn't fire, file an
issue tagged `flight-planner/approval-gate`.

### StatGrid Exec cell stuck at $0.00

This was a known peer-review concern during E8. The executor cost
accumulator should populate after the first executor turn emits a
`turn_summary` event (usually within 1–2 minutes of an executor
starting). If after **5 minutes** with executors actively running it
remains $0.00, **the wiring has regressed** — file an issue and block
sign-off until fixed.

### Compaction never fires

E10's compaction threshold is **150K cumulative input tokens**. Short
flights (like the dark-mode toggle) won't hit it. To exercise
compaction, run a long flight with a verbose spec chat (5+ user
messages) and many decomposition turns. This is not blocking for v1
sign-off unless you're explicitly verifying E10.

### Browser console shows red errors

- `Failed to invoke 'forward_inject_user_turn'`: protocol-version
  drift (see "Protocol-version mismatch" above).
- `Cannot read properties of undefined (reading 'plannerSessionId')`:
  a flight DTO is missing the new fields — confirm
  `core/flight.rs` has `#[serde(default)]` on the new fields and that
  any pre-existing flights migrate cleanly. Treat as blocker.

### Sidecar log shows `RateLimitError`

Expected behaviour: planner transitions to `QuotaPaused`, exponential
backoff kicks in (60s → 10min), a desktop notification fires, and the
planner auto-resumes on `retry-after`. If the planner does not
auto-resume after the backoff window, file an issue.

---

## 7. Pass / fail criteria

Sign-off requires **all** of the following:

- [ ] **Test 1** (happy path) passes within 30 seconds of clicking
      Launch, with all 6 sub-checks in §2.10 green.
- [ ] **Test 2** (stop hygiene) leaves the flight in a recoverable
      state — milestones and tasks survive, executor sessions keep
      running.
- [ ] **Test 3** (approval gate) renders `<PlannerApprovalGate>` and
      clicking an option visibly resumes the planner.
- [ ] **Test 4** (journal export) produces a readable markdown file
      on disk at `~/.packetbench/missions/F-<TAIL>_<flight_id>.md`.
- [ ] **Zero red errors** in the browser devtools console across all
      four tests.
- [ ] **Zero Rust panics** in the sidecar/Tauri stderr (`backend log`
      or the dev terminal running `pnpm tauri dev`).

If any one of these fails, do not sign off. Capture the symptom + the
relevant log excerpt and proceed to §8.

---

## 8. Rollback procedure

If sign-off fails:

1. Identify the failing epic(s) from the symptom (E1–E10 mapping is in
   `flight-planner-plan.md` §"Epics").
2. `git revert <commit-sha>` for the offending epic commit(s). Prefer
   reverting whole epics over partial reverts — the epics are
   dependency-ordered.
3. `pnpm install && pnpm sidecar:install && pnpm sidecar:build` to
   bring deps back in line.
4. `pnpm tauri dev` and re-run this runbook from §1.
5. File an issue with:
   - Which test failed (§2–§5).
   - Which §6 troubleshooting bucket the symptom matched, or "new
     failure mode" if none.
   - Log excerpts from `~/.packetbench/logs/sidecar-*.log` and the
     Tauri stderr.
   - The reverted commit(s).

Do **not** re-attempt sign-off until the underlying epic has been
patched and a new commit landed on `main`.
