import { useContext, useState } from "react";
import { GitBranch, GripHorizontal, Send, Sparkles, X } from "lucide-react";
import { MosaicWindowContext } from "react-mosaic-component";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { Tooltip } from "@/components/ui/Tooltip";
import { getAgentColor } from "@/lib/agentColors";
import { getChatAgent } from "@/lib/agent-catalog";
import { makeSshUri } from "@/lib/ssh-uri";
import { launchConversation } from "@/lib/launchConversation";
import {
  flagsForMode,
  modeLabel,
  modesForApprovals,
} from "@/components/agents/agentModeChipUtils";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAgentDraftStore } from "@/stores/agentDraftStore";
import { useDraftTileStore } from "@/stores/draftTileStore";
import type { Workspace } from "@/types/workspace";

interface DraftTileProps {
  draftId: string;
  workspace: Workspace;
}

/**
 * First-run draft conversation tile (P3-S4). Picking a chat agent in
 * `AddAgentPicker` drops this face into the mosaic BEFORE any conversation
 * exists: sparkle avatar, "Describe the task to start", and composer footer
 * chips for model / safety mode / worktree. On first send it calls
 * `launchConversation` (which creates the conversation in agentTaskStore) and
 * only THEN materializes a real conversation pane — the created-before-insert
 * ordering invariant — retiring this draft. No conversation record, and
 * therefore no orphaned "working" row, exists before send.
 *
 * The task text lives in `agentDraftStore` keyed by the draft id, so it survives
 * tile switches and restarts exactly like a conversation draft. The
 * capability-filtered mode chip reuses the P1-S4 machinery
 * (`modesForApprovals` + sandbox relabels) so a Codex draft shows only honorable
 * postures — identical to what the tile header will show after send.
 */
export function DraftTile({ draftId, workspace }: DraftTileProps) {
  const draft = useDraftTileStore((s) => s.drafts.find((d) => d.id === draftId));
  const updateDraft = useDraftTileStore((s) => s.updateDraft);
  const removeDraft = useDraftTileStore((s) => s.removeDraft);

  const text = useAgentDraftStore((s) => s.drafts[draftId] ?? "");
  const setDraftText = useAgentDraftStore((s) => s.setDraft);

  const activePaneId = useLayoutStore((s) => s.activePaneId);
  const setActivePaneId = useLayoutStore((s) => s.setActivePaneId);
  const isFocused = activePaneId === draftId;

  const [error, setError] = useState<string | null>(null);

  const mosaicCtx = useContext(MosaicWindowContext);
  const mosaicWindowActions = mosaicCtx?.mosaicWindowActions ?? null;

  // A draft can vanish out from under its tile (materialized on send, or the
  // workspace cleared it). Render nothing rather than crash.
  if (!draft) return null;

  const entry = getChatAgent(draft.agent);
  const supportsApprovals = entry?.supportsApprovals ?? true;
  const face = entry?.face ?? draft.agent;
  const color = getAgentColor(draft.agent);
  const modeOptions = modesForApprovals(supportsApprovals);
  const modelLabel =
    entry?.models.find((m) => m.value === draft.model)?.label ?? draft.model;

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Remote workspace → inherit the workspace SSH context as the
    // conversation's execution target (Feature 3 SSH inheritance). Encoded as
    // the ssh:// URI `launchConversation` already resolves to an sshTarget.
    const selectedRepo = workspace.serverId
      ? makeSshUri(workspace.serverId, workspace.remoteProjectPath ?? workspace.projectPath)
      : workspace.projectPath;

    launchConversation({
      rawText: trimmed,
      attachments: [],
      selectedRepo,
      selectedAgent: draft.agent,
      selectedModel: draft.model,
      // Posture comes from `postureOverride`; agentMode is inert here.
      agentMode: "agent",
      composerMode: draft.composerMode,
      profile: undefined,
      setLaunchError: setError,
      postureOverride: flagsForMode(draft.mode),
      onLaunched: (conversationId) => {
        // Created-before-insert: the conversation now exists in agentTaskStore.
        useWorkspaceStore.getState().addConversationPane(workspace.id, conversationId);
        useAgentDraftStore.getState().clearDraft(draftId);
        removeDraft(draftId);
      },
    });
  };

  const chrome = (
    <div className="flex cursor-grab select-none items-center gap-2 border-b border-line-soft bg-bg-secondary px-2 py-1 active:cursor-grabbing">
      <GripHorizontal size={11} className="shrink-0 text-text-muted" />
      <span className={`h-2 w-2 shrink-0 rounded-full ${color.text} bg-current`} />
      <span className={`truncate text-ui font-semibold ${color.text}`}>{face}</span>
      <span className="shrink-0 rounded-full bg-bg-elevated px-1.5 py-0.5 font-mono text-meta text-text-muted">
        draft
      </span>
      <div className="flex-1" />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          removeDraft(draftId);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="shrink-0 p-0.5 text-text-muted transition-colors hover:text-accent-red"
        title="Discard draft"
      >
        <X size={11} />
      </button>
    </div>
  );

  const connectedChrome = mosaicWindowActions?.connectDragSource(chrome) ?? chrome;

  return (
    <div
      onPointerDown={() => {
        if (!isFocused) setActivePaneId(draftId);
      }}
      className={`flex h-full flex-col overflow-hidden rounded-md ${
        isFocused ? "border border-accent-line" : "border border-bg-border"
      } bg-bg-primary`}
    >
      {connectedChrome}

      {/* Sparkle first-run face */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="grid h-11 w-11 place-items-center rounded-lg border border-accent-line bg-accent-soft">
          <Sparkles size={20} className="text-accent-green" />
        </div>
        <div className="text-ui font-medium text-text-primary">Describe the task to start</div>
        <div className="max-w-[260px] text-meta text-text-muted">
          {face} will run once you send your first message.
        </div>
        {error && <div className="text-meta text-accent-red">{error}</div>}
      </div>

      {/* Composer footer: chips (model · mode · worktree) + input + send */}
      <div className="shrink-0 border-t border-line-soft bg-bg-secondary px-2 py-1.5">
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          <Dropdown
            align="left"
            trigger={<span className="text-meta text-text-secondary">{modelLabel}</span>}
          >
            {(entry?.models ?? []).map((m) => (
              <DropdownItem key={m.value} onClick={() => updateDraft(draftId, { model: m.value })}>
                {m.label}
              </DropdownItem>
            ))}
          </Dropdown>

          <Dropdown
            align="left"
            trigger={
              <span className="text-meta text-text-secondary">
                {modeLabel(draft.mode, supportsApprovals)}
              </span>
            }
          >
            {modeOptions.map((m) => (
              <DropdownItem key={m} onClick={() => updateDraft(draftId, { mode: m })}>
                {modeLabel(m, supportsApprovals)}
              </DropdownItem>
            ))}
          </Dropdown>

          <Tooltip
            content={
              draft.composerMode === "worktree"
                ? "Runs in an isolated worktree (pkt/ branch)"
                : "Runs in the project tree"
            }
          >
            <button
              type="button"
              onClick={() =>
                updateDraft(draftId, {
                  composerMode: draft.composerMode === "worktree" ? "local" : "worktree",
                })
              }
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-meta transition-colors ${
                draft.composerMode === "worktree"
                  ? "bg-accent-soft text-accent-green"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              <GitBranch size={10} />
              {draft.composerMode === "worktree" ? "Worktree" : "Local"}
            </button>
          </Tooltip>
        </div>

        <div className="flex items-end gap-1.5">
          <textarea
            value={text}
            onChange={(e) => setDraftText(draftId, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="Describe the task…"
            className="min-h-[38px] flex-1 resize-none rounded border border-bg-border bg-bg-primary px-2 py-1 text-ui text-text-primary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
          />
          <button
            type="button"
            onClick={send}
            disabled={text.trim().length === 0}
            className="inline-flex shrink-0 items-center gap-1 rounded bg-accent-green/20 px-2.5 py-1.5 text-ui text-accent-green transition-colors hover:bg-accent-green/30 disabled:opacity-40"
            title="Send (Enter)"
          >
            <Send size={12} />
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
