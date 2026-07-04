import {
  BookOpen,
  BookText,
  Cpu,
  DollarSign,
  FileCode,
  HelpCircle,
  History,
  Layers,
  Plus,
  Scissors,
  Shield,
  ShieldCheck,
  Target,
  Trash,
} from "lucide-react";
import type { SkillDef, SlashCommandDef } from "@/lib/tauri";
import type { PromptTemplate } from "@/types/prompt";
import type { InputPopoverItem } from "../InputPopover";
import { templateSlug } from "./utils";

/**
 * THE single slash-command source of truth for the unified composer.
 *
 * `buildSlashItems` produces the one ordered, filtered list that BOTH the
 * popover renders AND the keyboard handler resolves Enter/Tab against, so
 * the two can never disagree on ordering or membership. (The old chat
 * composer computed this list three times — popover, keyboard handler, and
 * a count memo — coupled only by matching iteration order.)
 */

export type BuiltinSlashCommand =
  | "clear"
  | "model"
  | "help"
  | "new"
  | "plan"
  | "permissions"
  | "compact"
  | "usage"
  | "history"
  | "review"
  | "goal";

export type SlashSelection =
  | { kind: "builtin"; name: BuiltinSlashCommand }
  | { kind: "custom"; def: SlashCommandDef }
  | { kind: "skill"; def: SkillDef };

/** A popover row plus the selection it resolves to when picked. */
export interface SlashItem extends InputPopoverItem {
  selection: SlashSelection;
}

/**
 * Source tag attached to synthetic SlashCommandDefs that come from the prompt
 * library (vs project/global `.claude/commands/` files). Lets the popover
 * pick the right icon and label these "(template)" in the description.
 */
export const TEMPLATE_SOURCE_TAG = "template";

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
    description: "Trim the local transcript view; backend context is unchanged",
    icon: <Scissors size={12} />,
  },
  {
    cmd: "review",
    label: "/review",
    description: "Spawn a Reviewer subagent on the current staged diff",
    icon: <ShieldCheck size={12} />,
  },
  {
    cmd: "goal",
    label: "/goal",
    description: "Persist this conversation's plan as a resumable goal",
    icon: <Target size={12} />,
  },
  {
    cmd: "usage",
    label: "/usage",
    description: "Open the cost dashboard",
    icon: <DollarSign size={12} />,
  },
  {
    cmd: "history",
    label: "/history",
    description: "Open conversation history",
    icon: <History size={12} />,
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

/**
 * Synthesize a SlashCommandDef per saved prompt template so the prompt
 * library shows up in the same popover as file-loaded custom commands —
 * identically in the launch and chat variants.
 */
export function templatesToSlashDefs(
  templates: PromptTemplate[],
): SlashCommandDef[] {
  return templates.map((t) => ({
    name: templateSlug(t.name),
    description: t.name,
    body: t.content,
    source: TEMPLATE_SOURCE_TAG,
  }));
}

export interface SlashItemSources {
  /** Builtins act on a live conversation, so only the chat variant offers them. */
  includeBuiltins: boolean;
  /** Project/global `.claude/commands/` files + synthesized template defs. */
  customCommands: SlashCommandDef[];
  userSkills: SkillDef[];
}

/**
 * Build the ordered, query-filtered slash list: builtins, then custom
 * commands (incl. templates), then user-invocable skills — every source
 * filtered by the same case-insensitive prefix rule.
 */
export function buildSlashItems(
  query: string,
  { includeBuiltins, customCommands, userSkills }: SlashItemSources,
): SlashItem[] {
  const q = query.toLowerCase();
  const builtins = includeBuiltins
    ? BUILTINS.filter((c) => c.cmd.startsWith(q)).map<SlashItem>((c) => ({
        key: `builtin:${c.cmd}`,
        label: c.label,
        description: c.description,
        icon: c.icon,
        selection: { kind: "builtin", name: c.cmd },
      }))
    : [];
  const custom = customCommands
    .filter((c) => c.name.toLowerCase().startsWith(q))
    .map<SlashItem>((c) => ({
      key: `custom:${c.name}`,
      label: `/${c.name}`,
      description: `${c.description} (${c.source})`,
      icon:
        c.source === TEMPLATE_SOURCE_TAG ? (
          <BookText size={12} />
        ) : (
          <FileCode size={12} />
        ),
      selection: { kind: "custom", def: c },
    }));
  const skills = userSkills
    .filter((s) => s.userInvocable && s.name.toLowerCase().startsWith(q))
    .map<SlashItem>((s) => ({
      key: `skill:${s.name}`,
      label: `/${s.name}${s.argumentHint ? ` ${s.argumentHint}` : ""}`,
      description: `${s.description} (skill: ${s.source})`,
      icon: <BookOpen size={12} />,
      selection: { kind: "skill", def: s },
    }));
  return [...builtins, ...custom, ...skills];
}
