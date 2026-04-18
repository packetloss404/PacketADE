import { SplitSquareVertical, FileDiff, Terminal, FolderTree } from "lucide-react";
import { isSplitNode } from "react-mosaic-component";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import {
  useAgentMosaicStore,
  type AgentPaneId,
} from "@/stores/agentMosaicStore";
import type { MosaicNode } from "@/types/mosaic";

/**
 * Header affordance for splitting the AgentChatPane into multiple tiles.
 *
 * Lives next to the chat-pane title; opens a small dropdown listing the
 * splittable surfaces (diff / terminal / file). Each entry calls
 * `agentMosaicStore.addPane`, which is a no-op if the pane is already in the
 * mosaic — so users can't accidentally double-add.
 */

interface AgentPaneSplitMenuProps {
  conversationId: string;
}

interface PaneOption {
  id: Exclude<AgentPaneId, "chat">;
  label: string;
  icon: typeof FileDiff;
  description: string;
}

const OPTIONS: PaneOption[] = [
  {
    id: "diff",
    label: "Diff",
    icon: FileDiff,
    description: "Per-file diff browser",
  },
  {
    id: "terminal",
    label: "Terminal",
    icon: Terminal,
    description: "PTY in this project",
  },
  {
    id: "file",
    label: "File explorer",
    icon: FolderTree,
    description: "Project file tree",
  },
];

export function AgentPaneSplitMenu({ conversationId }: AgentPaneSplitMenuProps) {
  const layout = useAgentMosaicStore((s) => s.layouts[conversationId] ?? null);
  const addPane = useAgentMosaicStore((s) => s.addPane);

  // Determine which panes are already mounted to dim the option.
  const mounted = collectLeafIds(layout);

  return (
    <Dropdown
      align="right"
      trigger={
        <span
          className="flex items-center gap-1 text-[11px] text-text-secondary"
          title="Split this conversation into panes"
        >
          <SplitSquareVertical size={11} />
          Split
        </span>
      }
    >
      {OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const alreadyOpen = mounted.includes(opt.id);
        return (
          <DropdownItem
            key={opt.id}
            onClick={() => {
              if (alreadyOpen) return;
              addPane(conversationId, opt.id);
            }}
          >
            <span
              className={`flex items-center gap-2 text-[11px] ${
                alreadyOpen ? "text-text-muted" : "text-text-primary"
              }`}
            >
              <Icon size={11} />
              <span className="flex flex-col">
                <span>
                  {opt.label}
                  {alreadyOpen && (
                    <span className="ml-1 text-[10px] text-text-muted">
                      (open)
                    </span>
                  )}
                </span>
                <span className="text-[10px] text-text-muted">
                  {opt.description}
                </span>
              </span>
            </span>
          </DropdownItem>
        );
      })}
    </Dropdown>
  );
}

/* Local copy of the leaf-collection helper so this component doesn't reach
 * into store internals. Mirrors the n-ary tree shape used by
 * react-mosaic-component v7 (split nodes have `children`, tabs nodes have
 * `tabs`, leaves are plain strings). */
function collectLeafIds(
  node: MosaicNode<AgentPaneId> | null,
): AgentPaneId[] {
  if (node == null) return [];
  if (typeof node === "string") return [node];
  if (isSplitNode(node)) {
    return node.children.flatMap((c) => collectLeafIds(c));
  }
  if ("tabs" in node) return node.tabs;
  return [];
}
