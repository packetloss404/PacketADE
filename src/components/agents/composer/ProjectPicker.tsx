import { useCallback, useMemo } from "react";
import {
  Monitor,
  Folder,
  FolderOpen,
  Server,
  Check,
  ShieldAlert,
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

  /**
   * True when the selected SSH server has no pinned host key.
   *
   * FAULT this surfaces: an unpinned host falls back to TOFU
   * (`StrictHostKeyChecking=accept-new`) on this path — see `lib/ssh.ts` and
   * `core::execution::SshConfig::ssh_args` — and the ONLY signals were a
   * `console.warn` and a Rust `tracing::warn!`. Neither is visible to the
   * person deciding to connect. Workspace creation and Async Flight launches
   * already gate on this; the composer did not, so the weaker guarantee was
   * invisible exactly where the connection is actually made.
   *
   * This is a disclosure, not a block: the TOFU fallback is deliberate
   * backward compatibility for servers saved before pinning existed, and
   * hard-failing them here would break working setups. What must not happen is
   * it being SILENT.
   */
  const unpinned = Boolean(selectedServer && !selectedServer.hostFingerprint);

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
                ? unpinned
                  ? "Remote SSH project — host key not verified"
                  : "Remote SSH project"
                : undefined
            }
          >
            {selectedRepo && isSshUri(selectedRepo) ? (
              <Server
                size={12}
                className={unpinned ? "text-accent-amber" : "text-accent-green"}
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
                  icon={
                    <Server
                      size={12}
                      className={
                        item.server.hostFingerprint
                          ? "text-accent-green"
                          : "text-accent-amber"
                      }
                    />
                  }
                  label={item.server.name}
                  selected={selectedSshUri?.serverId === item.server.id}
                  // Flagged BEFORE the pick, not only after: the same
                  // unpinned-host fact the Workspace and Flight launch gates
                  // already surface.
                  note={item.server.hostFingerprint ? undefined : "unverified host key"}
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


      {/* The point of connect. An unpinned host is about to be trusted on
          first sight (TOFU), which is a materially weaker guarantee than the
          pinned path — so say so here, where the decision is made, rather than
          only in a console the user never opens. */}
      {selectedSshUri && selectedServer && unpinned && (
        <div className="mt-2 flex items-start gap-1.5 rounded border border-accent-amber/30 bg-accent-amber/5 px-2 py-1.5 text-meta">
          <ShieldAlert size={11} className="mt-px shrink-0 text-accent-amber" />
          <div className="min-w-0 flex-1">
            <span className="font-medium text-accent-amber">Host key not verified.</span>{" "}
            <span className="text-text-secondary">
              This session will trust whatever key {selectedServer.host} presents on first
              connect. Verify it on the Servers page to pin the key.
            </span>
            <button
              type="button"
              onClick={handleOpenServersView}
              className="ml-1 underline hover:text-accent-amber"
            >
              Open Servers
            </button>
          </div>
        </div>
      )}

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
  note,
}: {
  icon: React.ReactNode;
  label: string;
  selected: boolean;
  note?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 min-w-0">
        {icon}
        <span className="truncate">{label}</span>
        {note && <span className="shrink-0 text-meta text-accent-amber">{note}</span>}
      </span>
      {selected && <Check size={12} className="text-accent-green shrink-0" />}
    </div>
  );
}
