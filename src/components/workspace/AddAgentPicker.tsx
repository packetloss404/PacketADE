import { useEffect, useRef, useState } from "react";
import { LayoutTemplate, LogIn, Plus, Search } from "lucide-react";
import { AuthBadge, type AuthStatus } from "@/components/ui/AuthBadge";
import { useProviderAuthStatus } from "@/components/agents/hooks/useProviderAuthStatus";
import { CHAT_AGENTS, TERMINAL_AGENTS, type ChatAgentEntry } from "@/lib/agent-catalog";
import { getAgentColor } from "@/lib/agentColors";
import { INSTALL_HINTS } from "@/lib/agent-install-hints";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useDraftTileStore } from "@/stores/draftTileStore";
import { useAgentStore } from "@/stores/agentStore";
import { useServerStore } from "@/stores/serverStore";
import type { AgentCli } from "@/stores/agentTaskStore";
import type { Workspace, WorkspaceAgentSlot } from "@/types/workspace";

interface AddAgentPickerProps {
  workspace: Workspace;
  /**
   * `popover` — the header "+ Add Agent" affordance (replaces the old flat
   * inline dropdown at the same anchor). `inline` — the workspace zero-state:
   * the same list rendered centered so the first agent and the Nth agent are
   * one flow.
   */
  variant: "popover" | "inline";
  /** Opens the existing workspace-templates creation flow. */
  onOpenTemplates?: () => void;
}

/** Which chat providers can complete an interactive login from the picker. */
function loginKindFor(agent: AgentCli): "claude" | "codex" | null {
  if (agent === "api-claude-oauth") return "claude";
  if (agent === "api-openai-codex") return "codex";
  return null;
}

/**
 * One entry point for adding any agent to a workspace (P3-S4). A single
 * searchable list with two labeled sections in capability language — "Chat
 * agents" FIRST (flattened API providers with color dot · face · default-model
 * subtext · AuthBadge + inline Log-in) then "Terminals" (the six CLI slots with
 * install gating + SSH awareness unchanged). The same vendor legitimately
 * appears in both sections; the headers disambiguate search hits ("cla" →
 * Claude under Chat agents AND Claude Code under Terminals).
 *
 * Selection: a Terminal row adds a pane instantly (today's behavior); a Chat
 * row drops a DRAFT conversation tile (see `DraftTile`) — the picker answers
 * WHO, the tile answers HOW. No pre-creation modal.
 */
export function AddAgentPicker({ workspace, variant, onOpenTemplates }: AddAgentPickerProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (variant !== "popover" || !open) return;
    const handler = (e: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [variant, open]);

  if (variant === "inline") {
    return (
      <div className="mx-auto w-full max-w-[380px] rounded-lg border border-bg-border bg-bg-secondary shadow-sm">
        <PickerContent workspace={workspace} onClose={() => {}} onOpenTemplates={onOpenTemplates} />
      </div>
    );
  }

  return (
    <div className="relative" ref={anchorRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
          open
            ? "bg-accent-green/20 text-accent-green"
            : "text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
        }`}
        title="Add agent to workspace"
      >
        <Plus size={11} />
        Add Agent
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[300px] rounded-md border border-bg-border bg-bg-elevated shadow-xl">
          <PickerContent
            workspace={workspace}
            onClose={() => setOpen(false)}
            onOpenTemplates={onOpenTemplates}
          />
        </div>
      )}
    </div>
  );
}

interface PickerContentProps {
  workspace: Workspace;
  onClose: () => void;
  onOpenTemplates?: () => void;
}

/**
 * The searchable two-section list. Split out so the provider-auth probing (a
 * ~9-provider IPC sweep) only runs while the list is actually visible — the
 * popover mounts this on open, mirroring how the composer's ProviderPicker only
 * probes when its launch variant mounts.
 */
function PickerContent({ workspace, onClose, onOpenTemplates }: PickerContentProps) {
  const [filter, setFilter] = useState("");
  const { authStatus, refreshAuthStatuses } = useProviderAuthStatus();
  const agents = useAgentStore((s) => s.agents);
  const servers = useServerStore((s) => s.servers);
  const addPane = useWorkspaceStore((s) => s.addPane);
  const addDraft = useDraftTileStore((s) => s.addDraft);

  const norm = filter.trim().toLowerCase();
  const chatRows = CHAT_AGENTS.filter((c) => c.face.toLowerCase().includes(norm));
  const terminalRows = TERMINAL_AGENTS.filter((t) => t.face.toLowerCase().includes(norm));

  const isInstalled = (slot: WorkspaceAgentSlot): boolean => {
    if (slot === "terminal") return true;
    if (workspace.serverId) {
      const server = servers.find((srv) => srv.id === workspace.serverId);
      return !!server?.installedAgents.includes(slot);
    }
    return !!agents.find((cfg) => cfg.id === slot)?.installed;
  };

  const pickChat = (c: ChatAgentEntry) => {
    // DRAFT tile — no conversation is created until first send.
    addDraft(workspace.id, c.agentCli, c.defaultModel);
    onClose();
  };

  const pickTerminal = (slot: WorkspaceAgentSlot) => {
    if (!isInstalled(slot)) return;
    addPane(workspace.id, slot);
    onClose();
  };

  const openLogin = (agent: AgentCli) => {
    const kind = loginKindFor(agent);
    if (kind === "claude") {
      window.dispatchEvent(new CustomEvent("packetade:open-claude-login"));
    } else if (kind === "codex") {
      window.dispatchEvent(new CustomEvent("packetade:open-codex-login"));
    }
  };

  const noMatches = chatRows.length === 0 && terminalRows.length === 0;

  return (
    <div className="py-1">
      {/* Search */}
      <div className="px-2 pb-1 pt-1">
        <div className="flex items-center gap-1.5 rounded border border-bg-border bg-bg-primary px-2 py-1">
          <Search size={11} className="shrink-0 text-text-muted" />
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onMouseDown={refreshAuthStatuses}
            placeholder="Search agents…"
            className="w-full bg-transparent text-ui text-text-primary placeholder:text-text-muted focus:outline-none"
          />
        </div>
      </div>

      <div className="max-h-[320px] overflow-y-auto">
        {/* Chat agents — first (the new default face). */}
        {chatRows.length > 0 && (
          <div>
            <div className="px-3 py-1 text-meta uppercase tracking-wide text-text-muted">
              Chat agents
            </div>
            {chatRows.map((c) => {
              const entry = authStatus[c.agentCli];
              const status: AuthStatus =
                entry === "loading" || !entry ? "loading" : entry.status;
              const hint = entry && entry !== "loading" ? entry.hint : "";
              const needsLogin = status === "login_required" && loginKindFor(c.agentCli);
              const color = getAgentColor(c.agentCli);
              return (
                <div
                  key={c.agentCli}
                  className="flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-bg-hover"
                >
                  <button
                    type="button"
                    onClick={() => pickChat(c)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${color.text} bg-current`} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-ui text-text-primary">{c.face}</span>
                      {c.defaultModelLabel && (
                        <span className="truncate text-meta text-text-muted">
                          {c.defaultModelLabel}
                        </span>
                      )}
                    </span>
                  </button>
                  <AuthBadge status={status} hint={hint} />
                  {needsLogin && (
                    <button
                      type="button"
                      onClick={() => openLogin(c.agentCli)}
                      className="inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-meta text-accent-amber transition-colors hover:bg-accent-amber/10"
                      title={needsLogin === "codex" ? "Log in to ChatGPT" : "Log in to Claude"}
                    >
                      <LogIn size={10} />
                      Log in
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Terminals — the six CLI slots. */}
        {terminalRows.length > 0 && (
          <div>
            {chatRows.length > 0 && <div className="my-1 border-t border-bg-border" />}
            <div className="px-3 py-1 text-meta uppercase tracking-wide text-text-muted">
              Terminals
            </div>
            {terminalRows.map((t) => {
              const installed = isInstalled(t.slot);
              const color = getAgentColor(t.slot);
              const hint = INSTALL_HINTS[t.slot];
              return (
                <button
                  key={t.slot}
                  type="button"
                  onClick={() => pickTerminal(t.slot)}
                  disabled={!installed}
                  title={
                    installed
                      ? `Add ${t.face}`
                      : hint
                        ? `${t.face} is not installed — ${hint.label}`
                        : `${t.face} is not installed for this workspace`
                  }
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui transition-colors ${
                    installed
                      ? "text-text-primary hover:bg-bg-hover"
                      : "cursor-not-allowed text-text-muted opacity-50"
                  }`}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${color.text} bg-current`} />
                  {t.face}
                </button>
              );
            })}
          </div>
        )}

        {noMatches && (
          <div className="px-3 py-2 text-ui text-text-muted">No matches</div>
        )}
      </div>

      {/* Templates footer — the one creation-time, workspace-scoped concept. */}
      {onOpenTemplates && (
        <>
          <div className="my-1 border-t border-bg-border" />
          <button
            type="button"
            onClick={() => {
              onOpenTemplates();
              onClose();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <LayoutTemplate size={12} />
            Workspace templates…
          </button>
        </>
      )}
    </div>
  );
}
