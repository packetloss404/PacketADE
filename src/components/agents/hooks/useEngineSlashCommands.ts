import { useEffect, useState } from "react";
import { acpListCommands, type AcpSlashCommand } from "@/lib/tauri";

/**
 * The ACP engine's own slash commands for one project directory.
 *
 * ## Why a module-level cache
 *
 * `acp_list_commands` is a round trip into the engine subprocess, and the `/`
 * popover re-renders on every keystroke of the query. Keying the result by
 * `cwd` — the only input the engine's answer depends on — means the fetch
 * happens once per project per app run, and a second composer pointed at the
 * same project (the workspace mosaic mounts several) reuses it rather than
 * racing a duplicate call.
 *
 * ## Degradation
 *
 * A rejection resolves to an EMPTY list and is deliberately NOT cached: the
 * `/` menu then contains exactly what it contained before this hook existed
 * (builtins + project commands + templates + skills), and a later mount —
 * after the engine has finished starting, say — gets a fresh attempt. Nothing
 * here can throw into render and nothing blocks the textarea.
 */
const commandCache = new Map<string, AcpSlashCommand[]>();
const inFlight = new Map<string, Promise<AcpSlashCommand[]>>();

/** Drop every cached engine command list. Test seam; also safe at runtime. */
export function clearEngineCommandCache(): void {
  commandCache.clear();
  inFlight.clear();
}

/**
 * @param cwd     the conversation's project path — the cache key.
 * @param enabled false for every non-engine session, so the binding is never
 *                invoked for a transport that has no engine behind it.
 */
export function useEngineSlashCommands(
  cwd: string,
  enabled: boolean,
): AcpSlashCommand[] {
  const [commands, setCommands] = useState<AcpSlashCommand[]>(() =>
    enabled && cwd ? (commandCache.get(cwd) ?? []) : [],
  );

  useEffect(() => {
    if (!enabled || !cwd) {
      setCommands([]);
      return undefined;
    }
    const cached = commandCache.get(cwd);
    if (cached) {
      setCommands(cached);
      return undefined;
    }

    let cancelled = false;
    let pending = inFlight.get(cwd);
    if (!pending) {
      pending = acpListCommands(cwd)
        .then((list) => {
          const rows = Array.isArray(list) ? list : [];
          commandCache.set(cwd, rows);
          return rows;
        })
        // Never cached: "the engine could not answer" is not "the engine has
        // no commands", so the next mount is allowed to ask again.
        .catch(() => [] as AcpSlashCommand[])
        .finally(() => {
          inFlight.delete(cwd);
        });
      inFlight.set(cwd, pending);
    }
    void pending.then((rows) => {
      if (!cancelled) setCommands(rows);
    });

    return () => {
      cancelled = true;
    };
  }, [cwd, enabled]);

  return commands;
}
