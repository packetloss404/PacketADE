import type { ServerConfig } from "@/types/server";
import { toGitServerConfigInput, type GitServerConfigInput } from "@/lib/tauri";

/** Args for the `cloneRepoRemote` binding. */
export interface RemoteCloneArgs {
  serverId: string;
  serverConfig: GitServerConfigInput;
  repoUrl: string;
  destPath: string;
  branch: string | null;
}

/**
 * S6: build the args for cloning a git repo onto a remote SSH workspace, or
 * `null` when there's nothing to clone (blank repo URL, missing destination, or
 * no server). Centralising this keeps the create-workspace flow readable and
 * guarantees the host fingerprint is forwarded via `toGitServerConfigInput`
 * (no silent TOFU downgrade).
 */
export function buildRemoteCloneArgs(
  server: ServerConfig | undefined,
  repoUrl: string,
  destPath: string,
  branch?: string | null,
): RemoteCloneArgs | null {
  if (!server) return null;
  const url = repoUrl.trim();
  const dest = destPath.trim();
  if (!url || !dest) return null;
  const b = (branch ?? "").trim();
  return {
    serverId: server.id,
    serverConfig: toGitServerConfigInput(server),
    repoUrl: url,
    destPath: dest,
    branch: b || null,
  };
}

/**
 * Whether to offer the "clone a repo here" affordance for a remote workspace:
 * the target path must not already be a git repo (cloning into an existing repo
 * would fail or nest). `undefined`/unknown probe state → don't offer yet.
 */
export function shouldOfferRemoteClone(
  pathExists: boolean | undefined,
  isGitRepo: boolean | undefined,
): boolean {
  if (isGitRepo) return false; // already a repo — nothing to clone
  // Offer when the path is empty/absent, or exists but isn't a git repo.
  return pathExists === false || (pathExists === true && isGitRepo === false);
}
