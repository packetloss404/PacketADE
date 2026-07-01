import { useRef } from "react";
import type { LucideIcon } from "lucide-react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "xs" | "sm";
  className?: string;
  "aria-label"?: string;
}

const sizes = {
  xs: "px-2 py-0.5 text-[11px] gap-1",
  sm: "px-2.5 py-1 text-xs gap-1.5",
};

const iconSizes = {
  xs: 11,
  sm: 12,
};

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = "sm",
  className = "",
  "aria-label": ariaLabel,
}: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (index: number, delta: number) => {
    const next = (index + delta + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      move(index, -1);
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      move(index, 1);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`inline-flex items-center bg-bg-tertiary rounded p-0.5 ${className}`}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={`inline-flex items-center justify-center rounded font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-line ${sizes[size]} ${
              active
                ? "bg-bg-elevated text-text-primary shadow-sm"
                : "text-text-muted hover:text-text-secondary"
            }`}
          >
            {Icon && <Icon size={iconSizes[size]} />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
