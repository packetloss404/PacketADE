import type { BuiltinSlashCommand } from "./SlashCommandPopover";

/**
 * Names of all built-in slash commands, in display order. Used by both the
 * popover and the AgentChatPane keyhandler so the synchronous Enter/Tab
 * resolution sees the same list the popover renders.
 */
export const BUILTIN_SLASH_NAMES: BuiltinSlashCommand[] = [
  "plan",
  "permissions",
  "model",
  "compact",
  "review",
  "usage",
  "history",
  "clear",
  "new",
  "help",
];

/**
 * Source tag attached to synthetic SlashCommandDefs that come from the prompt
 * library (vs project/global `.claude/commands/` files). Lets the popover
 * pick the right icon and label these "(template)" in the description.
 */
export const TEMPLATE_SOURCE_TAG = "template";
