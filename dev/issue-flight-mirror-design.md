# Issue ⇄ Flight Two-Way Mirroring — Design (GP7 gate)

Created: 2026-07-25
Gates: [`github-pane-v9-loop.md`](./github-pane-v9-loop.md) → **GP7**. Code is
blocked on this design being reviewed — two-way sync is the one item in the loop
with real conflict/collision risk, so we land the model first.

## Goal

An opt-in per-Flight toggle: **"Mirror this Flight to GitHub/Gitea issues."**
When on, the Flight's work units are reflected as host issues and issue changes
are reflected back onto the Flight — without loops, duplicates, or clobbering
edits made on either side.

Host-agnostic: both GitHub and Gitea expose the issues API, so this rides the
existing `active_host_session` seam and the per-workspace host resolution.

## What exists today (do not rebuild)

- **One-way, manual:** `github/InvestigationPanel` hands a spec off to a Flight;
  there is no automatic issue creation/update.
- **Local bidirectional refs:** `flightStore.addIssueToFlight` +
  `issueStore.assignToFlight` keep Flight↔issue references in sync **inside the
  app** (the KANBAN linkage). These are local ids, not host issues.
- **Issue writes:** `github.rs` already has create/close/reopen/comment/labels/
  milestone, all host-routed (G8/G9). Reads: `github_list_issues`, `_get_issue`.

## The mapping decision (open — recommend option B)

What is a "Flight" on the host side?

- **A. One issue per Flight.** Simple, but a Flight is a container of milestones/
  attempts; a single issue is a poor fit for multi-task work.
- **B. (recommended) One issue per Flight *milestone/task*, grouped by a host
  milestone named after the Flight.** Matches the Flight → milestones → tasks
  shape; the host milestone gives a natural rollup. Closing a task closes its
  issue; the Flight's status is the milestone's rollup.
- **C. Free mapping via labels only.** Most flexible, least legible.

Recommend **B**, with **A** as a fallback for Flights that have no milestones
(mirror the Flight objective as a single issue).

## Identity & idempotency (the anti-duplicate spine)

Every mirrored entity carries a stable link in **both** directions:

- **App → host:** persist a `mirror` record on the Flight/task:
  `{ hostConnectionId, owner, repo, issueNumber, lastSyncedHostUpdatedAt, lastSyncedLocalRev }`.
- **Host → app:** stamp a hidden marker in the issue body,
  e.g. an HTML comment `<!-- packetade:flight=<flightId>;task=<taskId> -->`.
  On pull, this marker (not a title/label heuristic) authoritatively identifies
  which local entity an issue belongs to — so re-imports never duplicate.

Create is therefore: "does a `mirror` record exist? → update; else search the
host for the marker (recover from a lost local record) → adopt; else create."

## Change detection (avoid sync loops)

The classic two-way-sync trap is echo: app writes issue → webhook/poll sees the
change → app re-applies it locally → marks dirty → writes issue again.

Break it with **revision fences on both sides**, compared before every write:

- Local side: a monotonic `localRev` bumped on real user/agent edits only.
- Host side: the issue's `updated_at` (both hosts expose it).
- The `mirror` record stores the last-synced pair. A field is only pushed if
  `localRev > lastSyncedLocalRev`; only pulled if `host.updated_at >
  lastSyncedHostUpdatedAt`. After a successful sync, store the new pair. A write
  the app itself just made updates `lastSyncedHostUpdatedAt` immediately, so the
  echo poll is a no-op.

## Conflict model (both sides changed the same field)

When both fences advanced since the last sync for the **same field**:

- **Default: last-writer-wins by timestamp**, but **never silently discard** —
  record the losing value in a `mirror.conflicts[]` entry and surface a
  "Needs Attention" chip (reuse the flight-escalation attention surface) so the
  user can review. Title/state/labels use LWW; **bodies/descriptions are
  append-not-overwrite** (the larger blast radius) — on conflict, keep both with
  a separator rather than clobbering prose.
- No auto-merge of free text. Structured fields (state, labels, milestone,
  assignees) merge deterministically; prose does not.

## Sync triggers (pull side)

v1 uses **polling**, not webhooks (no inbound server): reuse the GP2
visibility-aware poller pattern (`useNotificationsPoller`) for mirrored Flights,
plus an explicit "Sync now" action. Webhooks are a later, larger effort (needs a
public callback) — out of scope.

## Phasing (each phase independently gated + shippable)

| Phase | Scope | Risk |
|---|---|---|
| **P0** | Data model only: `mirror` record on Flight/task + the body marker + a pure `diffMirrorState(local, host, lastSynced)` planner (which fields to push/pull, or conflict). **Fully unit-tested, no I/O.** | none |
| **P1** | **Push only** (app → host): create/update issues from Flight state on toggle + on local change, idempotent via the marker. One-way is safe (no echo problem yet). | low |
| **P2** | **Pull** (host → app): poll mirrored Flights, apply host changes through the fence, reflect state/labels/milestone back. | medium |
| **P3** | **Conflict resolution**: the conflicts[] surface + attention chip + the append-not-overwrite prose rule. | medium |

Ship P0+P1 first (useful on its own — auto-published issues), then P2, then P3.
Do **not** enable P2 without P0's planner being green.

## Host divergences to respect

- Gitea issue-label writes take **ids not names** (already handled by
  `resolve_gitea_label_ids`, G8) — the mirror's label sync must go through it.
- Gitea milestones exist; the "group by milestone" model works on both.
- The hidden body marker is host-neutral (both render issue bodies as text).

## Resolved decisions (2026-07-25)

The four open questions were reviewed and decided — P0 is now unblocked.

1. **Mapping → B (milestone-grouped).** One issue per Flight milestone/task,
   grouped under a host milestone named after the Flight; fall back to a single
   issue (option A) for Flights with no milestones.
2. **Conflict default → LWW-with-attention.** Structured fields (state, labels,
   milestone) resolve last-writer-wins by timestamp; the losing value is recorded
   in `conflicts[]` and raises a "Needs Attention" chip (nothing silently
   discarded). Prose bodies/descriptions **append both** with a separator rather
   than overwrite.
3. **Mirrored fields (v1) → title, state, labels, milestone.** Assignees and
   comment threads are deferred to a later phase (larger blast radius + cross-host
   identity matching).
4. **Poll cadence → reuse GP2's 60s visibility-aware poller**, paused when the
   window is hidden, plus an explicit "Sync now" action.

## GP7 status

Design + decisions are **locked**. Implementation is the phased P0→P3 plan
above; **P0** (the pure `diffMirrorState(local, host, lastSynced)` planner + the
`mirror` record/body-marker data model, fully unit-tested, no I/O) is the first
committable slice and can start now. Do not enable P2 (pull) until P0's planner
is green.
