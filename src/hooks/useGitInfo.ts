import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { getGitBranch } from "@/lib/tauri";
import { isLocalWorkspace } from "@/types/workspace";

export function useGitInfo() {
  const projectPath = useLayoutStore((s) => s.projectPath);
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId),
  );
  const activeWorkspaceIsRemote = Boolean(activeWorkspace && !isLocalWorkspace(activeWorkspace));
  const setGitBranch = useAppStore((s) => s.setGitBranch);
  const gitBranch = useAppStore((s) => s.gitBranch);

  useEffect(() => {
    // No project open → `projectPath` is "" (and the backend treats that as the
    // filesystem root). Polling git there just fails every 10s, spams the log,
    // and runs a child process against "/" for no reason — skip it entirely.
    // layoutStore intentionally retains the last local fallback while an SSH
    // Workspace is active. That fallback is not authoritative for the remote
    // Workspace, so never poll it or display its branch as remote state.
    const hasProject = !activeWorkspaceIsRemote && projectPath !== "" && projectPath !== "/";
    if (!hasProject) {
      setGitBranch(null);
      return;
    }

    let cancelled = false;

    async function fetchBranch() {
      try {
        const branch = await getGitBranch(projectPath);
        if (!cancelled) {
          setGitBranch(branch);
        }
      } catch {
        if (!cancelled) {
          setGitBranch(null);
        }
      }
    }

    fetchBranch();

    // Poll every 10 seconds
    const interval = setInterval(fetchBranch, 10000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeWorkspaceIsRemote, projectPath, setGitBranch]);

  return gitBranch;
}
