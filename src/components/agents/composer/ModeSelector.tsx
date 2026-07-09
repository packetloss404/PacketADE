import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { MODE_META, MODE_ORDER, type AgentMode } from "./utils";

interface ModeSelectorProps {
  value: AgentMode;
  onChange?: (mode: AgentMode) => void;
  /**
   * P1-S4 (Codex honesty): when the selected provider's adapter can't honor
   * approval round-trips (Codex `exec`), the approval-implying "Manual"
   * launch mode is filtered out — the sandbox, not a per-tool prompt, is the
   * safety boundary. Defaults to `true` (full set) for approval-capable
   * providers and every non-launch caller.
   */
  supportsApprovals?: boolean;
}

export function ModeSelector({
  value,
  onChange,
  supportsApprovals = true,
}: ModeSelectorProps) {
  const modes = supportsApprovals
    ? MODE_ORDER
    : MODE_ORDER.filter((m) => m !== "manual");
  return (
    <SegmentedControl
      size="xs"
      aria-label="Agent mode"
      value={value}
      onChange={(m) => onChange?.(m)}
      options={modes.map((m) => ({
        value: m,
        label: MODE_META[m].label,
        icon: MODE_META[m].icon,
      }))}
    />
  );
}
