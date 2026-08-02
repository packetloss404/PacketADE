import { useCallback, useEffect, useState } from "react";
import { detectCliCatalog, listWslDistributions } from "@/lib/tauri";
import { terminalPlatform } from "@/lib/terminalShells";
import type { DetectedTerminalShell, TerminalShellProfileId } from "@/types/terminal-shell";

interface TerminalShellDetectionState {
  shells: Partial<Record<TerminalShellProfileId, DetectedTerminalShell>>;
  wslDistributions: string[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useTerminalShellDetection(): TerminalShellDetectionState {
  const [shells, setShells] = useState<
    Partial<Record<TerminalShellProfileId, DetectedTerminalShell>>
  >({ auto: { profile: "auto", available: true, path: null, version: null } });
  const [wslDistributions, setWslDistributions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const platform = terminalPlatform();
    setLoading(true);
    setError(null);
    try {
      const items =
        platform === "windows"
          ? [
              { id: "powershell7", binary: "pwsh" },
              { id: "git-bash", binary: "bash" },
              { id: "wsl", binary: "wsl" },
            ]
          : [
              { id: "bash", binary: "bash" },
              { id: "zsh", binary: "zsh" },
            ];
      const [results, distros] = await Promise.all([
        detectCliCatalog(items),
        platform === "windows" ? listWslDistributions().catch(() => []) : Promise.resolve([]),
      ]);
      const next: Partial<Record<TerminalShellProfileId, DetectedTerminalShell>> = {
        auto: { profile: "auto", available: true, path: null, version: null },
      };
      if (platform === "windows") {
        next["windows-powershell"] = {
          profile: "windows-powershell",
          available: true,
          path: "powershell",
          version: null,
        };
        next["command-prompt"] = {
          profile: "command-prompt",
          available: true,
          path: "cmd",
          version: null,
        };
      }
      for (const result of results) {
        const profile = result.id as TerminalShellProfileId;
        next[profile] = {
          profile,
          available: result.installed,
          path: result.path,
          version: result.version,
        };
      }
      setShells(next);
      setWslDistributions(distros);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { shells, wslDistributions, loading, error, refresh };
}
