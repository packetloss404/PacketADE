import { useCallback, useMemo } from "react";
import {
  Monitor,
  Folder,
  FolderOpen,
  Server,
  Check,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { repoDisplayName } from "@/stores/agentTaskStore";
import { useGitHubStore } from "@/stores/githubStore";
import { useProjectHistoryStore } from "@/stores/projectHistoryStore";
import { useServerStore } from "@/stores/serverStore";
import { useAppStore } from "@/stores/appStore";
import { isSshUri, makeSshUri, parseSshUri } from "@/lib/ssh-uri";
import type { ServerConfig } from "@/types/server";

interface ProjectPickerProps {
  selectedRepo: string | null;
  setSelectedRepo: (uri: string) => void;
}

type RecentItem =
  | { kind: "local"; path: string; ts: number }
  | { kind: "ssh"; server: ServerConfig; ts: number };

export function ProjectPicker({
  selectedRepo,
  setSelectedRepo,
}: ProjectPickerProps) {
  const repos = useGitHubStore((s) => s.repos);
  const projectHistory = useProjectHistoryStore((s) => s.projects);
  const recordOpenProject = useProjectHistoryStore((s) => s.recordOpen);
  const servers = useServerStore((s) => s.servers);
  const updateServer = useServerStore((s) => s.updateServer);
  const setActiveView = useAppStore((s) => s.setActiveView);

  const recentItems: RecentItem[] = useMemo(() => {
    const localSeen = new Set<string>();
    const local: RecentItem[] = [];
    for (const p of projectHistory) {
      if (!p.path || localSeen.has(p.path)) continue;
      localSeen.add(p.path);
      local.push({ kind: "local", path: p.path, ts: p.lastOpened });
    }
    const ssh: RecentItem[] = servers.map((s) => ({
      kind: "ssh",
      server: s,
      ts: s.lastConnectedAt ?? 0,
    }));
    return [...local, ...ssh].sort((a, b) => b.ts - a.ts);
  }, [projectHistory, servers]);

  const selectedSshUri = useMemo(
    () => (selectedRepo && isSshUri(selectedRepo) ? parseSshUri(selectedRepo) : null),
    [selectedRepo],
  );
  const selectedServer = useMemo(
    () =>
      selectedSshUri ? servers.find((s) => s.id === selectedSshUri.serverId) : undefined,
    [selectedSshUri, servers],
  );

  const currentDisplayName = useMemo(() => {
    if (!selectedRepo) return "Select a project";
    if (selectedSshUri) {
      return selectedServer ? selectedServer.name : "SSH target";
    }
    return repoDisplayName(selectedRepo, repos);
  }, [selectedRepo, repos, selectedSshUri, selectedServer]);

  const handleBrowse = useCallback(async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string" && picked) {
        setSelectedRepo(picked);
        recordOpenProject(picked);
      }
    } catch (err) {
      console.warn("Folder picker failed:", err);
    }
  }, [setSelectedRepo, recordOpenProject]);

  const handleSelectLocal = useCallback(
    (path: string) => setSelectedRepo(path),
    [setSelectedRepo],
  );

  const handleSelectSsh = useCallback(
    (server: ServerConfig) => {
      const initialPath = server.remotePath ?? "";
      setSelectedRepo(makeSshUri(server.id, initialPath || undefined));
      updateServer(server.id, { lastConnectedAt: Date.now() });
    },
    [setSelectedRepo, updateServer],
  );

  const handleRemotePathChange = useCallback(
    (path: string) => {
      if (!selectedSshUri) return;
      setSelectedRepo(makeSshUri(selectedSshUri.serverId, path || undefined));
    },
    [selectedSshUri, setSelectedRepo],
  );

  const handleOpenServersView = useCallback(() => {
    // Phase 2: servers are managed in the Tools / Servers view alongside
    // workspace PTY targets.
    setActiveView("tools");
  }, [setActiveView]);

  return (
    // Sits inside the launch composer's context strip, which owns the spacing.
    <div className="min-w-0">
      <Dropdown
        trigger={
          <span
            className={`flex items-center gap-1.5 ${
              selectedRepo ? "text-text-primary" : "text-text-muted"
            }`}
            title={
              selectedRepo && isSshUri(selectedRepo)
                ? "Remote SSH project"
                : undefined
            }
          >
            {selectedRepo && isSshUri(selectedRepo) ? (
              <Server
                size={12}
                className="text-accent-green"
              />
            ) : (
              <Monitor size={12} className="text-text-muted" />
            )}
            {currentDisplayName}
          </span>
        }
      >
        {recentItems.length > 0 && (
          <div className="px-3 py-1 text-meta uppercase tracking-wide text-text-muted">
            Recents
          </div>
        )}
        {recentItems.map((item) =>
          item.kind === "local" ? (
            <DropdownItem
              key={`local:${item.path}`}
              onClick={() => handleSelectLocal(item.path)}
            >
              <RecentRow
                icon={<Folder size={12} className="text-text-muted" />}
                label={repoDisplayName(item.path, repos)}
                selected={selectedRepo === item.path}
              />
            </DropdownItem>
          ) : (
            <DropdownItem
              key={`ssh:${item.server.id}`}
              onClick={() => handleSelectSsh(item.server)}
            >
              <span className="block">
                <RecentRow
                  icon={<Server size={12} className="text-accent-green" />}
                  label={item.server.name}
                  selected={selectedSshUri?.serverId === item.server.id}
                />
              </span>
            </DropdownItem>
          ),
        )}

        {recentItems.length > 0 && (
          <div className="my-1 border-t border-bg-border" />
        )}

        <DropdownItem onClick={handleBrowse}>
          <span className="flex items-center gap-1.5 text-text-secondary">
            <FolderOpen size={12} />
            Open Folder
          </span>
        </DropdownItem>
        <DropdownItem
          onClick={handleOpenServersView}
        >
          <span className="flex items-center gap-1.5 text-text-secondary">
            <Server size={12} />
            {servers.length === 0 ? "Configure servers…" : "Manage servers…"}
          </span>
        </DropdownItem>
      </Dropdown>

      {/* Inline remote-path editor for SSH selections. Servers are reusable
          across projects, so the path is per-conversation, not stored on
          the server config. Seeded from `ServerConfig.remotePath` on first
          pick; edits re-encode into `selectedRepo`. */}
      {selectedSshUri && selectedServer && (
        <div className="mt-2 flex items-center gap-1.5 text-ui">
          <Server size={11} className="text-accent-green shrink-0" />
          <span className="text-text-muted shrink-0">
            {selectedServer.username}@{selectedServer.host}
            {selectedServer.port !== 22 ? `:${selectedServer.port}` : ""}
            {": "}
          </span>
          <input
            type="text"
            value={selectedSshUri.remotePath ?? ""}
            onChange={(e) => handleRemotePathChange(e.target.value)}
            placeholder="/home/user/project"
            className="flex-1 bg-bg-primary border border-bg-border rounded px-1.5 py-0.5 text-ui text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green/50"
          />
        </div>
      )}
    </div>
  );
}

function RecentRow({
  icon,
  label,
  selected,
}: {
  icon: React.ReactNode;
  label: string;
  selected: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 min-w-0">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      {selected && <Check size={12} className="text-accent-green shrink-0" />}
    </div>
  );
}
