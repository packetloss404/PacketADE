import { useCallback, useMemo, type ReactNode } from "react";
import { Mosaic, MosaicWindow } from "react-mosaic-component";
import { X, MessageSquare, FileDiff, Terminal, FolderTree } from "lucide-react";
import {
  useAgentMosaicStore,
  type AgentPaneId,
} from "@/stores/agentMosaicStore";
import type { MosaicNode, MosaicPath } from "@/types/mosaic";
import { AgentPaneSplitMenu } from "./AgentPaneSplitMenu";

/**
 * Wraps a single agent conversation in a per-conversation mosaic.
 *
 * If the layout for this conversation is just the implicit "chat" leaf, this
 * renders the `chat` child directly with no mosaic chrome — the simple flow
 * everyone gets by default. The moment the user splits a tile in via
 * `AgentPaneSplitMenu`, this component flips into a `<Mosaic>` and tiles
 * `chat | diff | terminal | file` according to the saved tree.
 *
 * Each tile gets its own slim header with a close button (and the chat tile
 * additionally exposes the split menu).
 */

interface AgentMosaicShellProps {
  conversationId: string;
  chat: ReactNode;
  diff: ReactNode;
  terminal: ReactNode;
  file: ReactNode;
}

const PANE_LABELS: Record<AgentPaneId, string> = {
  chat: "Chat",
  diff: "Diff",
  terminal: "Terminal",
  file: "Files",
};

const PANE_ICONS: Record<AgentPaneId, typeof MessageSquare> = {
  chat: MessageSquare,
  diff: FileDiff,
  terminal: Terminal,
  file: FolderTree,
};

export function AgentMosaicShell({
  conversationId,
  chat,
  diff,
  terminal,
  file,
}: AgentMosaicShellProps) {
  const layout = useAgentMosaicStore(
    (s) => s.layouts[conversationId] ?? null,
  );
  const setLayout = useAgentMosaicStore((s) => s.setLayout);
  const removePane = useAgentMosaicStore((s) => s.removePane);

  // Pick the right node for each leaf id.
  const childByPane = useMemo<Record<AgentPaneId, ReactNode>>(
    () => ({
      chat,
      diff,
      terminal,
      file,
    }),
    [chat, diff, terminal, file],
  );

  const handleChange = useCallback(
    (next: MosaicNode<AgentPaneId> | null) => {
      setLayout(conversationId, next);
    },
    [conversationId, setLayout],
  );

  const renderTile = useCallback(
    (id: AgentPaneId, path: MosaicPath) => {
      const Icon = PANE_ICONS[id];
      return (
        <MosaicWindow<AgentPaneId>
          path={path}
          title={PANE_LABELS[id]}
          draggable
          renderToolbar={() => (
            <div className="flex items-center justify-between w-full px-2 py-1 bg-bg-secondary border-b border-bg-border text-[11px] text-text-secondary select-none">
              <div className="flex items-center gap-1.5 min-w-0">
                <Icon size={11} />
                <span className="font-medium truncate">{PANE_LABELS[id]}</span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {id === "chat" && (
                  <AgentPaneSplitMenu conversationId={conversationId} />
                )}
                {id !== "chat" && (
                  <button
                    type="button"
                    onClick={() => removePane(conversationId, id)}
                    className="p-0.5 text-text-muted hover:text-text-primary rounded transition-colors"
                    title={`Close ${PANE_LABELS[id]} pane`}
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            </div>
          )}
        >
          <div className="h-full bg-bg-primary overflow-hidden">
            {childByPane[id]}
          </div>
        </MosaicWindow>
      );
    },
    [childByPane, conversationId, removePane],
  );

  // Fast path: no split — render chat directly so existing UX is unchanged.
  // (The chat header already carries its own controls; we don't want a
  // double-headed pane in the no-split case.)
  if (layout == null || layout === "chat") {
    return <div className="h-full w-full">{chat}</div>;
  }

  return (
    <div className="h-full w-full agent-mosaic-shell">
      <Mosaic<AgentPaneId>
        renderTile={renderTile}
        value={layout}
        onChange={handleChange}
      />
    </div>
  );
}
