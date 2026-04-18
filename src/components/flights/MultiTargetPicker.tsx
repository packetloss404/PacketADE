import { useMemo } from "react";
import { Folder, Server, X, Check } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useSshTargetStore } from "@/stores/sshTargetStore";
import { API_PROVIDERS, getDefaultModel } from "@/lib/api-models";
import type { AgentCli } from "@/stores/agentTaskStore";
import type { SshTarget } from "@/types/ssh";
import type { Workspace } from "@/types/workspace";

export type PickedTarget =
  | {
      kind: "local";
      key: string;
      workspaceId: string;
      label: string;
      basePath: string;
      baseBranch: string;
      agent: AgentCli;
      model: string;
    }
  | {
      kind: "ssh";
      key: string;
      target: SshTarget;
      label: string;
      basePath: string;
      baseBranch: string;
      agent: AgentCli;
      model: string;
    };

interface MultiTargetPickerProps {
  picked: PickedTarget[];
  onChange: (next: PickedTarget[]) => void;
  defaultAgent?: AgentCli;
}

const DEFAULT_BRANCH = "main";

export function MultiTargetPicker({
  picked,
  onChange,
  defaultAgent = "api-claude",
}: MultiTargetPickerProps) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const sshTargets = useSshTargetStore((s) => s.targets);

  const isPicked = (key: string) => picked.some((p) => p.key === key);

  const localOptions = useMemo(
    () =>
      workspaces
        .filter((w): w is Workspace & { projectPath: string } =>
          Boolean(w.projectPath),
        )
        .map((w) => ({
          key: `local:${w.id}`,
          workspace: w,
        })),
    [workspaces],
  );

  function toggleLocal(workspace: Workspace) {
    const key = `local:${workspace.id}`;
    if (isPicked(key)) {
      onChange(picked.filter((p) => p.key !== key));
      return;
    }
    onChange([
      ...picked,
      {
        kind: "local",
        key,
        workspaceId: workspace.id,
        label: workspace.name,
        basePath: workspace.projectPath,
        baseBranch: DEFAULT_BRANCH,
        agent: defaultAgent,
        model: getDefaultModel(defaultAgent),
      },
    ]);
  }

  function toggleSsh(target: SshTarget) {
    const key = `ssh:${target.id}`;
    if (isPicked(key)) {
      onChange(picked.filter((p) => p.key !== key));
      return;
    }
    onChange([
      ...picked,
      {
        kind: "ssh",
        key,
        target,
        label: target.name,
        basePath: target.remotePath,
        baseBranch: DEFAULT_BRANCH,
        agent: defaultAgent,
        model: getDefaultModel(defaultAgent),
      },
    ]);
  }

  function updatePicked(key: string, patch: Partial<PickedTarget>) {
    onChange(
      picked.map((p) =>
        p.key === key ? ({ ...p, ...patch } as PickedTarget) : p,
      ),
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Available targets */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-text-muted">
          Targets — click to add
        </span>
        <div className="flex flex-wrap gap-1.5">
          {localOptions.length === 0 && sshTargets.length === 0 && (
            <span className="text-[11px] text-text-muted italic">
              No workspaces or SSH targets — open a folder or connect SSH first.
            </span>
          )}
          {localOptions.map(({ key, workspace }) => {
            const selected = isPicked(key);
            return (
              <button
                key={key}
                onClick={() => toggleLocal(workspace)}
                className={`flex items-center gap-1.5 px-2 py-1 text-[11px] rounded border transition-colors ${
                  selected
                    ? "bg-accent-green/15 text-accent-green border-accent-green/40"
                    : "bg-bg-primary text-text-secondary border-bg-border hover:border-accent-green/30"
                }`}
              >
                {selected ? <Check size={11} /> : <Folder size={11} />}
                {workspace.name}
              </button>
            );
          })}
          {sshTargets.map((target) => {
            const key = `ssh:${target.id}`;
            const selected = isPicked(key);
            return (
              <button
                key={key}
                onClick={() => toggleSsh(target)}
                className={`flex items-center gap-1.5 px-2 py-1 text-[11px] rounded border transition-colors ${
                  selected
                    ? "bg-accent-purple/15 text-accent-purple border-accent-purple/40"
                    : "bg-bg-primary text-text-secondary border-bg-border hover:border-accent-purple/30"
                }`}
              >
                {selected ? <Check size={11} /> : <Server size={11} />}
                {target.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* Picked targets — per-row config */}
      {picked.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-text-muted">
            {picked.length} agent{picked.length !== 1 ? "s" : ""} will launch
          </span>
          <div className="flex flex-col gap-1 border border-bg-border rounded overflow-hidden">
            {picked.map((p) => {
              const provider = API_PROVIDERS.find((pr) => pr.agentCli === p.agent);
              return (
                <div
                  key={p.key}
                  className="flex items-center gap-2 px-2 py-1.5 bg-bg-primary text-[11px] border-b border-bg-border last:border-b-0"
                >
                  {p.kind === "local" ? (
                    <Folder size={11} className="text-text-muted shrink-0" />
                  ) : (
                    <Server size={11} className="text-accent-purple shrink-0" />
                  )}
                  <span className="text-text-primary font-medium truncate min-w-[80px] max-w-[140px]">
                    {p.label}
                  </span>
                  <input
                    type="text"
                    value={p.baseBranch}
                    onChange={(e) =>
                      updatePicked(p.key, { baseBranch: e.target.value })
                    }
                    className="flex-shrink-0 w-20 bg-bg-secondary border border-bg-border rounded px-1.5 py-0.5 text-[10px] text-text-primary outline-none focus:border-accent-green/40"
                    placeholder="branch"
                    title="Base branch for the worktree"
                  />
                  <select
                    value={p.agent}
                    onChange={(e) => {
                      const agent = e.target.value as AgentCli;
                      updatePicked(p.key, {
                        agent,
                        model: getDefaultModel(agent),
                      });
                    }}
                    className="flex-shrink-0 bg-bg-secondary border border-bg-border rounded px-1.5 py-0.5 text-[10px] text-text-secondary outline-none focus:border-accent-green/40"
                  >
                    {API_PROVIDERS.map((pr) => (
                      <option key={pr.agentCli} value={pr.agentCli}>
                        {pr.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={p.model}
                    onChange={(e) => updatePicked(p.key, { model: e.target.value })}
                    className="flex-1 min-w-[100px] bg-bg-secondary border border-bg-border rounded px-1.5 py-0.5 text-[10px] text-text-secondary outline-none focus:border-accent-green/40"
                  >
                    {provider?.models.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() =>
                      onChange(picked.filter((x) => x.key !== p.key))
                    }
                    className="p-0.5 text-text-muted hover:text-accent-red"
                    title="Remove"
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
