# Packet Control — Evidence Layer (Phases 1–2)

Created: 2026-07-31
Status: **proposed — not started.** No CTL item is implemented.
Product decision: **Packet Control Phases 1–2 land in PacketBench**, not in
packetcode. Source proposal:
`D:\projects\packetcode\PACKETCOMPUTERS.md` (research, phase list, and the
Packet Computers half, which stays a packetcode proposal).

## Objective

Give PacketBench a trust-and-truth layer: a first-class workflow for proving a
claim with real captured evidence, so a user can ask not just "did you change
it?" but "prove it works."

A **control run** states a claim, executes a real workflow, captures artifacts,
judges the artifacts against the claim, and returns a verdict. Phases 1–2 cover
the evidence format and terminal-based verification only.

## Why PacketBench rather than packetcode

Evidence wants a viewer. A manifest, command output, snapshots, and a verdict
are cramped in a TUI and natural in a desktop app that already has
`DiffViewer`, `AttemptReviewGate`, and the Flight Deck. "Prove this attempt
actually works" is a review-gate input, so it slots into machinery PacketBench
already ships.

PacketBench also already has the execution substrate: local and SSH command
execution, `ServerConfig` with pinned host keys, and per-attempt worktrees.
Phases 1–2 need **no daemon and no new transport**.

## Scope boundary

The Packet family is four separate repositories. This loop touches one.

| Repo | Path | Role in this loop |
|---|---|---|
| **PacketBench** | `D:\projects\PacketADE` | **Implements CTL1–CTL9.** Owns the manifest schema. |
| packetcode | `D:\projects\packetcode` | Source of the proposal. No code change. If it later wants Control, it consumes CTL1's schema rather than defining a second one. |
| PacketAgent | `D:\projects\PacketAgent` | Independent evidence **producer** (see contract below). No code change in this loop. |
| PacketChat | `D:\projects\packetchat` | Unrelated (multi-user chat deployment). Out of scope. |

In scope: the evidence manifest, artifact storage, the terminal driver
(local + SSH), the approval gate, a Control run UI, and Flight/Attempt linkage.

Out of scope: browser QA (source Phase 3), desktop control (Phase 6), demo
video composition (Phase 5), and all of Packet Computers. Deferred
deliberately — the evidence contract must be stable before automation grows.

## Evidence-format contract

The single most important constraint: **PacketBench must end up with one evidence
format, not three.** Three producers already exist or are proposed, and they
currently share nothing:

1. **Control runs** (this loop) — PacketBench captures evidence by executing
   commands itself. New.
2. **PacketAgent returns** — `dev/bridgemind/packetagent-handoff-loop.md` PH8
   ("Evidence and return artifacts") ingests evidence produced by a remote
   PacketAgent run. In progress.
3. **PacketAgent validation records** — `ValidationEvidenceRecord`
   (`PacketAgent/src/store/types.ts:255`) is a *claim-level* record
   (`workspaceId`, `planItemId`, `requirementIds`, `title`, `status`,
   `evidenceUrl`, `capturedAt`). It is a pointer to evidence, not a capture
   bundle.

These are complementary, not competing, and the seam is clean: a Control run is
the *capture*; a `ValidationEvidenceRecord` is the *claim* that points at one
via `evidenceUrl`. CTL1 must make that projection lossless in one direction
(run → validation record).

Note the existing near-miss: `CoordinationArtifactRef`
(`src-tauri/src/core/flight.rs:620`) is only `id`/`label`/`uri`/`mime_type`. It
is a message attachment pointer and must **not** be widened into the evidence
bundle type — a control run should be referenceable *by* a
`CoordinationArtifactRef`, and no more.

### Verdict vocabulary

The source proposal lists six verdicts
(`confirmed | refuted | pass | fail | blocked | inconclusive`), but
`confirmed`/`pass` and `refuted`/`fail` are the same states under two intents.
Storing both invites drift.

**Decision to ratify in CTL1:** store five, and vary only the *display label*
by intent.

| Stored verdict | `verify` label | `qa` label | → PacketAgent `ValidationEvidenceOutcome` |
|---|---|---|---|
| `passed` | Confirmed | Pass | `passed` |
| `failed` | Refuted | Fail | `failed` |
| `blocked` | Blocked | Blocked | `pending` (+ detail) |
| `inconclusive` | Inconclusive | Inconclusive | `pending` (+ detail) |
| `pending` | Running | Running | `pending` |

`blocked` and `inconclusive` must stay distinct: blocked means the run could not
execute (missing tool, denied approval, unreachable host); inconclusive means it
executed but the artifacts do not settle the claim. Collapsing them is how an
evidence layer starts lying.

### Storage layout

Under the PacketBench data dir (`core::brand::DATA_DIR_NAME`, i.e. `.packetbench`)
— **never** `~/.packetcode`, which the source doc's layout specifies because it
was written for the TUI:

```text
<DATA_DIR>/control/<run-id>/
  manifest.json
  report.md
  steps/<step-id>/stdout.txt
  steps/<step-id>/stderr.txt
  snapshots/
```

## Execution contract

- Reuse existing execution paths. Local runs use the current command execution;
  remote runs build `core::execution::SshConfig` from `ServerConfig` at the call
  site, exactly as API-agent sessions and flight attempts already do.
- Always populate `SshConfig.host_fingerprint` from
  `ServerConfig.hostFingerprint`. A control run that silently fell back to TOFU
  would be evidence of unknown provenance.
- No daemon, no new listener, no new transport. If a control run needs a
  capability the current substrate lacks, that is a finding for Packet
  Computers, not a reason to grow this loop.
- Control runs execute **after explicit user approval**, and inherit existing
  permission semantics. Bounded autonomy is not weakened: a control run is
  never auto-triggered by an agent turn in Phases 1–2.

## Security contract

- **Captured output is evidence, not instructions.** Command output, file
  contents, and any later page text are untrusted data. No model judges a claim
  in Phases 1–2 (D1), but captured output is still summarized and displayed, and
  must never be spliced into system/developer instruction positions — that
  boundary has to exist before `verdict_authority: agent` is ever enabled.
- Redaction runs before persistence, reusing the existing provenance/trust
  envelope (`core::provenance::ProvenanceEnvelope`,
  `dev/bridgemind/trust-provenance-loop.md`) rather than a bespoke scrubber.
- Manifests must remain readable when optional capture tools are absent — a
  missing recorder degrades an artifact, never the run.

## Loop ledger

Status values: `queued` → `in-progress` → `gated` → `closed`.

| ID | Item | Acceptance condition | Gate | Depends on | Status |
|---|---|---|---|---|---|
| **CTL1** | Freeze the evidence contract | Rust + TS types for `ControlRun`, `ControlStep`, `ControlArtifact`, the five-value verdict, and `verdict_authority` (`rule`/`user`/`agent`, D1). Lossless projection run → `ValidationEvidenceRecord`. Documented non-widening of `CoordinationArtifactRef`. | Frozen fixture + round-trip and schema-stability tests | — | queued |
| **CTL2** | Core module and persistence | `src-tauri/src/core/control/` with manifest read/write under `<DATA_DIR>/control/<run-id>/`, atomic writes, and forward-compatible unknown-field retention. Retention caps and explicit reported pruning per D3, refusing to prune a run referenced by an `Attempt` without confirmation. | Manifest round-trip, corruption, and partial-write tests | CTL1 | queued |
| **CTL3** | Artifact store and redaction | Artifact capture with size caps, stable relative paths, and redaction through `ProvenanceEnvelope` before anything is written to disk. Oversize output is truncated in place and the truncation recorded in the manifest (D3) — never silently dropped. | Redaction, oversize-truncation, and missing-tool degradation tests | CTL2 | queued |
| **CTL4** | Terminal driver (local) | Execute a step locally; capture command, argv, cwd, exit code, stdout, stderr, start/end timestamps, and duration. Evaluate the D1 deterministic rules (expected exit code, required/forbidden output substrings); an unevaluable rule yields `inconclusive`, never `passed`. Cancellation leaves a valid manifest. | Driver unit tests plus a cancel-midway manifest-validity test | CTL2, CTL3 | queued |
| **CTL5** | Terminal driver (SSH parity) | Same driver over `SshConfig` built from `ServerConfig`, with `host_fingerprint` always populated. An unpinned host produces a `blocked` verdict, not a silent TOFU run. | SSH integration tests + unpinned-host refusal test | CTL4 | queued |
| **CTL6** | Approval gate | Every run requires explicit approval showing the exact commands, target (local/server name), and cwd before execution, and every run is user-initiated (D2) — attempt completion never proposes or starts one. Denial yields `blocked` with a reason. | Permission tests; no-auto-trigger regression test | CTL4 | queued |
| **CTL7** | Control run surface | A view listing runs with intent, claim, target, step progress, artifact count, and verdict badge; opens `report.md` and individual artifacts. Reuses the shared `Modal`/`DiffViewer` idioms and theme tokens. | Component tests + empty/failed/blocked-state coverage | CTL2 | queued |
| **CTL8** | Flight / Attempt linkage | A user can manually attach a completed control run to an `Attempt`, surfaced as `AttemptReviewGate` input (D2 — after-the-fact only). Attaching never auto-overrides a gate; a human or the existing reviewer still decides. | Store/DTO/migration tests; gate-override regression test | CTL7 | queued |
| **CTL9** | Convergence gate | Full frontend, Rust, and packaged gates; a real local run and a real SSH run against a configured server; confirmation that no second evidence format was introduced. | Release-like local/SSH/manual smoke | CTL1–CTL8 | queued |

## Sequencing

```text
CTL1 -> CTL2 -> CTL3 -> CTL4 -> CTL5 -----> CTL9
                          \-> CTL6 --------/
          \-> CTL7 -> CTL8 ----------------/
```

CTL7 may start once CTL2 lands — the UI needs the manifest type, not a working
driver. CTL9 is the product gate, not the first integration.

## Definition of done

- A user can state a claim, approve execution, and get a verdict backed by
  stored artifacts they can open.
- Runs work identically local and over SSH, with host-key pinning enforced.
- One evidence schema serves Control runs and projects cleanly onto
  PacketAgent's `ValidationEvidenceRecord`.
- A control run can inform an attempt's review gate without overriding it.
- No daemon, no new listener, and no weakening of bounded autonomy.

## Decisions — ratified 2026-07-31

### D1. Verdict authority: deterministic rules, user confirms

Phases 1–2 verdicts come from **deterministic rules only** — process exit code
plus optional user-supplied assertions (expected exit code, required or
forbidden substrings in stdout/stderr). The user confirms the resulting verdict
before the run is finalized. **No model judges a claim in Phases 1–2.**

The manifest records *who* decided, so a later model-judged mode can be added
without reinterpreting old runs:

```text
verdict_authority: rule | user | agent
```

Rationale: a verdict is the one field downstream consumers trust without
re-reading the artifacts, and it projects into PacketAgent's
`ValidationEvidenceRecord`, where records normally carry a human
`capturedByUserId`. Letting a model write that field before the reviewer-gate
interaction is settled would put model-generated status into another product's
provenance chain. Deterministic-first also means an evidence layer cannot
hallucinate a pass.

A rule that cannot be evaluated yields `inconclusive`, never `passed`.

### D2. Control runs are manually initiated in Phases 1–2

Attempt completion does **not** auto-propose or auto-start a control run. The
user starts every run explicitly.

Rationale: PacketBench deliberately withholds this class of autonomy —
`flight_attempts.rs` starts flights fresh and
`recover_never_resumes_bounded_autonomy_after_restart` exists on purpose.
Auto-running captured commands after an agent finishes work is exactly the
shape of that restriction. Attempt→run *linkage* (CTL8) stays manual and
after-the-fact: a user attaches a completed run to an attempt.

Revisit only as an explicit autonomy-policy change under
`dev/bridgemind/autonomy-policy-loop.md`, not as a Control convenience.

### D3. Bounded retention with visible pruning

Artifact storage is capped and the cap is user-visible. CTL2 specifies:

- a per-run artifact size cap, with oversize output truncated in place and the
  truncation recorded in the manifest (a truncated artifact is still valid
  evidence; a silently dropped one is not);
- a total `<DATA_DIR>/control/` budget and a run-count/age ceiling;
- pruning that is **explicit and reported** — the Control view shows what was
  removed and when, and pruning never deletes a run still referenced by an
  `Attempt` (CTL8) without confirmation.

Rationale: evidence that vanishes silently is worse than no evidence, because
a dangling reference looks like a capture that passed.

## Consequences folded into the ledger

D1 amends CTL1 (`verdict_authority` in the schema) and CTL4 (rule evaluation).
D2 amends CTL6 (no auto-trigger) and CTL8 (manual attach only). D3 amends CTL2
(caps, pruning) and CTL3 (in-place truncation). No new CTL rows were needed.
