import type { ReactNode } from "react";
import { Check } from "lucide-react";

type CheckboxProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
};

export function Checkbox({ checked, onChange, label, disabled = false, className = "" }: CheckboxProps) {
  return (
    <label
      className={`inline-flex items-center gap-2 text-xs text-text-secondary select-none ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"} ${className}`}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`inline-flex items-center justify-center w-4 h-4 rounded border transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-line disabled:cursor-not-allowed ${checked ? "bg-accent-green/20 border-accent-green text-accent-green" : "bg-bg-primary border-bg-border text-transparent"}`}
      >
        <Check size={11} strokeWidth={3} className={checked ? "opacity-100" : "opacity-0"} />
      </button>
      {label != null && <span>{label}</span>}
    </label>
  );
}
