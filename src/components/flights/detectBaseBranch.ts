import { getGitBranch, getGitBranchRemote, toGitServerConfigInput } from "@/lib/tauri";
import type { PickedTarget } from "@/components/flights/MultiTargetPicker";

/**
 * Resolve a target's real base branch, or `null` when it cannot be determined
 * (non-git path, unreachable host, permission error). Local targets read the
 * checked-out branch directly; SSH targets go through the remote variant, so a
 * remote trunk is detected on the box the worktree will actually be made on.
 */
export async function detectBaseBranch(target: PickedTarget): Promise<string | null> {
  try {
    if (!target.basePath) return null;
    const branch =
      target.kind === "local"
        ? await getGitBranch(target.basePath)
        : await getGitBranchRemote(toGitServerConfigInput(target.server), target.basePath);
    const trimmed = branch.trim();
    // `git rev-parse --abbrev-ref HEAD` answers "HEAD" on a detached checkout,
    // which is not a branch anyone can base a worktree on.
    return trimmed && trimmed !== "HEAD" ? trimmed : null;
  } catch {
    return null;
  }
}
