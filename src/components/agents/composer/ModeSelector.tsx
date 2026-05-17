import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { MODE_META, MODE_ORDER, type AgentMode } from "./utils";

interface ModeSelectorProps {
  value: AgentMode;
  onChange?: (mode: AgentMode) => void;
}

export function ModeSelector({ value, onChange }: ModeSelectorProps) {
  const current = MODE_META[value];
  const CurrentIcon = current.icon;
  return (
    <Dropdown
      trigger={
        <span className="text-text-secondary flex items-center gap-1">
          <CurrentIcon size={10} className={current.color} />
          {current.label}
        </span>
      }
    >
      {MODE_ORDER.map((m) => {
        const meta = MODE_META[m];
        const Icon = meta.icon;
        return (
          <DropdownItem key={m} onClick={() => onChange?.(m)}>
            <span className="flex items-center gap-1.5">
              <Icon size={10} className={meta.color} />
              <span className={value === m ? "text-accent-green" : ""}>
                {meta.label}
              </span>
              <span className="text-text-muted text-[9px] ml-1">
                {meta.description}
              </span>
            </span>
          </DropdownItem>
        );
      })}
    </Dropdown>
  );
}
