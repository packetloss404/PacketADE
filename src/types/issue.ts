/**
 * v0.8.5 — Issue type re-export.
 *
 * The Issue interface (and the surrounding store) lives in
 * `@/stores/issueStore` for historical reasons. This module re-exports
 * the public types so new code can import from `@/types/issue` alongside
 * the other domain type modules (workspace, flight, server, etc.).
 *
 * Pure type re-exports — zero runtime cost.
 *
 * The Issue interface itself was additively extended in v0.8.5 with two
 * optional fields used by the spec-import-to-issues flow:
 *   - `acceptanceCriteria` (already present, stored as
 *     `AcceptanceCriterion[]` — bullet objects with checked state). The
 *     AI extraction returns `string[]`; the SpecImportModal converts each
 *     string into a fresh `AcceptanceCriterion` at create-time.
 *   - `specImportBatchId?: string` — uuid stamped on every Issue created
 *     in a single spec-import submit, so the IssueCard can render a
 *     "from spec import on {date}" badge that groups siblings together.
 */
export type {
  Issue,
  IssueStatus,
  IssuePriority,
  IssueComment,
  AcceptanceCriterion,
} from "@/stores/issueStore";

// v0.8.5 — Spec-import wire format. The AI returns one of these per
// issue; the SpecImportModal lets the user edit/skip rows before
// fanning them out into `issueStore.addIssue`.
export type { ExtractedIssueDraft } from "@/lib/tauri";

/**
 * Convenience type combining the AI-extracted shape with a UI-side
 * `selected` flag. The SpecImportModal builds an array of these once
 * extraction completes; rows the user unchecks are filtered out before
 * creation.
 */
export interface SpecImportDraft {
  title: string;
  body: string;
  labels?: string[];
  acceptanceCriteria?: string[];
  suggestedEpic?: string;
  /** Whether the user has the row checked in the review stage. */
  selected: boolean;
}
