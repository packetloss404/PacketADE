import { useEffect, useRef, useState } from "react";
import { ExternalLink, LayoutTemplate, Plus, Search, Settings2 } from "lucide-react";
import { TERMINAL_AGENTS } from "@/lib/agent-catalog";
import { getAgentColor } from "@/lib/agentColors";
import { INSTALL_HINTS } from "@/lib/agent-install-hints";
import { useAppStore } from "@/stores/appStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAgentStore } from "@/stores/agentStore";
import { useServerStore } from "@/stores/serverStore";
import type { Workspace, WorkspaceAgentSlot } from "@/types/workspace";

interface AddSessionPickerProps {
  workspace: Workspace;
  /**
   * `popover` is the compact Workspace-header affordance. `inline` is the
   * empty-Workspace zero state. Both expose only PTY/CLI sessions; GUI/API
   * conversations are created in Agents.
   */
  variant: "popover" | "inline";
  onOpenTemplates?: () => void;
}

export function AddSessionPicker({
  workspace,
  variant,
  onOpenTemplates,
}: AddSessionPickerProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (variant !== "popover" || !open) return;
    const handler = (event: MouseEvent) => {
      if (
        anchorRef.current &&
        !anchorRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [variant, open]);

  if (variant === "inline") {
    return (
      <div className="mx-auto w-full max-w-[380px] rounded-lg border border-bg-border bg-bg-secondary shadow-sm">
        <PickerContent
          workspace={workspace}
          onClose={() => {}}
          onOpenTemplates={onOpenTemplates}
        />
      </div>
    );
  }

  return (
    <div className="relative" ref={anchorRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
          open
            ? "bg-accent-green/20 text-accent-green"
            : "text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
        }`}
        title="Add a CLI session to this workspace"
      >
        <Plus size={11} />
        Add Session
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[320px] rounded-md border border-bg-border bg-bg-elevated shadow-xl">
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

function PickerContent({
  workspace,
  onClose,
  onOpenTemplates,
}: PickerContentProps) {
  const [filter, setFilter] = useState("");
  const agents = useAgentStore((state) => state.agents);
  const servers = useServerStore((state) => state.servers);
  const addPane = useWorkspaceStore((state) => state.addPane);
  const openSettings = useAppStore((state) => state.openSettings);

  const isInstalled = (slot: WorkspaceAgentSlot): boolean => {
    if (slot === "terminal") return true;
    if (workspace.serverId) {
      const server = servers.find(
        (candidate) => candidate.id === workspace.serverId,
      );
      return server?.installedAgents.includes(slot) ?? false;
    }
    return agents.find((agent) => agent.id === slot)?.installed ?? false;
  };

  const normalizedFilter = filter.trim().toLowerCase();
  const packetCodeReady = isInstalled("packetcode");
  const sessionRows = TERMINAL_AGENTS.filter((entry) =>
    entry.face.toLowerCase().includes(normalizedFilter),
  ).sort((left, right) => {
    const leftRecommended = left.slot === "packetcode" && packetCodeReady;
    const rightRecommended = right.slot === "packetcode" && packetCodeReady;
    if (leftRecommended !== rightRecommended) {
      return leftRecommended ? -1 : 1;
    }
    return 0;
  });

  const pickSession = (slot: WorkspaceAgentSlot) => {
    if (!isInstalled(slot)) return;
    addPane(workspace.id, slot);
    onClose();
  };

  const openPacketCodeSetup = () => {
    openSettings({ section: "cli-clients", cliId: "packetcode" });
    onClose();
  };

  return (
    <div className="py-1">
      <div className="px-2 pb-1 pt-1">
        <div className="flex items-center gap-1.5 rounded border border-bg-border bg-bg-primary px-2 py-1">
          <Search size={11} className="shrink-0 text-text-muted" />
          <input
            autoFocus
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search CLI sessions…"
            className="w-full bg-transparent text-ui text-text-primary placeholder:text-text-muted focus:outline-none"
          />
        </div>
      </div>

      <div className="px-3 py-1 text-meta uppercase tracking-wide text-text-muted">
        CLI sessions
      </div>

      <div className="max-h-[320px] overflow-y-auto">
        {sessionRows.map((entry) => {
          const installed = isInstalled(entry.slot);
          const color = getAgentColor(entry.slot);
          const hint = INSTALL_HINTS[entry.slot];
          const recommended =
            entry.slot === "packetcode" && packetCodeReady;

          return (
            <div
              key={entry.slot}
              className="flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-bg-hover"
            >
              <button
                type="button"
                onClick={() => pickSession(entry.slot)}
                disabled={!installed}
                title={
                  installed
                    ? `Add ${entry.face} session`
                    : `${entry.face} is not available for this workspace`
                }
                className={`flex min-w-0 flex-1 items-center gap-2 text-left text-ui ${
                  installed
                    ? "text-text-primary"
                    : "cursor-not-allowed text-text-muted opacity-50"
                }`}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${color.text} bg-current`}
                />
                <span className="truncate">{entry.face}</span>
                {recommended && (
                  <span className="ml-auto rounded bg-accent-amber/15 px-1.5 py-0.5 text-meta text-accent-amber">
                    Recommended
                  </span>
                )}
              </button>

              {!installed && entry.slot === "packetcode" && (
                <button
                  type="button"
                  onClick={openPacketCodeSetup}
                  className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-meta text-accent-amber transition-colors hover:bg-accent-amber/10"
                  title="Install, locate, and configure PacketCode"
                >
                  <Settings2 size={10} />
                  Set up
                </button>
              )}

              {!installed && entry.slot !== "packetcode" && hint && (
                <a
                  href={hint.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-meta text-text-muted hover:text-accent-amber"
                  title={hint.label}
                >
                  <ExternalLink size={10} />
                  Install
                </a>
              )}
            </div>
          );
        })}

        {sessionRows.length === 0 && (
          <div className="px-3 py-2 text-ui text-text-muted">
            No matching CLI sessions
          </div>
        )}
      </div>

      {!packetCodeReady && !normalizedFilter && (
        <div className="mx-2 my-1 rounded border border-accent-amber/20 bg-accent-amber/5 px-2 py-1.5 text-meta text-text-muted">
          PacketCode is the recommended PacketADE terminal loop. Use{" "}
          <button
            type="button"
            onClick={openPacketCodeSetup}
            className="text-accent-amber hover:underline"
          >
            Set up
          </button>{" "}
          to install it, locate its executable, and configure its data home.
        </div>
      )}

      {onOpenTemplates && (
        <>
          <div className="my-1 border-t border-bg-border" />
          <button
            type="button"
            onClick={() => {
              onOpenTemplates();
              onClose();
            }}
            title="Opens the New Workspace form — this creates a separate workspace, it does not template the current one"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <LayoutTemplate size={12} />
            New workspace from template…
          </button>
        </>
      )}
    </div>
  );
}
