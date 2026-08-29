/**
 * The ONE table of per-CLI "skip every permission prompt" launch flags.
 *
 * Lived inline in `WorkspacePane` while it was only a spawn-time lookup. It is
 * shared now because the *controls* that offer the toggle have to agree with
 * the spawn path: a workspace-level "Bypass perms: on" that silently does
 * nothing for half its panes is the toggle lying about what it did.
 *
 * A CLI is absent from this table when it has no equivalent launch flag —
 * NOT as an oversight. OpenCode prints `--help` and exits when handed one, and
 * PacketCode has no such flag either; both configure permissions inside their
 * own TUI/config. Passing a made-up flag would break the launch outright, so
 * the honest options are to omit the flag and say so, which is what the
 * surfaces below do.
 */
export const BYPASS_FLAGS: Record<string, string> = {
  "claude-code": "--dangerously-skip-permissions",
  // codex >= 0.x dropped `--full-auto`; the full-bypass equivalent is this.
  codex: "--dangerously-bypass-approvals-and-sandbox",
};

/** Display names for the CLIs that cannot honour the bypass toggle. */
const AGENT_LABELS: Record<string, string> = {
  opencode: "OpenCode",
  packetcode: "PacketCode",
  "claude-code": "Claude Code",
  codex: "Codex CLI",
};

/** Whether launching `agentId` with the bypass toggle on actually changes anything. */
export function supportsBypassFlag(agentId: string): boolean {
  return agentId in BYPASS_FLAGS;
}

/**
 * The CLI agents among `agentIds` for which the bypass toggle is inert, as
 * display labels, de-duplicated and in the order first seen. Non-CLI slots
 * (`terminal`, conversation carriers) are excluded — they have no permission
 * prompts to bypass, so naming them would be noise rather than honesty.
 */
export function unsupportedBypassAgents(agentIds: Iterable<string>): string[] {
  const labels: string[] = [];
  for (const id of agentIds) {
    if (id === "terminal" || supportsBypassFlag(id)) continue;
    const label = AGENT_LABELS[id] ?? id;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

/**
 * The sentence shown wherever the bypass toggle is offered, or `null` when
 * every selected CLI can honour it. Single source so the creation modal and
 * the workspace header cannot drift into telling two different stories.
 */
export function bypassCaveat(agentIds: Iterable<string>): string | null {
  const labels = unsupportedBypassAgents(agentIds);
  if (labels.length === 0) return null;
  return (
    `Not applied to ${labels.join(" and ")} — no equivalent CLI flag. ` +
    `Approve tools in the TUI or set rules in that CLI's own config.`
  );
}

/**
 * The caveat for a surface that sets the bypass DEFAULT rather than applying
 * it — Settings → Workspace defaults, which has no pane list to check because
 * the workspace it pre-checks does not exist yet.
 *
 * Derived from the same table as {@link bypassCaveat} over every CLI the PTY
 * allowlist can launch, so the app-wide default can never promise more than a
 * per-workspace launch delivers. Returns `null` only if every launchable CLI
 * gains a flag.
 */
export function bypassDefaultCaveat(): string | null {
  return bypassCaveat(Object.keys(AGENT_LABELS));
}

/**
 * What the workspace header may claim about the toggle. "partial" exists
 * because "on" was a straight overstatement whenever the workspace held a CLI
 * the flag never reaches.
 */
export function bypassStatusLabel(
  enabled: boolean,
  agentIds: Iterable<string>,
): "on" | "partial" | "off" {
  if (!enabled) return "off";
  return unsupportedBypassAgents(agentIds).length > 0 ? "partial" : "on";
}
