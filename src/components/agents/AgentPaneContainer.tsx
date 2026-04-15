import { Plus, X } from "lucide-react";
import { AgentChatPane } from "./AgentChatPane";

interface AgentPaneContainerProps {
  conversationIds: string[];
  onClosePane: (id: string) => void;
  onAddPane: () => void;
  maxPanes?: number;
}

export function AgentPaneContainer({
  conversationIds,
  onClosePane,
  onAddPane,
  maxPanes = 4,
}: AgentPaneContainerProps) {
  const count = conversationIds.length;

  const gridClass =
    count === 1
      ? "grid-cols-1 grid-rows-1"
      : count === 2
        ? "grid-cols-2 grid-rows-1"
        : "grid-cols-2 grid-rows-2";

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-bg-border bg-bg-secondary">
        <span className="text-[11px] font-medium text-text-secondary">
          Agent Panes ({count})
        </span>
        <span className="text-[9px] text-text-muted ml-2">
          Ctrl+1-{count} focus &middot; Ctrl+W close
        </span>
        {count < maxPanes && (
          <button
            onClick={onAddPane}
            className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-text-muted hover:text-accent-green hover:bg-accent-green/10 rounded transition-colors"
            title="Add pane"
          >
            <Plus size={12} />
            Add Pane
          </button>
        )}
      </div>

      {/* Grid of panes */}
      <div className={`flex-1 grid ${gridClass} overflow-hidden`}>
        {conversationIds.map((id, index) => {
          // For 3 panes, the last one spans 2 columns (full width bottom row)
          const spanClass =
            count === 3 && index === 2 ? "col-span-2" : "";

          // Border classes: right border for left-column panes, bottom border for top-row panes
          const isTopRow = count >= 3 && index < 2;
          const showRightBorder =
            count === 2
              ? index === 0
              : count === 3
                ? index === 0
                : count === 4
                  ? index % 2 === 0
                  : false;
          const showBottomBorder = isTopRow;

          const borderClasses = [
            showRightBorder ? "border-r border-bg-border" : "",
            showBottomBorder ? "border-b border-bg-border" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <div
              key={id}
              className={`relative overflow-hidden ${spanClass} ${borderClasses}`}
            >
              {/* Close button overlay */}
              {count > 1 && (
                <button
                  onClick={() => onClosePane(id)}
                  className="absolute top-1.5 right-1.5 z-10 p-0.5 text-text-muted hover:text-accent-red hover:bg-bg-hover rounded transition-colors opacity-0 hover:opacity-100 focus:opacity-100"
                  style={{ transition: "opacity 150ms" }}
                  title="Close pane"
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.opacity = "1";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.opacity = "0";
                  }}
                >
                  <X size={12} />
                </button>
              )}
              <AgentChatPane conversationId={id} onClose={() => onClosePane(id)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
