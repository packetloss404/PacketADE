import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { MODE_META, MODE_ORDER, type AgentMode } from "./utils";

interface ModeSelectorProps {
  value: AgentMode;
  onChange?: (mode: AgentMode) => void;
}

export function ModeSelector({ value, onChange }: ModeSelectorProps) {
  return (
    <SegmentedControl
      size="xs"
      aria-label="Agent mode"
      value={value}
      onChange={(m) => onChange?.(m)}
      options={MODE_ORDER.map((m) => ({
        value: m,
        label: MODE_META[m].label,
        icon: MODE_META[m].icon,
      }))}
    />
  );
}
