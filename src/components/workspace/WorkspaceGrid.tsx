import { useMemo } from "react";
import { computeGridLayout } from "@/lib/gridLayout";
import { WorkspacePane } from "./WorkspacePane";
import type { Workspace } from "@/types/workspace";

interface WorkspaceGridProps {
  workspace: Workspace;
}

export function WorkspaceGrid({ workspace }: WorkspaceGridProps) {
  const layout = useMemo(
    () => computeGridLayout(workspace.agents.length),
    [workspace.agents.length]
  );

  return (
    <div
      className="flex-1 overflow-hidden p-1 gap-1"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${layout.cols}, 1fr)`,
        gridTemplateRows: `repeat(${layout.rows}, 1fr)`,
      }}
    >
      {layout.cells.map((cell) => {
        if (cell.agentIndex === null) {
          return (
            <div
              key={`empty-${cell.row}-${cell.col}`}
              className="border border-dashed border-bg-border rounded flex items-center justify-center text-text-muted text-xs"
            />
          );
        }
        const pane = workspace.panes[cell.agentIndex];
        if (!pane) return null;
        return (
          <WorkspacePane
            key={pane.id}
            pane={pane}
            workspaceId={workspace.id}
          />
        );
      })}
    </div>
  );
}
