import type { PackageGitContext, PackageSource } from "@/lib/packetAgentPackage";
import { getGitBranch, gitGetOriginUrl } from "@/lib/tauri";

/**
 * PH3: best-effort git enrichment for `buildWorkerPackage`. Resolves the
 * source's `origin` remote URL (repository) and current branch (revision)
 * via the existing local git commands. SSH-backed sources skip the local
 * lookups — the builder falls back to the record's own basePath/branch.
 * Every failure degrades to "no enrichment"; it never throws.
 */
export async function resolvePackageGitContext(source: PackageSource): Promise<PackageGitContext> {
  const context: PackageGitContext = {};
  let localPath: string | undefined;
  if (source.kind === "attempt") {
    if (source.attempt.target.kind === "local") localPath = source.attempt.target.basePath;
    context.revision = source.attempt.branch || undefined;
  } else if (source.kind === "conversation") {
    const conversation = source.conversation;
    if (!conversation.sshTarget) {
      localPath = conversation.worktree?.basePath ?? conversation.projectPath;
    }
    context.revision = conversation.worktree?.branch || undefined;
  } else {
    localPath = source.flight.projectPath || undefined;
    context.revision = source.flight.gitBranch || undefined;
  }
  if (localPath) {
    try {
      const origin = await gitGetOriginUrl(localPath);
      if (origin?.trim()) context.repository = origin.trim();
    } catch {
      // Not a repo / no origin — the builder falls back to the local path.
    }
    if (!context.revision) {
      try {
        const branch = await getGitBranch(localPath);
        if (branch.trim()) context.revision = branch.trim();
      } catch {
        // Leave revision unset; the builder decides whether that is fatal.
      }
    }
  }
  return context;
}
