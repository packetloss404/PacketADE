import { useMemo } from "react";
import { Trash, Cpu, HelpCircle, Plus, FileCode } from "lucide-react";
import { InputPopover, type InputPopoverItem } from "./InputPopover";
import type { SlashCommandDef } from "@/lib/tauri";

export type BuiltinSlashCommand = "clear" | "model" | "help" | "new";

export type SlashSelection =
  | { kind: "builtin"; name: BuiltinSlashCommand }
  | { kind: "custom"; def: SlashCommandDef };

interface SlashCommandPopoverProps {
  visible: boolean;
  query: string;
  highlightedIndex: number;
  onSelect: (sel: SlashSelection) => void;
  customCommands?: SlashCommandDef[];
}

interface BuiltinDef {
  cmd: BuiltinSlashCommand;
  label: string;
  description: string;
  icon: React.ReactNode;
}

const BUILTINS: BuiltinDef[] = [
  {
    cmd: "clear",
    label: "/clear",
    description: "Clear conversation messages",
    icon: <Trash size={12} />,
  },
  {
    cmd: "model",
    label: "/model",
    description: "Switch model for this conversation",
    icon: <Cpu size={12} />,
  },
  {
    cmd: "help",
    label: "/help",
    description: "Show a keybinding cheatsheet",
    icon: <HelpCircle size={12} />,
  },
  {
    cmd: "new",
    label: "/new",
    description: "Start a new agent conversation with same settings",
    icon: <Plus size={12} />,
  },
];

export function SlashCommandPopover({
  visible,
  query,
  highlightedIndex,
  onSelect,
  customCommands = [],
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
    return [...builtins, ...custom];
  }, [query, customCommands]);

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
        }
      }}
      emptyLabel="No commands"
    />
  );
}
