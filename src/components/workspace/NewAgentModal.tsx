import { useMemo, useState } from "react";
import { Plus, Zap } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { WorkspaceCreationModal } from "@/components/workspace/WorkspaceCreationModal";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAgentStore } from "@/stores/agentStore";
import { useServerStore } from "@/stores/serverStore";
import { useAppStore } from "@/stores/appStore";
import { writePty } from "@/lib/tauri";
import type { WorkspaceAgentSlot, Workspace } from "@/types/workspace";

const AGENT_OPTIONS: { id: WorkspaceAgentSlot; label: string }[] = [
  { id: "claude-code", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "gemini", label: "Gemini" },
  { id: "opencode", label: "OpenCode" },
  { id: "packetcode", label: "PacketCode" },
  { id: "terminal", label: "Terminal" },
];

const AGENT_ACCENT: Record<WorkspaceAgentSlot, string> = {
  "claude-code": "bg-accent-green",
  "codex": "bg-blue-500",
  "gemini": "bg-purple-500",
  "opencode": "bg-orange-500",
  "packetcode": "bg-purple-500",
  "terminal": "bg-text-muted",
};

type Target = "active" | "other" | "new";

interface NewAgentModalProps {
  onClose: () => void;
}

/**
 * Lightweight "New Agent" modal launched from the Toolbar's `+ New →
 * New Agent` menu item. Lets the user pick an agent and a target — the
 * active workspace, another existing workspace, or a brand-new
 * workspace — without dropping into the legacy `quickStartSession`
 * mosaic.
 *
 * When the target is "Create new workspace", this modal hands off to
 * `WorkspaceCreationModal` with the chosen agent preselected and the
 * typed prompt forwarded as `initialPrompt`, so no project-path /
 * workspace-name UI is duplicated here.
 *
 * When the target is an existing workspace, this modal calls
 * `workspaceStore.addPane` and (if a prompt was typed) subscribes to
 * the store, waits for the new pane's `sessionId` to populate, then
 * `writePty`s the prompt — the same pattern `CliAgentsCard.handleInstall`
 * uses for install commands. A 30s safety net detaches the subscriber
 * if the pane never spawns.
 */
export function NewAgentModal({ onClose }: NewAgentModalProps) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const addPane = useWorkspaceStore((s) => s.addPane);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const agents = useAgentStore((s) => s.agents);
  const servers = useServerStore((s) => s.servers);

  const activeNonArchived = useMemo(
    () => workspaces.filter((w) => w.status === "active"),
    [workspaces],
  );
  const activeWorkspace = useMemo(
    () => activeNonArchived.find((w) => w.id === activeWorkspaceId) ?? null,
    [activeNonArchived, activeWorkspaceId],
  );
  const otherWorkspaces = useMemo(
    () => activeNonArchived.filter((w) => w.id !== activeWorkspaceId),
    [activeNonArchived, activeWorkspaceId],
  );

  const [agent, setAgent] = useState<WorkspaceAgentSlot>("claude-code");
  const [target, setTarget] = useState<Target>(
    activeWorkspace ? "active" : "new",
  );
  const [otherWorkspaceId, setOtherWorkspaceId] = useState<string | null>(
    otherWorkspaces[0]?.id ?? null,
  );
  const [prompt, setPrompt] = useState("");
  const [bridgeOpen, setBridgeOpen] = useState(false);

  const isAgentInstalledForWorkspace = (
    slot: WorkspaceAgentSlot,
    workspace: Workspace,
  ): boolean => {
    if (slot === "terminal") return true;
    if (workspace.serverId) {
      const server = servers.find((srv) => srv.id === workspace.serverId);
      return !!server?.installedAgents.includes(slot);
    }
    return !!agents.find((cfg) => cfg.id === slot)?.installed;
  };

  const targetWorkspace: Workspace | null =
    target === "active"
      ? activeWorkspace
      : target === "other"
        ? otherWorkspaces.find((w) => w.id === otherWorkspaceId) ?? null
        : null;

  const installedForTarget =
    target === "new" ? true : targetWorkspace ? isAgentInstalledForWorkspace(agent, targetWorkspace) : false;

  const submitDisabled =
    (target === "active" && !activeWorkspace) ||
    (target === "other" && !otherWorkspaceId) ||
    !installedForTarget;

  function handleAddToWorkspace(ws: Workspace) {
    const paneId = addPane(ws.id, agent);
    setActiveWorkspace(ws.id);
    setActiveView("workspace");

    if (!paneId || !prompt.trim()) {
      onClose();
      return;
    }

    // Subscribe and wait for the new pane's sessionId to populate, then
    // write the prompt. The pane is created synchronously inside addPane,
    // but its sessionId is set asynchronously by TerminalPane.onSessionCreated.
    // Single-shot resolution: subscribe + 30s safety timeout share one
    // teardown.
    const trimmed = prompt.trim();
    const teardown = { fn: () => {} };
    let sent = false;
    const finish = (cb?: () => void) => {
      if (sent) return;
      sent = true;
      teardown.fn();
      cb?.();
    };

    const unsubscribe = useWorkspaceStore.subscribe((state) => {
      if (sent) return;
      const wsState = state.workspaces.find((w) => w.id === ws.id);
      const pane = wsState?.panes.find((p) => p.id === paneId);
      const sessionId = pane?.sessionId;
      if (!sessionId) return;
      finish(() => {
        // Trailing CR — matches the convention used elsewhere in the
        // workspace pane code (some Windows ConPTY shells don't fire the
        // shell's Enter handler on bare LF).
        void writePty(sessionId, trimmed + "\r").catch((err) => {
          console.error(
            `[NewAgentModal] failed to write initial prompt to session ${sessionId}:`,
            err,
          );
        });
      });
    });

    const safety = window.setTimeout(() => finish(), 30_000);
    teardown.fn = () => {
      window.clearTimeout(safety);
      unsubscribe();
    };

    onClose();
  }

  function handleSubmit() {
    if (submitDisabled) return;
    if (target === "new") {
      setBridgeOpen(true);
      return;
    }
    const ws = target === "active" ? activeWorkspace : targetWorkspace;
    if (!ws) return;
    handleAddToWorkspace(ws);
  }

  // Handoff to WorkspaceCreationModal — replaces this modal's body until
  // the user closes that one. Passing `onClose` through means cancelling
  // either modal collapses the whole stack.
  if (bridgeOpen) {
    return (
      <WorkspaceCreationModal
        onClose={onClose}
        initialSelected={new Set([agent])}
        initialPrompt={prompt.trim() || undefined}
      />
    );
  }

  const footer = (
    <div className="flex items-center justify-end gap-2">
      <button
        onClick={onClose}
        className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
      >
        Cancel
      </button>
      <button
        onClick={handleSubmit}
        disabled={submitDisabled}
        title={
          !installedForTarget && target !== "new"
            ? `${agent} is not installed for the selected workspace — pick a different agent or "Create new workspace"`
            : undefined
        }
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent-green/15 text-accent-green border border-accent-green/30 rounded hover:bg-accent-green/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Plus size={12} />
        Add Agent
      </button>
    </div>
  );

  return (
    <Modal
      onClose={onClose}
      title="New Agent"
      icon={<Zap size={14} className="text-accent-green" />}
      width="w-[460px]"
      footer={footer}
      closeOnEscape
    >
      <div className="px-5 py-4 space-y-4">
        {/* Agent picker */}
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-text-muted mb-2">
            Agent
          </label>
          <div className="grid grid-cols-3 gap-1.5">
            {AGENT_OPTIONS.map((opt) => {
              const isSelected = opt.id === agent;
              // For the new-workspace path we can't preflight install, so
              // every option is enabled. For existing-workspace targets we
              // still let the user select an uninstalled agent (so they
              // can see it dim), but the submit button gates commit.
              const installedHere = targetWorkspace
                ? isAgentInstalledForWorkspace(opt.id, targetWorkspace)
                : true;
              return (
                <button
                  key={opt.id}
                  onClick={() => setAgent(opt.id)}
                  title={
                    target !== "new" && !installedHere
                      ? `${opt.label} is not installed for the selected workspace`
                      : opt.label
                  }
                  className={`flex items-center gap-1.5 px-2 py-1.5 text-[11px] rounded border transition-colors ${
                    isSelected
                      ? "border-accent-green/50 bg-accent-green/10 text-text-primary"
                      : "border-bg-border bg-bg-primary text-text-secondary hover:border-text-muted"
                  } ${target !== "new" && !installedHere ? "opacity-50" : ""}`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${AGENT_ACCENT[opt.id]}`}
                  />
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Target picker */}
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-text-muted mb-2">
            Target
          </label>
          <div className="space-y-1.5">
            {activeWorkspace && (
              <label className="flex items-center gap-2 px-2 py-1.5 text-xs text-text-secondary cursor-pointer rounded hover:bg-bg-elevated">
                <input
                  type="radio"
                  checked={target === "active"}
                  onChange={() => setTarget("active")}
                  className="accent-accent-green"
                />
                <span>Active workspace</span>
                <span className="text-text-muted text-[11px]">
                  · {activeWorkspace.name}
                </span>
              </label>
            )}
            {otherWorkspaces.length > 0 && (
              <label className="flex items-center gap-2 px-2 py-1.5 text-xs text-text-secondary cursor-pointer rounded hover:bg-bg-elevated">
                <input
                  type="radio"
                  checked={target === "other"}
                  onChange={() => setTarget("other")}
                  className="accent-accent-green"
                />
                <span>Other workspace</span>
                <select
                  value={otherWorkspaceId ?? ""}
                  onChange={(e) => {
                    setOtherWorkspaceId(e.target.value || null);
                    setTarget("other");
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="ml-1 px-1.5 py-0.5 text-[11px] bg-bg-primary border border-bg-border rounded text-text-secondary focus:outline-none focus:border-accent-green/50"
                >
                  {otherWorkspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex items-center gap-2 px-2 py-1.5 text-xs text-text-secondary cursor-pointer rounded hover:bg-bg-elevated">
              <input
                type="radio"
                checked={target === "new"}
                onChange={() => setTarget("new")}
                className="accent-accent-green"
              />
              <span>Create new workspace…</span>
            </label>
          </div>
        </div>

        {/* Prompt (optional) */}
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-text-muted mb-2">
            Prompt <span className="normal-case text-text-faint">(optional)</span>
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="First message sent to the new agent after it starts…"
            rows={3}
            className="w-full px-2.5 py-1.5 text-xs bg-bg-primary border border-bg-border rounded text-text-primary placeholder-text-faint focus:outline-none focus:border-accent-green/50 resize-y"
          />
          {target === "new" && (
            <p className="text-[10px] text-text-muted mt-1">
              Carried over to the Create Workspace dialog.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
