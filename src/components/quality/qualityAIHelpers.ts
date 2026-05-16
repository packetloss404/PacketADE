/**
 * v0.8.8 quality ai — pure helper functions extracted out of
 * `QualityAIErrorActions.tsx` and `QualityAISummary.tsx` so the .tsx
 * files only export components (Vite Fast Refresh requires this).
 *
 * Kept dependency-free (no React, no Tauri) so unit tests can exercise
 * them in isolation. Consumed by the component files via standard
 * imports.
 */

import type { QualityErrorRef } from "./QualityAIExplanation";

/**
 * Module-level cache of streamed AI summaries, keyed by `runHash`. Lives
 * here (rather than inside `QualityAISummary.tsx`) so the component
 * file only exports React components — Vite Fast Refresh requires that.
 *
 * Intentionally NOT persisted to localStorage — the underlying check
 * output isn't persisted either, so any stored summary would risk
 * referring to stale failures.
 */
const SUMMARY_CACHE = new Map<string, string>();

export function getQualityAISummaryCache(runHash: string): string | null {
  return SUMMARY_CACHE.get(runHash) ?? null;
}

export function setQualityAISummaryCache(runHash: string, value: string): void {
  SUMMARY_CACHE.set(runHash, value);
}

export function deleteQualityAISummaryCache(runHash: string): void {
  SUMMARY_CACHE.delete(runHash);
}

/**
 * Clear cached AI summaries.
 *
 * - When `runHash` is supplied, delete only that key. Use this when a
 *   specific run is being re-streamed or invalidated — it avoids wiping
 *   another CodeQualityModal instance's cached summary running in parallel.
 * - When omitted, clear the whole module-level Map (e.g. test teardown,
 *   app-wide reset).
 */
export function clearQualityAISummaryCache(runHash?: string): void {
  if (runHash === undefined) {
    SUMMARY_CACHE.clear();
    return;
  }
  SUMMARY_CACHE.delete(runHash);
}

export interface QualityCheckMeta {
  /** Display name (`lint`, `typecheck`, `tests`, `build`). */
  name: string;
  /** Shell-quoted command that produced the failure. Embedded in the
   *  workspace handoff so the agent can re-run the same check. */
  command: string;
}

/**
 * Map a check name to one of the standard Issue label triplets.
 * Falls back to `quality` when q2 ever extends the check set.
 */
export function labelForCheckName(name: string): string[] {
  const lower = name.toLowerCase();
  if (lower === "lint") return ["lint"];
  if (lower === "typecheck" || lower === "tsc" || lower === "type-check") {
    return ["typecheck"];
  }
  if (lower === "tests" || lower === "test") return ["test-failure"];
  if (lower === "build") return ["build"];
  return ["quality"];
}

/**
 * Build the Issue title from an error message + check name. Truncates
 * to keep the kanban card readable.
 */
export function buildQualityIssueTitle(
  checkName: string,
  errorMessage: string,
): string {
  const firstLine = errorMessage.split(/\r?\n/, 1)[0] || errorMessage;
  // Strip the leading `file:line[:col]` location prefix when present — the
  // body already carries the full locator; the title is for scanning.
  // We accept both colon-terminated (`src/foo.ts:42:7:`) and
  // space-terminated (`src/foo.ts:42:7 message`) shapes; eslint emits
  // the latter, tsc emits both.
  let stripped = firstLine.replace(
    /^([A-Za-z]:[\\/])?[^:\s]+:\d+(?::\d+)?[\s:]*/,
    "",
  );
  // Drop a leading "error:" / "warning:" qualifier that tsc-style
  // toolchains emit before the actual message.
  stripped = stripped.replace(/^(error|warning|note):\s*/i, "");
  const cleaned = stripped.trim() || firstLine.trim();
  const truncated = cleaned.length > 80 ? `${cleaned.slice(0, 77)}…` : cleaned;
  return `Fix ${checkName}: ${truncated}`;
}

/**
 * Build the Issue body Markdown. Embeds the full error payload + file
 * location + linked check command.
 */
export function buildQualityIssueBody(
  error: QualityErrorRef,
  check: QualityCheckMeta,
  contextSnippet?: string,
): string {
  const locator =
    error.line > 0
      ? `\`${error.filePath}:${error.line}${error.column > 0 ? `:${error.column}` : ""}\``
      : `\`${error.filePath}\``;
  const lines = [
    `**Source:** ${locator}`,
    `**Check:** \`${check.command}\``,
    "",
    "**Error:**",
    "",
    "```",
    error.message.trim(),
    "```",
  ];
  if (contextSnippet && contextSnippet.trim()) {
    lines.push(
      "",
      "**Surrounding code:**",
      "",
      "```",
      contextSnippet.trim(),
      "```",
    );
  }
  lines.push(
    "",
    `_Filed from Code Quality on ${new Date().toISOString().slice(0, 10)}._`,
  );
  return lines.join("\n");
}

/**
 * Build the workspace handoff prompt. The receiving `claude-code` pane
 * sees the full error context + the lint/type-check command so it can
 * re-run after applying a fix. Mirrors `sendIssueToWorkspace`'s envelope.
 */
export function buildWorkspaceHandoffPrompt(
  error: QualityErrorRef,
  check: QualityCheckMeta,
  contextSnippet?: string,
): string {
  const locator =
    error.line > 0
      ? `${error.filePath}:${error.line}${error.column > 0 ? `:${error.column}` : ""}`
      : error.filePath;
  const lines = [
    `--- Code Quality failure (${check.name}) ---`,
    "",
    `**Location:** ${locator}`,
    `**Originating check:** \`${check.command}\``,
    "",
    "**Error:**",
    "```",
    error.message.trim(),
    "```",
  ];
  if (contextSnippet && contextSnippet.trim()) {
    lines.push(
      "",
      "**Last 50 lines of surrounding code:**",
      "```",
      contextSnippet.trim(),
      "```",
    );
  }
  lines.push(
    "",
    "Please:",
    "1. Open the file and locate the problem.",
    "2. Apply the smallest fix that resolves it without breaking other checks.",
    `3. Re-run \`${check.command}\` to confirm the error no longer appears.`,
    "",
    "--- Please proceed. ---",
  );
  return lines.join("\n");
}
