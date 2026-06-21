import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { getGitBranch } from "@/lib/tauri";

export function useGitInfo() {
  const projectPath = useLayoutStore((s) => s.projectPath);
  const setGitBranch = useAppStore((s) => s.setGitBranch);
  const gitBranch = useAppStore((s) => s.gitBranch);

  useEffect(() => {
    // No project open → `projectPath` is "" (and the backend treats that as the
    // filesystem root). Polling git there just fails every 10s, spams the log,
    // and runs a child process against "/" for no reason — skip it entirely.
    const hasProject = projectPath !== "" && projectPath !== "/";
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
  }, [projectPath, setGitBranch]);

  return gitBranch;
}
