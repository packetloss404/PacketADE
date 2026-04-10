import { FolderOpen, GitBranch, FolderSearch } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useLayoutStore } from "@/stores/layoutStore";
import { useProjectHistoryStore } from "@/stores/projectHistoryStore";

interface ProjectInfoCardProps {
  projectPath: string;
  gitBranch: string | null;
}

export function ProjectInfoCard({ projectPath, gitBranch }: ProjectInfoCardProps) {
  const setProjectPath = useLayoutStore((s) => s.setProjectPath);
  const projectsFolder = useProjectHistoryStore((s) => s.projectsFolder);
  const setProjectsFolder = useProjectHistoryStore((s) => s.setProjectsFolder);

  const handleBrowse = async () => {
    const selected = await open({ directory: true, title: "Select Project Folder" });
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
        {/* Current project */}
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
        {gitBranch && (
          <div className="flex items-center gap-1">
            <span className="text-text-muted">Branch: </span>
            <GitBranch size={10} className="text-accent-purple" />
            <span className="text-text-secondary">{gitBranch}</span>
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
                className="px-2 py-0.5 text-[11px] text-text-muted hover:text-red-400 transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
