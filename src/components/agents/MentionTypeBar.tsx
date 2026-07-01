import { File, Folder, Globe, GitBranch } from "lucide-react";
import type { MentionSource } from "@/types/mention";

interface MentionTypeBarProps {
  active: MentionSource;
  onChange: (source: MentionSource) => void;
  className?: string;
}

interface ChipDef {
  source: MentionSource;
  label: string;
  icon: React.ReactNode;
}

const CHIPS: ChipDef[] = [
  { source: "files", label: "Files", icon: <File size={12} /> },
  { source: "folders", label: "Folders", icon: <Folder size={12} /> },
  { source: "web", label: "Web", icon: <Globe size={12} /> },
  { source: "git", label: "Git", icon: <GitBranch size={12} /> },
];

/**
 * Tab bar rendered above the mention popover. Lets the user switch between
 * the typed mention sources (Files / Folders / Web / Git). Click a chip to
 * change the active source — the parent owns the `active` state.
 */
export function MentionTypeBar({
  active,
  onChange,
  className,
}: MentionTypeBarProps) {
  const containerClasses = [
    "flex items-center gap-1 px-1.5 py-1",
    "bg-bg-secondary border border-bg-border border-b-0 rounded-t",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={containerClasses} role="tablist" aria-label="Mention source">
      {CHIPS.map((chip) => {
        const isActive = chip.source === active;
        const chipClasses = [
          "flex items-center gap-1 px-2 py-0.5 rounded text-[11px]",
          "transition-colors motion-reduce:transition-none cursor-pointer select-none",
          isActive
            ? "bg-accent-green/20 text-accent-green"
            : "text-text-muted hover:bg-bg-tertiary hover:text-text-primary",
        ].join(" ");
        return (
          <button
            key={chip.source}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={chipClasses}
            onMouseDown={(e) => {
              // Prevent input from losing focus before we switch sources.
              e.preventDefault();
              onChange(chip.source);
            }}
          >
            <span className="flex-shrink-0">{chip.icon}</span>
            <span>{chip.label}</span>
          </button>
        );
      })}
    </div>
  );
}
