/**
 * GP7 · P0 — Issue ⇄ Flight two-way mirroring: pure planner + data model.
 *
 * This module is intentionally I/O-free and clock-free (it never calls
 * `Date.now()` — every timestamp is passed in), so the whole sync policy is
 * unit-testable in isolation. The I/O layers (P1 push, P2 pull) sit on top of
 * `diffMirrorState` and never re-decide field policy themselves.
 *
 * Decisions locked in `dev/issue-flight-mirror-design.md` (2026-07-25):
 *  - Mapping B: one issue per Flight task, grouped under a host milestone.
 *  - v1 mirrored fields: title, state, labels, milestone.
 *  - Conflicts: last-writer-wins by record timestamp, losing value preserved in
 *    `conflicts[]` for a "Needs Attention" surface (nothing silently dropped).
 *  - Identity: an app-side `MirrorRecord` links to the issue, and a hidden HTML
 *    comment marker in the issue body authoritatively re-identifies the local
 *    entity on pull (so re-imports never duplicate).
 */

export type IssueState = "open" | "closed";

/** The v1 set of fields mirrored between a Flight task and a host issue. */
export interface MirrorFields {
  title: string;
  state: IssueState;
  /** Label names — compared as an order-independent set. */
  labels: string[];
  /** Milestone title, or `null` for "no milestone". */
  milestone: string | null;
}

export type MirrorFieldName = keyof MirrorFields;

/** Canonical field iteration order (stable output). */
export const MIRROR_FIELDS: readonly MirrorFieldName[] = [
  "title",
  "state",
  "labels",
  "milestone",
];

/**
 * Local (app) side snapshot. `updatedAt` (ms epoch) is the last-writer-wins
 * tiebreaker; `localRev` is the coarse monotonic fence used by
 * {@link hasPendingChange} to cheaply skip untouched pairs.
 */
export interface LocalMirrorState {
  localRev: number;
  updatedAt: number;
  fields: MirrorFields;
}

/** Host (GitHub / Gitea) side snapshot. `updatedAt` is the issue's ISO-8601 time. */
export interface HostMirrorState {
  updatedAt: string;
  fields: MirrorFields;
}

/** Per-field outcome of a diff. */
export type FieldAction = "push" | "pull" | "conflict" | "noop";

export interface FieldDecision {
  field: MirrorFieldName;
  action: FieldAction;
}

/** A conflict the user should review — the losing value is preserved. */
export interface MirrorConflict {
  field: MirrorFieldName;
  winner: "local" | "host";
  localValue: MirrorFields[MirrorFieldName];
  hostValue: MirrorFields[MirrorFieldName];
}

export interface MirrorPlan {
  /** One decision per field, in {@link MIRROR_FIELDS} order. */
  decisions: FieldDecision[];
  /** Fields (resolved values) to WRITE to the host. */
  toPush: Partial<MirrorFields>;
  /** Fields (resolved values) to APPLY locally. */
  toPull: Partial<MirrorFields>;
  /** Conflicts for the "Needs Attention" surface. */
  conflicts: MirrorConflict[];
  /** The agreed field snapshot both sides hold once this plan is applied. */
  resolvedFields: MirrorFields;
}

/**
 * The persisted app↔host link. `lastSynced*` form the base for the next 3-way
 * diff; `lastSyncedFields` is the agreed value snapshot at the last sync.
 */
export interface MirrorRecord {
  hostConnectionId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  /**
   * The local entity this issue mirrors. Optional because the record is
   * normally persisted positionally on the Flight/task — but the adopt path
   * (a record recovered from the body marker after the local link was lost)
   * uses these to re-link. See {@link resolveMirrorTarget}.
   */
  flightId?: string;
  taskId?: string;
  lastSyncedLocalRev: number;
  lastSyncedHostUpdatedAt: string;
  lastSyncedFields: MirrorFields;
  /** Accumulated unresolved-conflict log for the attention surface. */
  conflicts?: MirrorConflict[];
}

/** How a Flight task should reconcile with the host on this sync. */
export type MirrorTarget = "update" | "adopt" | "create";

/**
 * The identity trichotomy from the design's anti-duplicate spine, as a pure
 * decision so the P1/P2 I/O layers don't each re-implement it: an existing
 * `MirrorRecord` → **update** it; else a body marker was found on the host →
 * **adopt** that issue (recover a lost record); else → **create** a new issue.
 */
export function resolveMirrorTarget(
  record: MirrorRecord | null | undefined,
  markerFound: boolean,
): MirrorTarget {
  if (record) return "update";
  if (markerFound) return "adopt";
  return "create";
}

// ---- field equality ----

function labelsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}

/**
 * Type-safe dynamic field assignment. Written as a generic so TypeScript keeps
 * the key/value types correlated across a `MirrorFieldName` loop variable
 * (a plain `target[field] = value` collapses the union and won't type-check).
 */
function setField<K extends MirrorFieldName>(
  target: Partial<MirrorFields>,
  field: K,
  value: MirrorFields[K],
): void {
  // Copy array values (labels) so plan/record outputs never alias a caller's
  // input array — otherwise an in-place `labels.push()` on the input would
  // silently mutate the stored base and hide a real change from the next diff.
  target[field] = Array.isArray(value)
    ? ([...value] as MirrorFields[K])
    : value;
}

/** Value equality for one field (labels are set-compared; the rest are `===`). */
export function fieldEqual<K extends MirrorFieldName>(
  field: K,
  a: MirrorFields[K],
  b: MirrorFields[K],
): boolean {
  if (field === "labels") {
    return labelsEqual(a as string[], b as string[]);
  }
  return a === b;
}

/**
 * Last-writer-wins tiebreaker. `true` when the local edit is at least as recent
 * as the host's. An unparseable host timestamp resolves to local-wins (bias
 * toward the app's intent rather than a garbage host value); ties go to local
 * because the app is the actor initiating the sync.
 *
 * Resolution is **entity-granular**, not per-field: both hosts only expose an
 * entity-level `updated_at`, so every conflicting field in one plan resolves the
 * same direction. This is the best available signal, not a limitation to fix.
 */
function isLocalNewer(localMs: number, hostIso: string): boolean {
  const hostMs = Date.parse(hostIso);
  if (Number.isNaN(hostMs)) return true;
  return localMs >= hostMs;
}

/**
 * Cheap coarse gate: is there anything to sync at all? Uses the monotonic
 * fences so the poller can skip untouched pairs without a full field diff. A
 * bad host timestamp is treated as "changed" (conservative — do the real diff).
 *
 * ADVISORY ONLY — an optimization, not a correctness gate. It can false-negative
 * if a prior host-wins pull left `local.fields` diverged from `lastSyncedFields`
 * without bumping `localRev` (so callers MUST advance the local fence when
 * applying a pull). {@link diffMirrorState} against the stored base is the
 * authoritative decision; don't skip it based on anything but a genuine
 * both-fences-unchanged.
 */
export function hasPendingChange(
  record: MirrorRecord,
  local: LocalMirrorState,
  host: HostMirrorState,
): boolean {
  if (local.localRev > record.lastSyncedLocalRev) return true;
  const hostMs = Date.parse(host.updatedAt);
  const baseMs = Date.parse(record.lastSyncedHostUpdatedAt);
  if (Number.isNaN(hostMs) || Number.isNaN(baseMs)) return true;
  return hostMs > baseMs;
}

/**
 * The core 3-way field planner. For each mirrored field it compares the current
 * local and host values against the `base` (the last-synced snapshot):
 *
 *  - neither side changed            → noop
 *  - only local changed              → push
 *  - only host changed               → pull
 *  - both changed to the SAME value  → noop (converged independently)
 *  - both changed differently        → conflict, resolved last-writer-wins by
 *                                       record timestamp; losing value recorded
 *
 * Returns which fields to push/pull, the conflict log, and the agreed
 * post-sync field snapshot (`resolvedFields`). No I/O, no ambient clock.
 */
export function diffMirrorState(
  local: LocalMirrorState,
  host: HostMirrorState,
  base: MirrorFields,
): MirrorPlan {
  const decisions: FieldDecision[] = [];
  const toPush: Partial<MirrorFields> = {};
  const toPull: Partial<MirrorFields> = {};
  const conflicts: MirrorConflict[] = [];
  const resolved = {} as MirrorFields;

  const localNewer = isLocalNewer(local.updatedAt, host.updatedAt);

  for (const field of MIRROR_FIELDS) {
    const lv = local.fields[field];
    const hv = host.fields[field];
    const bv = base[field];
    const localChanged = !fieldEqual(field, lv, bv);
    const hostChanged = !fieldEqual(field, hv, bv);

    if (!localChanged && !hostChanged) {
      decisions.push({ field, action: "noop" });
      setField(resolved, field, lv);
    } else if (localChanged && !hostChanged) {
      setField(toPush, field, lv);
      decisions.push({ field, action: "push" });
      setField(resolved, field, lv);
    } else if (!localChanged && hostChanged) {
      setField(toPull, field, hv);
      decisions.push({ field, action: "pull" });
      setField(resolved, field, hv);
    } else if (fieldEqual(field, lv, hv)) {
      // both sides changed, but landed on the same value — nothing to do.
      decisions.push({ field, action: "noop" });
      setField(resolved, field, lv);
    } else {
      // genuine conflict → last-writer-wins by record timestamp.
      const winner: "local" | "host" = localNewer ? "local" : "host";
      if (winner === "local") {
        setField(toPush, field, lv);
        setField(resolved, field, lv);
      } else {
        setField(toPull, field, hv);
        setField(resolved, field, hv);
      }
      conflicts.push({ field, winner, localValue: lv, hostValue: hv });
      decisions.push({ field, action: "conflict" });
    }
  }

  return { decisions, toPush, toPull, conflicts, resolvedFields: resolved };
}

/**
 * Stamp a new base into a mirror record after a successful sync. The caller
 * supplies the POST-write fences: the host `updatedAt` returned by the issue
 * write (not the pre-write value — that's what makes the next echo poll a
 * no-op) and the local rev at sync time. Any conflicts are appended to the log.
 */
export function advanceMirrorRecord(
  record: MirrorRecord,
  next: {
    localRev: number;
    hostUpdatedAt: string;
    fields: MirrorFields;
    conflicts?: MirrorConflict[];
  },
): MirrorRecord {
  const merged: MirrorRecord = {
    ...record,
    lastSyncedLocalRev: next.localRev,
    lastSyncedHostUpdatedAt: next.hostUpdatedAt,
    // Copy labels so the stored base can't be mutated through the caller's array.
    lastSyncedFields: { ...next.fields, labels: [...next.fields.labels] },
  };
  if (next.conflicts && next.conflicts.length > 0) {
    merged.conflicts = [...(record.conflicts ?? []), ...next.conflicts];
  }
  return merged;
}

// ---- hidden body marker (host→app identity) ----

// Global + capturing so strip removes EVERY marker (a body may carry a stray or
// user-pasted one) and parse can pick the authoritative last occurrence — the
// one `embedBodyMarker` always appends at the end.
const MARKER_RE_G =
  /<!--\s*packetbench:flight=([^;>\s]+)(?:;task=([^>\s]+))?\s*-->/g;

/**
 * Build the hidden identity marker embedded in an issue body. Task is optional
 * (a Flight-level mapping-A issue omits it).
 *
 * `flightId` / `taskId` must be marker-safe (no `;`, `>`, or whitespace) — the
 * app's generated ids are `[A-Za-z0-9_-]`, which always satisfy this; the parse
 * regex would not round-trip an id containing those separators.
 */
export function buildBodyMarker(flightId: string, taskId?: string | null): string {
  return taskId
    ? `<!-- packetbench:flight=${flightId};task=${taskId} -->`
    : `<!-- packetbench:flight=${flightId} -->`;
}

/**
 * Parse the identity marker out of an issue body. Returns `null` when absent —
 * the caller then falls back to the `MirrorRecord` (or, failing both, creates a
 * new issue). This marker is authoritative for de-duplication, never a
 * title/label heuristic. When more than one marker is present, the LAST is
 * returned (that's the one we embed), so a stray earlier marker can't hijack
 * identity.
 */
export function parseBodyMarker(
  body: string,
): { flightId: string; taskId?: string } | null {
  let last: RegExpMatchArray | undefined;
  for (const m of body.matchAll(MARKER_RE_G)) last = m;
  if (!last) return null;
  return last[2] ? { flightId: last[1], taskId: last[2] } : { flightId: last[1] };
}

/** Remove every marker from a body (trailing whitespace trimmed). */
export function stripBodyMarker(body: string): string {
  return body.replace(MARKER_RE_G, "").trimEnd();
}

/**
 * Embed the identity marker at the end of a body. Idempotent and
 * single-marker-guaranteeing — any existing markers are stripped first, so the
 * result always has exactly one, at the end.
 */
export function embedBodyMarker(
  body: string,
  flightId: string,
  taskId?: string | null,
): string {
  const marker = buildBodyMarker(flightId, taskId);
  const stripped = stripBodyMarker(body);
  return stripped ? `${stripped}\n\n${marker}` : marker;
}
