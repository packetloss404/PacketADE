import { Server, Check } from "lucide-react";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { useServerStore } from "@/stores/serverStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAppStore } from "@/stores/appStore";

export function ServerSelectorPopover() {
  const servers = useServerStore((s) => s.servers);
  const selectedServerId = useAgentTaskStore((s) => s.selectedServerId);
  const setSelectedServerId = useAgentTaskStore((s) => s.setSelectedServerId);
  const setActiveView = useAppStore((s) => s.setActiveView);

  const selectedServer = servers.find((s) => s.id === selectedServerId);
  const label = selectedServer ? `SSH: ${selectedServer.name}` : "Connect SSH";

  return (
    <Dropdown
      trigger={
        <span className="flex items-center gap-1.5">
          <Server
            size={11}
            className={selectedServer ? "text-accent-green" : "text-text-muted"}
          />
          {label}
        </span>
      }
    >
      {servers.length === 0 ? (
        <DropdownItem onClick={() => setActiveView("tools")}>
          <span className="text-text-muted">Configure Servers…</span>
        </DropdownItem>
      ) : (
        <>
          {servers.map((server) => (
            <DropdownItem
              key={server.id}
              onClick={() =>
                setSelectedServerId(server.id === selectedServerId ? null : server.id)
              }
            >
              <span className="flex items-center gap-2">
                {server.id === selectedServerId && <Check size={10} className="text-accent-green" />}
                <span>{server.name}</span>
                <span className="text-text-muted ml-auto text-[10px]">
                  {server.host}
                  {server.port !== 22 ? `:${server.port}` : ""}
                </span>
              </span>
            </DropdownItem>
          ))}
        </>
      )}
    </Dropdown>
  );
}
