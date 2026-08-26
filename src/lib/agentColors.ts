/**
 * Single source of truth for agent-identity and status colors.
 *
 * The Agents tab (`AgentSidebar`) and the Workspaces flow (workspace tiles,
 * WorkspaceView, TerminalHeader) previously each hand-rolled their own
 * agent → color map, and they disagreed: some used on-token `text-accent-*`
 * classes while others used off-token raw Tailwind (`bg-blue-500`,
 * `bg-purple-500`, `bg-orange-500`) or inline hex. This module unifies all
 * of them onto the Graphite accent tokens so a given agent looks identical
 * everywhere, and so "running"/"active" is ONE color app-wide.
 *
 * Dependency-free (React/lucide callers only). Every returned string is a
 * design-token className — never a raw Tailwind color.
 */

/** Canonical agent identity families we assign a stable color to. */
type AgentFamily =
  | "claude"
  | "codex"
  | "opencode"
  | "packetcode"
  | "minimax"
  | "neutral";

/** Bundle of token classNames for one identity, at conventional strengths. */
export interface AgentColor {
  /** Text color — agent names, labels, icons. e.g. `text-accent-green`. */
  text: string;
  /** Soft fill — badges/chips/pills. e.g. `bg-accent-green/10`. */
  bg: string;
  /** Chip outline. e.g. `border-accent-green/30`. */
  border: string;
}

const FAMILY_COLORS: Record<AgentFamily, AgentColor> = {
  claude: { text: "text-accent-green", bg: "bg-accent-green/10", border: "border-accent-green/30" },
  codex: { text: "text-accent-amber", bg: "bg-accent-amber/10", border: "border-accent-amber/30" },
  opencode: { text: "text-accent-purple", bg: "bg-accent-purple/10", border: "border-accent-purple/30" },
  packetcode: { text: "text-accent-purple", bg: "bg-accent-purple/10", border: "border-accent-purple/30" },
  minimax: { text: "text-accent-blue", bg: "bg-accent-blue/10", border: "border-accent-blue/30" },
  neutral: { text: "text-text-secondary", bg: "bg-bg-elevated", border: "border-bg-border" },
};

/**
 * Resolve any agent identifier — CLI slot (`claude-code`, `codex`,
 * `packetcode`, `terminal`) or `api-*` agentCli (`api-claude-oauth`,
 * `api-openai-agents`, `api-minimax-api`, `api-ollama`, …) — to a family.
 */
function agentFamily(agentId: string): AgentFamily {
  const id = agentId.toLowerCase();
  if (id === "claude" || id === "claude-code" || id.startsWith("api-claude")) return "claude";
  if (id === "codex" || id.startsWith("api-openai")) return "codex";
  // Ollama (local) shares OpenCode's slot color in the legacy sidebar map.
  if (id === "opencode" || id === "api-ollama") return "opencode";
  // Both PacketCode faces — the PTY TUI slot and the ACP chat provider — share
  // the one PacketCode identity color; they are the same engine, two transports.
  if (id === "packetcode" || id === "api-packetcode") return "packetcode";
  // OpenRouter is a blue meta-provider alongside MiniMax in the legacy map.
  if (id.startsWith("api-minimax") || id === "api-openrouter") return "minimax";
  return "neutral";
}

/**
 * Stable identity colors for an agent. Consistent across Agents and
 * Workspaces for codex/claude/opencode/packetcode/minimax.
 *
 * For a solid identity dot, pair `.text` with `bg-current` on the same span
 * (`className={`${c.text} bg-current`}`) — the dot inherits the accent color
 * without needing a separate solid token.
 */
export function getAgentColor(agentId: string): AgentColor {
  return FAMILY_COLORS[agentFamily(agentId)];
}

/**
 * Status → text-color className, unified app-wide. "running" and "active"
 * always resolve to the same color, as do the done/failed/queued vocabularies
 * used across Agents, Workspaces and Flights.
 */
export function getStatusColor(status: string): string {
  switch (status.toLowerCase()) {
    case "running":
    case "active":
    case "live":
    case "streaming":
    case "idle":
      return "text-accent-green";
    case "queued":
    case "pending":
    case "waiting":
    case "paused":
      return "text-accent-amber";
    case "done":
    case "complete":
    case "completed":
    case "success":
      return "text-text-muted";
    case "failed":
    case "error":
    case "cancelled":
      return "text-accent-red";
    default:
      return "text-text-muted";
  }
}
