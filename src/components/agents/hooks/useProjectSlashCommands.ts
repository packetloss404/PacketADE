import { useEffect, useState } from "react";
import { listSkills, listSlashCommands } from "@/lib/tauri";
import type { SkillDef, SlashCommandDef } from "@/lib/tauri";

/**
 * Loads project + global slash commands and user skills for a given project
 * path. Re-fetches when `projectPath` changes; cancels in-flight loads on
 * unmount or path change.
 */
export function useProjectSlashCommands(projectPath: string) {
  const [customSlashCommands, setCustomSlashCommands] = useState<
    SlashCommandDef[]
  >([]);
  const [userSkills, setUserSkills] = useState<SkillDef[]>([]);

  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    listSlashCommands(projectPath)
      .then((cmds) => {
        if (!cancelled) setCustomSlashCommands(cmds);
      })
      .catch((err) =>
        console.warn("[useProjectSlashCommands.listSlashCommands] failed:", err),
      );
    listSkills(projectPath)
      .then((skills) => {
        if (!cancelled) setUserSkills(skills);
      })
      .catch((err) =>
        console.warn("[useProjectSlashCommands.listSkills] failed:", err),
      );
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  return { customSlashCommands, userSkills };
}
