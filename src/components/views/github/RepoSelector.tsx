import { useEffect, useRef, useState } from "react";
import { ChevronDown, Folder, ShieldAlert } from "lucide-react";
import type { GitHubRepo } from "@/types/github";

interface RepoSelectorProps {
  selected: { owner: string; repo: string } | null;
  repos: GitHubRepo[];
  onSelect: (owner: string, repo: string) => void;
}

export function RepoSelector({ selected, repos, onSelect }: RepoSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const selectedFull = selected ? `${selected.owner}/${selected.repo}` : null;
  const selectedRepo = selectedFull
    ? repos.find((r) => r.full_name === selectedFull)
    : null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] bg-bg-tertiary border border-bg-border rounded text-text-primary hover:border-line-strong transition-colors"
      >
        <Folder size={10} className="text-text-muted" />
        <span className="font-mono text-[10.5px]">
          {selectedFull ?? "Select repository"}
        </span>
        {selectedRepo?.private && (
          <ShieldAlert size={9} className="text-accent-amber" />
        )}
        <ChevronDown size={10} className="text-text-muted ml-0.5" />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-30 min-w-[260px] max-h-[320px] overflow-y-auto bg-bg-secondary border border-bg-border rounded shadow-lg">
          {repos.length === 0 ? (
            <div className="px-3 py-3 text-[10.5px] text-text-muted">
              No repositories loaded.
            </div>
          ) : (
            repos.map((r) => {
              const isSelected = r.full_name === selectedFull;
              return (
                <button
                  type="button"
                  key={r.id}
                  onClick={() => {
                    onSelect(r.owner.login, r.name);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-2.5 py-1.5 text-[11px] flex items-center gap-1.5 hover:bg-bg-tertiary transition-colors ${
                    isSelected ? "bg-bg-tertiary" : ""
                  }`}
                >
                  <Folder size={10} className="text-text-muted flex-shrink-0" />
                  <span className="font-mono text-[10.5px] text-text-primary truncate flex-1">
                    {r.full_name}
                  </span>
                  {r.private && (
                    <ShieldAlert
                      size={9}
                      className="text-accent-amber flex-shrink-0"
                    />
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
