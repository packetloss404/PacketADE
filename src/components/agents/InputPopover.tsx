import React from "react";

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
  className?: string;
}

export function InputPopover({
  visible,
  items,
  highlightedIndex,
  onSelect,
  emptyLabel = "No matches",
  className,
}: InputPopoverProps) {
  if (!visible) return null;

  const classes = [
    "absolute bottom-full mb-1 left-0 z-50 min-w-[220px] max-w-[420px]",
    "bg-bg-secondary border border-bg-border rounded shadow-lg",
    "max-h-[200px] overflow-y-auto",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} role="listbox">
      {items.length === 0 ? (
        <div className="px-2 py-1.5 text-[11px] text-text-secondary italic">
          {emptyLabel}
        </div>
      ) : (
        items.map((item, idx) => {
          const isHighlighted = idx === highlightedIndex;
          const rowClasses = [
            "flex items-center gap-2 px-2 py-1.5 cursor-pointer text-xs",
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
                <span className="text-[10px] text-text-secondary truncate ml-auto">
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
