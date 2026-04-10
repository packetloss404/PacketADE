import { Plus, LayoutGrid } from "lucide-react";
import { useMosaicStore } from "@/stores/mosaicStore";
import type { MosaicLayoutPreset } from "@/types/mosaic";

interface MosaicToolbarProps {
  paneCount: number;
  onAddPane?: () => void;
  paneIds: string[];
}

const PRESETS: { preset: MosaicLayoutPreset; label: string; minPanes: number }[] = [
  { preset: "1x1", label: "1×1", minPanes: 1 },
  { preset: "1x2", label: "1×2", minPanes: 2 },
  { preset: "2x1", label: "2×1", minPanes: 2 },
  { preset: "2x2", label: "2×2", minPanes: 4 },
  { preset: "2x3", label: "2×3", minPanes: 5 },
  { preset: "3x2", label: "3×2", minPanes: 6 },
];

export function MosaicToolbar({ paneCount, onAddPane, paneIds }: MosaicToolbarProps) {
  const applyPreset = useMosaicStore((s) => s.applyPreset);

  return (
    <div className="flex items-center gap-1.5 px-3 py-1 bg-bg-secondary border-b border-bg-border">
      <LayoutGrid size={11} className="text-accent-green flex-shrink-0" />
      <span className="text-[10px] text-text-secondary">
        {paneCount} pane{paneCount !== 1 ? "s" : ""}
      </span>

      <div className="w-px h-3 bg-bg-border mx-1" />

      {/* Preset buttons */}
      {PRESETS.filter((p) => p.minPanes <= paneCount).map(({ preset, label }) => (
        <button
          key={preset}
          onClick={() => applyPreset(preset, paneIds)}
          className="px-1.5 py-0.5 text-[9px] text-text-muted hover:text-text-primary bg-bg-primary border border-bg-border rounded transition-colors hover:border-accent-green/30"
          title={`Apply ${label} layout`}
        >
          {label}
        </button>
      ))}

      <div className="flex-1" />

      {onAddPane && (
        <button
          onClick={onAddPane}
          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-text-muted hover:text-accent-green transition-colors"
          title="Add pane (Ctrl+\\)"
        >
          <Plus size={10} />
        </button>
      )}
    </div>
  );
}
