import { useState } from "react";
import { FolderOpen, GitBranch, FolderSearch, LayoutGrid, Info } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useLayoutStore } from "@/stores/layoutStore";
import { useProjectHistoryStore } from "@/stores/projectHistoryStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { WorkspaceCreationModal } from "@/components/workspace/WorkspaceCreationModal";

interface ProjectInfoCardProps {
  projectPath: string;
  gitBranch: string | null;
}

export function ProjectInfoCard({ projectPath, gitBranch }: ProjectInfoCardProps) {
  const setProjectPath = useLayoutStore((s) => s.setProjectPath);
  const projectsFolder = useProjectHistoryStore((s) => s.projectsFolder);
  const setProjectsFolder = useProjectHistoryStore((s) => s.setProjectsFolder);
  // v0.8.8: projectPath is derived from the active workspace via the
  // layoutStore subscription (v88-A). Surfacing the workspace name next
  // to the path makes it obvious which workspace will be rebound when
  // the user hits Browse, and lets us swap in a "Create workspace" CTA
  // when there's nothing to rebind.
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);

  const handleBrowse = async () => {
    const title = activeWorkspace
      ? `Change folder for "${activeWorkspace.name}"`
      : "Select Project Folder";
    const selected = await open({ directory: true, title });
    if (selected) {
      setProjectPath(selected);
    }
  };

  const handleBrowseProjectsFolder = async () => {
    const selected = await open({ directory: true, title: "Select Default Projects Folder" });
    if (selected) {
      setProjectsFolder(selected);
    }
  };

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-primary mb-3 flex items-center gap-2">
        <FolderOpen size={12} />
        Project
      </h3>
      <div className="flex flex-col gap-3 text-xs">
        {/* Active workspace context — or a CTA when none is open. */}
        {activeWorkspace ? (
          <>
            <div className="flex items-center gap-2">
              <span className="text-text-muted">Path: </span>
              <span className="text-text-secondary truncate flex-1" title={projectPath}>{projectPath}</span>
              <button
                onClick={handleBrowse}
                className="px-2 py-0.5 text-[11px] bg-bg-tertiary hover:bg-bg-border text-text-secondary rounded transition-colors"
              >
                Browse
              </button>
            </div>
            <div className="flex items-center gap-1.5 -mt-1">
              <LayoutGrid size={10} className="text-accent-green" />
              <span className="text-[10px] text-text-muted">Active: </span>
              <span className="text-[10px] text-text-secondary truncate">{activeWorkspace.name}</span>
            </div>
            <p className="text-[10px] text-text-muted flex items-start gap-1.5 -mt-1">
              <Info size={10} className="flex-shrink-0 mt-px" />
              <span>
                This is the active workspace's project folder. To change a different
                workspace's path, switch to it first.
              </span>
            </p>
            {gitBranch && (
              <div className="flex items-center gap-1">
                <span className="text-text-muted">Branch: </span>
                <GitBranch size={10} className="text-accent-purple" />
                <span className="text-text-secondary">{gitBranch}</span>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-2 bg-bg-primary border border-bg-border rounded p-3">
            <p className="text-[11px] text-text-secondary">
              No workspace is open. Workspaces own their project folder — create one to
              bind a path.
            </p>
            {projectPath && (
              <p className="text-[10px] text-text-muted truncate" title={projectPath}>
                Last used folder: <span className="font-mono text-text-secondary">{projectPath}</span>
              </p>
            )}
            <button
              onClick={() => setShowCreateWorkspace(true)}
              className="self-start mt-1 flex items-center gap-1.5 px-2.5 py-1 text-[11px] bg-accent-green/15 text-accent-green border border-accent-green/30 rounded font-medium hover:bg-accent-green/25 transition-colors"
            >
              <LayoutGrid size={11} />
              Create workspace
            </button>
          </div>
        )}

        {/* Projects folder setting */}
        <div className="border-t border-bg-border pt-3 mt-1">
          <div className="flex items-center gap-2 mb-1.5">
            <FolderSearch size={11} className="text-accent-amber" />
            <span className="text-[10px] text-text-muted uppercase tracking-wider">Projects Folder</span>
          </div>
          <p className="text-[10px] text-text-muted mb-2">
            Set a default folder. All subdirectories will appear in the sidebar projects list.
          </p>
          <div className="flex items-center gap-2">
            <span className="text-text-secondary truncate flex-1 text-[11px]" title={projectsFolder ?? ""}>
              {projectsFolder || "Not set"}
            </span>
            <button
              onClick={handleBrowseProjectsFolder}
              className="px-2 py-0.5 text-[11px] bg-bg-tertiary hover:bg-bg-border text-text-secondary rounded transition-colors"
            >
              Browse
            </button>
            {projectsFolder && (
              <button
                onClick={() => setProjectsFolder(null)}
                className="px-2 py-0.5 text-[11px] text-text-muted hover:text-accent-red transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>
      {showCreateWorkspace && (
        <WorkspaceCreationModal onClose={() => setShowCreateWorkspace(false)} />
      )}
    </div>
  );
}
