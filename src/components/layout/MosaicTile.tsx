import { useCallback, useContext } from "react";
import { Minus, Maximize2, GripHorizontal } from "lucide-react";
import { MosaicWindowContext } from "react-mosaic-component";
import { useMosaicStore } from "@/stores/mosaicStore";

interface MosaicTileProps {
  paneId: string;
  children: React.ReactNode;
}

/**
 * Wrapper for each mosaic tile. Provides a drag handle bar and minimize toggle.
 * The actual terminal content (TerminalPane or WorkspacePane) is rendered as children.
 */
export function MosaicTile({ paneId, children }: MosaicTileProps) {
  const { mosaicWindowActions } = useContext(MosaicWindowContext);
  const isMinimized = useMosaicStore((s) => s.minimizedPanes.has(paneId));
  const toggleMinimize = useMosaicStore((s) => s.toggleMinimize);

  const handleMinimize = useCallback(() => {
    toggleMinimize(paneId);
  }, [paneId, toggleMinimize]);

  // Build the drag handle element — connectDragSource wraps a ReactElement
  const dragHandle = (
    <div className="flex items-center gap-1 px-1.5 py-0.5 bg-bg-tertiary border-b border-bg-border cursor-grab active:cursor-grabbing select-none flex-shrink-0">
      <GripHorizontal size={10} className="text-text-muted flex-shrink-0" />
      <div className="flex-1" />
      <button
        onClick={handleMinimize}
        className="p-0.5 text-text-muted hover:text-text-primary transition-colors"
        title={isMinimized ? "Restore" : "Minimize"}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {isMinimized ? <Maximize2 size={10} /> : <Minus size={10} />}
      </button>
    </div>
  );

  // Let react-mosaic connect its drag source to the handle
  const connectedHandle = mosaicWindowActions?.connectDragSource(dragHandle) ?? dragHandle;

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-bg-primary">
      {connectedHandle}

      {/* Content — hidden when minimized */}
      <div
        className="flex-1 min-h-0 overflow-hidden"
        style={isMinimized ? { height: 0, overflow: "hidden" } : undefined}
      >
        {children}
      </div>
    </div>
  );
}
