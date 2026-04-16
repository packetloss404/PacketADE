import { useMemo } from "react";
import { Trash, Cpu, HelpCircle, Plus } from "lucide-react";
import { InputPopover, type InputPopoverItem } from "./InputPopover";

export type SlashCommand = "clear" | "model" | "help" | "new";

interface SlashCommandPopoverProps {
  visible: boolean;
  query: string;
  highlightedIndex: number;
  onSelect: (cmd: SlashCommand) => void;
}

interface CommandDef {
  cmd: SlashCommand;
  label: string;
  description: string;
  icon: React.ReactNode;
}

const COMMANDS: CommandDef[] = [
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
}: SlashCommandPopoverProps) {
  const items = useMemo<InputPopoverItem[]>(() => {
    const q = query.toLowerCase();
    return COMMANDS.filter((c) => c.cmd.toLowerCase().startsWith(q)).map(
      (c) => ({
        key: c.cmd,
        label: c.label,
        description: c.description,
        icon: c.icon,
      }),
    );
  }, [query]);

  return (
    <InputPopover
      visible={visible}
      items={items}
      highlightedIndex={highlightedIndex}
      onSelect={(item) => onSelect(item.key as SlashCommand)}
      emptyLabel="No commands"
    />
  );
}
