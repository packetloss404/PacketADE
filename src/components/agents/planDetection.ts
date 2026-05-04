/**
 * Heuristic detector — returns true when the assistant's message looks like
 * a structured plan (Claude-Code-style `## Plan` / `## Files to change` /
 * `## Steps` headers). Case-insensitive, matches at start of any line.
 *
 * Extracted from `PlanModeApprovalMenu.tsx` so the function can be imported
 * without dragging the React component along — keeps that file fast-refresh
 * friendly (only-component-exports rule).
 */
export function looksLikePlan(text: string): boolean {
  if (!text) return false;
  return /(^|\n)\s*##\s+(plan|files to change|steps)\b/i.test(text);
}
