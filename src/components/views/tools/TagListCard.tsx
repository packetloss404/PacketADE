import { useState } from "react";
import { X } from "lucide-react";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";

interface TagListCardProps {
  title: string;
  items: string[];
  onAdd: (item: string) => void;
  /**
   * When supplied, every tag gets a remove affordance. Without it the card
   * stays add-only, which is what Epics and Labels shipped as: a typo could be
   * added but never taken back.
   */
  onRemove?: (item: string) => void;
  /** Singular noun for the confirm copy, e.g. "epic". Required with `onRemove`. */
  entityLabel?: string;
  /**
   * Live consequences for the confirm callout — e.g. how many issues still
   * carry the tag. Returning `[]` renders no callout.
   */
  removeWarnings?: (item: string) => string[];
  tagClassName: string;
  placeholder: string;
}

export function TagListCard({
  title,
  items,
  onAdd,
  onRemove,
  entityLabel = "item",
  removeWarnings,
  tagClassName,
  placeholder,
}: TagListCardProps) {
  const [value, setValue] = useState("");
  // Removal is destructive and reaches beyond the chip the user clicked (it
  // detaches the tag from existing issues), so it routes through the sanctioned
  // ConfirmDeleteModal rather than firing on click.
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);

  function handleAdd() {
    if (value.trim()) {
      onAdd(value.trim());
      setValue("");
    }
  }

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-primary mb-3">
        {title}
      </h3>
      <div className="flex gap-1 mb-2">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          className="flex-1 bg-bg-primary border border-bg-border rounded px-2 py-1 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
          onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
        />
        <button
          onClick={handleAdd}
          className="px-2 py-1 text-xs text-accent-green hover:bg-accent-green/15 rounded transition-colors"
        >
          Add
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {items.map((item) => (
          <span
            key={item}
            className={`group inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded ${tagClassName}`}
          >
            {item}
            {onRemove && (
              <button
                type="button"
                aria-label={`Remove ${entityLabel} ${item}`}
                title={`Remove ${entityLabel}`}
                onClick={() => setPendingRemoval(item)}
                className="text-text-muted hover:text-accent-red opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
              >
                <X size={10} />
              </button>
            )}
          </span>
        ))}
      </div>

      {onRemove && pendingRemoval !== null && (
        <ConfirmDeleteModal
          title={`Remove ${entityLabel}?`}
          entityName={pendingRemoval}
          description={`will be removed from the ${entityLabel} list.`}
          warnings={removeWarnings?.(pendingRemoval) ?? []}
          warningTitle="Removing it also"
          confirmLabel="Remove"
          onConfirm={() => {
            onRemove(pendingRemoval);
            setPendingRemoval(null);
          }}
          onClose={() => setPendingRemoval(null)}
        />
      )}
    </div>
  );
}
