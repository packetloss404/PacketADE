import React, { useEffect, useRef } from "react";
import { Spinner } from "@/components/ui/Spinner";

export interface InputPopoverItem {
  key: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
}

interface InputPopoverProps {
  visible: boolean;
  items: InputPopoverItem[];
  highlightedIndex: number;
  onSelect: (item: InputPopoverItem) => void;
  emptyLabel?: string;
  /** Show a centered spinner row instead of items/empty while fetching. */
  loading?: boolean;
  /** When true (default) the popover anchors itself above the textarea via
   * `absolute bottom-full`. Set false when embedded inside another positioned
   * shell (e.g. the mention type bar) so it flows in-document. */
  floating?: boolean;
  className?: string;
}

export function InputPopover({
  visible,
  items,
  highlightedIndex,
  onSelect,
  emptyLabel = "No matches",
  loading = false,
  floating = true,
  className,
}: InputPopoverProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Clamp so the highlight stays valid after the item list shrinks (source or
  // query change) without waiting for the next arrow key.
  const hi = items.length === 0 ? -1 : Math.min(highlightedIndex, items.length - 1);

  // Keep the keyboard-highlighted row scrolled into view.
  useEffect(() => {
    const el = containerRef.current?.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]',
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  if (!visible) return null;

  const classes = [
    floating ? "absolute bottom-full mb-1 left-0 z-50" : "",
    "min-w-[220px] max-w-[420px]",
    "bg-bg-secondary border border-bg-border rounded shadow-xl",
    "max-h-[200px] overflow-y-auto",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={containerRef} className={classes} role="listbox">
      {loading ? (
        <div className="flex items-center gap-2 px-2 py-1.5 text-ui text-text-muted">
          <Spinner size={12} />
          Searching…
        </div>
      ) : items.length === 0 ? (
        <div className="px-2 py-1.5 text-ui text-text-secondary italic">
          {emptyLabel}
        </div>
      ) : (
        items.map((item, idx) => {
          const isHighlighted = idx === hi;
          const rowClasses = [
            "flex items-center gap-2 px-2 py-1.5 cursor-pointer text-ui",
            "transition-colors motion-reduce:transition-none hover:bg-bg-hover",
            isHighlighted ? "bg-bg-hover" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              key={item.key}
              className={rowClasses}
              role="option"
              aria-selected={isHighlighted}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(item);
              }}
            >
              {item.icon && (
                <span className="flex-shrink-0 text-text-secondary">
                  {item.icon}
                </span>
              )}
              <span className="text-text-primary truncate">{item.label}</span>
              {item.description && (
                <span className="text-meta text-text-secondary truncate ml-auto">
                  {item.description}
                </span>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
