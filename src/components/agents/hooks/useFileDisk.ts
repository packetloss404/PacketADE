import { useCallback, useEffect, useState } from "react";
import { readFileForDiff } from "@/lib/tauri";

export type DiskState =
  | { kind: "loading" }
  | { kind: "new" }
  | { kind: "existing"; oldContent: string }
  | { kind: "error" };

/**
 * Resolve the on-disk content for a `(projectPath, filePath)` pair so a diff
 * view can render the original side. `refresh()` re-reads disk on demand —
 * callers invoke it after writing back so the diff collapses to "no changes".
 *
 * When either argument is missing, the file is treated as a brand-new file
 * (no original content).
 */
export function useFileDisk(
  projectPath: string | undefined,
  filePath: string | null,
): { state: DiskState; refresh: () => Promise<void> } {
  const [state, setState] = useState<DiskState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!projectPath || !filePath) {
      setState({ kind: "new" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      try {
        const result = await readFileForDiff(projectPath, filePath);
        if (cancelled) return;
        if (result === null || result === undefined) {
          setState({ kind: "new" });
        } else {
          setState({ kind: "existing", oldContent: result });
        }
      } catch {
        if (!cancelled) setState({ kind: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath, filePath, reloadTick]);

  const refresh = useCallback(async () => {
    setReloadTick((n) => n + 1);
  }, []);

  return { state, refresh };
}
