import { Zap } from "lucide-react";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { AuthBadge, type AuthStatus } from "@/components/ui/AuthBadge";
import type { AgentCli } from "@/stores/agentTaskStore";
import { getProviderForAgent } from "@/lib/api-models";
import { PROVIDER_GROUPS } from "./utils";
import type { AuthEntry } from "../hooks/useProviderAuthStatus";

interface ProviderPickerProps {
  selectedAgent: AgentCli;
  onAgentChange: (agent: AgentCli) => void;
  onModelChange: (model: string) => void;
  authStatus: Record<string, AuthEntry>;
  refreshAuthStatuses: () => void;
}

export function ProviderPicker({
  selectedAgent,
  onAgentChange,
  onModelChange,
  authStatus,
  refreshAuthStatuses,
}: ProviderPickerProps) {
  const selectedAuth = authStatus[selectedAgent];
  const selectedAuthStatus: AuthStatus =
    selectedAuth === "loading" || !selectedAuth
      ? "loading"
      : selectedAuth.status;

  return (
    <Dropdown
      searchable
      searchPlaceholder="Search providers…"
      trigger={
        <span
          className="text-text-secondary flex items-center gap-1"
          // Refresh auth statuses when the user opens the dropdown.
          // onMouseDown fires before Dropdown's click-toggle, so the
          // fetch is already in flight by the time the menu renders.
          onMouseDown={refreshAuthStatuses}
        >
          <Zap size={10} className="text-accent-amber" />
          {getProviderForAgent(selectedAgent)?.name ?? "Select Provider"}
          <AuthBadge
            status={selectedAuthStatus}
            hint={
              selectedAuth && selectedAuth !== "loading"
                ? selectedAuth.hint
                : ""
            }
            className="ml-1"
          />
        </span>
      }
    >
      {PROVIDER_GROUPS.map((group, gi) => {
        // Build the renderable rows — skip agents with no API_PROVIDERS
        // entry, which is how a retired id (e.g. `api-openai-codex`) stays
        // out of the picker even if it lingers in a group list.
        const rows = group.agents
          .map((agent) => ({
            agent,
            info: getProviderForAgent(agent),
          }))
          .filter(
            (r): r is { agent: AgentCli; info: NonNullable<typeof r.info> } =>
              !!r.info,
          );
        if (rows.length === 0) return null;
        return (
          <div key={group.label}>
            {gi > 0 && <div className="my-1 border-t border-bg-border" />}
            <div className="text-meta uppercase tracking-wide text-text-muted px-3 py-1">
              {group.label}
            </div>
            {rows.map(({ agent, info }) => {
              const entry = authStatus[agent];
              const status: AuthStatus =
                entry === "loading" || !entry ? "loading" : entry.status;
              const hint = entry && entry !== "loading" ? entry.hint : "";
              const dim = status !== "ready";
              return (
                <DropdownItem
                  key={agent}
                  onClick={() => {
                    onAgentChange(agent);
                    onModelChange(info.models[0]?.value ?? "");
                  }}
                >
                  <span
                    className={`flex items-center justify-between gap-2 ${dim ? "opacity-50" : ""}`}
                  >
                    <span className="flex items-center gap-1.5">
                      <Zap size={10} className="text-accent-amber" />
                      {info.name}
                    </span>
                    <AuthBadge status={status} hint={hint} />
                  </span>
                </DropdownItem>
              );
            })}
          </div>
        );
      })}
    </Dropdown>
  );
}
