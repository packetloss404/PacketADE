import { useMemo } from "react";
import { Trash, Cpu, HelpCircle, Plus, FileCode, Layers, Shield, Scissors, BookOpen } from "lucide-react";
import { InputPopover, type InputPopoverItem } from "./InputPopover";
import type { SlashCommandDef, SkillDef } from "@/lib/tauri";

export type BuiltinSlashCommand =
  | "clear"
  | "model"
  | "help"
  | "new"
  | "plan"
  | "permissions"
  | "compact";

export type SlashSelection =
  | { kind: "builtin"; name: BuiltinSlashCommand }
  | { kind: "custom"; def: SlashCommandDef }
  | { kind: "skill"; def: SkillDef };

interface SlashCommandPopoverProps {
  visible: boolean;
  query: string;
  highlightedIndex: number;
  onSelect: (sel: SlashSelection) => void;
  customCommands?: SlashCommandDef[];
  userSkills?: SkillDef[];
}

interface BuiltinDef {
  cmd: BuiltinSlashCommand;
  label: string;
  description: string;
  icon: React.ReactNode;
}

const BUILTINS: BuiltinDef[] = [
  {
    cmd: "plan",
    label: "/plan",
    description: "Toggle plan mode (read-only exploration; no edits)",
    icon: <Layers size={12} />,
  },
  {
    cmd: "permissions",
    label: "/permissions",
    description: "Change permission mode (auto / ask / allow-all / deny-all)",
    icon: <Shield size={12} />,
  },
  {
    cmd: "model",
    label: "/model",
    description: "Switch model for this conversation",
    icon: <Cpu size={12} />,
  },
  {
    cmd: "compact",
    label: "/compact",
    description: "Trim history to the last few messages to free context",
    icon: <Scissors size={12} />,
  },
  {
    cmd: "clear",
    label: "/clear",
    description: "Clear conversation messages",
    icon: <Trash size={12} />,
  },
  {
    cmd: "new",
    label: "/new",
    description: "Start a new agent conversation with same settings",
    icon: <Plus size={12} />,
  },
  {
    cmd: "help",
    label: "/help",
    description: "Show a keybinding cheatsheet",
    icon: <HelpCircle size={12} />,
  },
];

export function SlashCommandPopover({
  visible,
  query,
  highlightedIndex,
  onSelect,
  customCommands = [],
  userSkills = [],
}: SlashCommandPopoverProps) {
  const items = useMemo<InputPopoverItem[]>(() => {
    const q = query.toLowerCase();
    const builtins = BUILTINS.filter((c) => c.cmd.toLowerCase().startsWith(q)).map(
      (c) => ({
        key: `builtin:${c.cmd}`,
        label: c.label,
        description: c.description,
        icon: c.icon,
      }),
    );
    const custom = customCommands
      .filter((c) => c.name.toLowerCase().startsWith(q))
      .map((c) => ({
        key: `custom:${c.name}`,
        label: `/${c.name}`,
        description: `${c.description} (${c.source})`,
        icon: <FileCode size={12} />,
      }));
    const skills = userSkills
      .filter((s) => s.userInvocable && s.name.toLowerCase().startsWith(q))
      .map((s) => ({
        key: `skill:${s.name}`,
        label: `/${s.name}${s.argumentHint ? ` ${s.argumentHint}` : ""}`,
        description: `${s.description} (skill: ${s.source})`,
        icon: <BookOpen size={12} />,
      }));
    return [...builtins, ...custom, ...skills];
  }, [query, customCommands, userSkills]);

  return (
    <InputPopover
      visible={visible}
      items={items}
      highlightedIndex={highlightedIndex}
      onSelect={(item) => {
        if (item.key.startsWith("builtin:")) {
          onSelect({
            kind: "builtin",
            name: item.key.slice("builtin:".length) as BuiltinSlashCommand,
          });
        } else if (item.key.startsWith("custom:")) {
          const name = item.key.slice("custom:".length);
          const def = customCommands.find((c) => c.name === name);
          if (def) onSelect({ kind: "custom", def });
        } else if (item.key.startsWith("skill:")) {
          const name = item.key.slice("skill:".length);
          const def = userSkills.find((s) => s.name === name);
          if (def) onSelect({ kind: "skill", def });
        }
      }}
      emptyLabel="No commands"
    />
  );
}
