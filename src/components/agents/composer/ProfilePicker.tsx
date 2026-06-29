import { User, Check } from "lucide-react";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import type { AgentProfile } from "@/types/profiles";

interface ProfilePickerProps {
  profiles: AgentProfile[];
  selectedProfileId: string | undefined;
  activeProfile: AgentProfile | undefined;
  onProfileChange?: (id: string) => void;
  setDefaultProfile: (id: string) => void;
}

export function ProfilePicker({
  profiles,
  selectedProfileId,
  activeProfile,
  onProfileChange,
  setDefaultProfile,
}: ProfilePickerProps) {
  return (
    <Dropdown
      searchable
      searchPlaceholder="Search profiles…"
      trigger={
        <span
          className="text-text-secondary flex items-center gap-1"
          title={
            activeProfile
              ? `Profile: ${activeProfile.name} — ${activeProfile.description}`
              : "Pick an agent profile"
          }
        >
          <User size={10} className="text-accent-blue" />
          {activeProfile?.name ?? "Default"}
        </span>
      }
    >
      {profiles.length === 0 ? (
        <div className="px-3 py-1.5 text-[10px] text-text-muted">
          No profiles
        </div>
      ) : (
        profiles.map((p) => (
          <DropdownItem
            key={p.id}
            onClick={() => {
              onProfileChange?.(p.id);
              setDefaultProfile(p.id);
            }}
          >
            <span className="flex items-center gap-1.5">
              <User
                size={10}
                className={
                  p.isBuiltin ? "text-accent-blue" : "text-accent-purple"
                }
              />
              <span
                className={
                  selectedProfileId === p.id ? "text-accent-green" : ""
                }
              >
                {p.name}
              </span>
              <span className="text-text-muted text-[9px] ml-1 truncate max-w-[200px]">
                {p.description}
              </span>
              {selectedProfileId === p.id && (
                <Check size={12} className="text-accent-green shrink-0 ml-auto" />
              )}
            </span>
          </DropdownItem>
        ))
      )}
    </Dropdown>
  );
}
