/**
 * Shared worktree-lifecycle shapes + predicates for the two worktree owners —
 * async Flight attempts and Agents conversations. This module is deliberately
 * PURE: it performs no IO and imports no store. Callers compute the raw facts
 * (dirty flag, ancestry, PR-merged status, ahead count) via git/GitHub and feed
 * them to the predicate here so the safe-cleanup rule lives in exactly one place.
 *
 * Flights and conversations agree on the lifecycle vocabulary but keep their own
 * persistence (`Attempt` on the flight, `AgentConversation.worktree` on the
 * conversation); this module never reads either engine field — it only names the
 * shared shapes and rules. (P2-S2.)
 */

/**
 * Lifecycle of a provisioned worktree branch. `active` until the work is either
 * landed (squash-merged back to base) or discarded (thrown away). Both terminal
 * states are final. Field name + values are AttemptTarget/Attempt-isomorphic
 * with `AgentConversation.worktree.state`.
 */
export type WorktreeState = "active" | "landed" | "discarded";

/**
 * Whether a lifecycle transition is legal. Only an `active` worktree may
 * transition, and only into a terminal state; a landed/discarded worktree never
 * transitions again (idempotent re-flips are rejected so a double-fire can't,
 * e.g., mark a discarded tree "landed").
 */
export function canTransitionWorktree(from: WorktreeState, to: WorktreeState): boolean {
  if (from !== "active") return false;
  return to === "landed" || to === "discarded";
}

/**
 * Raw facts the safe-cleanup predicate needs. The caller gathers these from git
 * / GitHub before deciding whether an unattended cleanup (archive policy,
 * auto-sweep) may remove a worktree. This module does no IO — it only combines
 * the facts into the ruled decision.
 */
export interface WorktreeCleanupFacts {
  /** The worktree has uncommitted changes. Cleanup is NEVER safe when true. */
  dirty: boolean;
  /**
   * The branch is already reachable from its base by git ancestry (a real
   * merge / fast-forward already landed it).
   */
  ancestryMerged: boolean;
  /**
   * A PR recorded for this branch reports `merged` on GitHub. Covers the
   * squash-merge case where ancestry is broken but the PR shows the work landed.
   */
  recordedPrMerged: boolean;
  /** Number of commits the branch is ahead of its base. Zero ⇒ nothing to lose. */
  commitsAhead: number;
}

/**
 * Bravo's ruled safe-cleanup predicate, verbatim: a worktree is safe to remove
 * unattended iff it is CLEAN **and** (ancestry-merged OR a recorded PR reports
 * merged OR it is zero commits ahead of base). Anything not provably safe is
 * conservatively Kept (with the "worktree pending" chip in later phases). A
 * dirty tree is never safe regardless of the merge facts.
 */
export function isWorktreeSafeToCleanup(facts: WorktreeCleanupFacts): boolean {
  if (facts.dirty) return false;
  return facts.ancestryMerged || facts.recordedPrMerged || facts.commitsAhead === 0;
}

/**
 * Dirty-check helper: interpret `git status --porcelain` (or `--short`) output.
 * Any non-blank line means the worktree has uncommitted changes. Trailing
 * whitespace / a lone newline reads as clean. Shared by every removal path so
 * "no non-Discard path removes a dirty tree" keys off one definition of dirty.
 */
export function isWorktreeDirty(porcelainStatus: string): boolean {
  return porcelainStatus.split("\n").some((line) => line.trim().length > 0);
}
