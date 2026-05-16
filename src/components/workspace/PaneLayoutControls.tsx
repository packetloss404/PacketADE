import { LayoutGrid } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useMosaicStore } from "@/stores/mosaicStore";
import type { MosaicLayoutPreset } from "@/types/mosaic";

const LAYOUT_PRESETS: { preset: MosaicLayoutPreset; label: string; minPanes: number }[] = [
  { preset: "1x1", label: "1×1", minPanes: 1 },
  { preset: "1x2", label: "1×2", minPanes: 2 },
  { preset: "2x1", label: "2×1", minPanes: 2 },
  { preset: "2x2", label: "2×2", minPanes: 4 },
  { preset: "2x3", label: "2×3", minPanes: 5 },
  { preset: "3x2", label: "3×2", minPanes: 6 },
];

/**
 * Pane-layout preset controls for the active workspace.
 *
 * v0.8.2: moved out of the global Toolbar into the WorkspaceView chrome.
 * Mosaic presets only mean something when a workspace is active — rendering
 * them on every view (Agents, GitHub, Issues, etc.) was a no-op. The
 * component is self-sufficient: it reads `activeWorkspaceId` / `panes` from
 * `useWorkspaceStore` and `applyPreset` from `useMosaicStore`, and renders
 * `null` when no workspace is active.
 */
export function PaneLayoutControls() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const applyPreset = useMosaicStore((s) => s.applyPreset);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  if (!activeWorkspace) return null;

  const paneIds = activeWorkspace.panes.map((p) => p.id);
  const paneCount = paneIds.length;

  return (
    <div
      className="flex items-center gap-1"
      title="Pane layout — current workspace tile count and quick layout presets. Click a preset to rearrange."
    >
      <div className="w-px h-4 bg-bg-border" />
      <LayoutGrid size={12} className="text-accent-green flex-shrink-0" />
      <span className="text-[10px] text-text-secondary">
        {paneCount} pane{paneCount !== 1 ? "s" : ""}
      </span>
      {LAYOUT_PRESETS.filter((p) => p.minPanes <= paneCount).map(({ preset, label }) => (
        <button
          key={preset}
          onClick={() => applyPreset(preset, paneIds)}
          className="px-1.5 py-0.5 text-[9px] text-text-muted hover:text-text-primary bg-bg-primary border border-bg-border rounded transition-colors hover:border-accent-green/30"
          title={`Arrange the ${paneCount} workspace panes into a ${label} grid.`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
