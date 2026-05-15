import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  CircleDot,
  Loader2,
  Milestone as MilestoneIcon,
  Tag,
  UserPlus,
  X,
} from "lucide-react";
import { useGitHubStore } from "@/stores/githubStore";
import {
  githubListRepoAssignableUsers,
  githubListRepoLabels,
  githubListRepoMilestones,
} from "@/lib/tauri";
import type {
  GitHubAssignableUser,
  GitHubIssue,
  GitHubLabel,
  GitHubMilestone,
} from "@/types/github";

interface IssueActionBarProps {
  issue: GitHubIssue;
  /** Called after a successful mutation so the parent can refetch the
   *  issue, comments, or list as needed. */
  onChange?: () => void;
}

/** v0.8-C: top-of-IssueDetail action bar — Close/Reopen, Assignees, Labels,
 *  Milestone. Renders three bespoke popovers (multi-select for assignees +
 *  labels, single-select for milestone). The Dropdown UI component is
 *  single-select with internal state and didn't fit the multi-select chip
 *  preview pattern — see CLAUDE.md note in v0.8-C. */
export function IssueActionBar({ issue, onChange }: IssueActionBarProps) {
  const config = useGitHubStore((s) => s.config);
  const setIssueState = useGitHubStore((s) => s.setIssueState);
  const setIssueAssignees = useGitHubStore((s) => s.setIssueAssignees);
  const setIssueLabels = useGitHubStore((s) => s.setIssueLabels);
  const setIssueMilestone = useGitHubStore((s) => s.setIssueMilestone);

  const isOpen = issue.state === "open";
  const [stateBusy, setStateBusy] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);

  async function handleToggleState() {
    setStateBusy(true);
    setStateError(null);
    try {
      await setIssueState(
        { number: issue.number, state: issue.state },
        isOpen ? "closed" : "open",
      );
      onChange?.();
    } catch (e) {
      setStateError(String(e));
    } finally {
      setStateBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-1.5 px-4 py-2 border-b border-bg-border bg-bg-secondary flex-shrink-0 flex-wrap">
      <button
        type="button"
        onClick={handleToggleState}
        disabled={stateBusy}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium rounded border transition-colors disabled:opacity-60 ${
          isOpen
            ? "bg-accent-red/15 text-accent-red border-accent-red/30 hover:bg-accent-red/25"
            : "bg-accent-green/15 text-accent-green border-accent-green/30 hover:bg-accent-green/25"
        }`}
        title={isOpen ? "Close this issue" : "Reopen this issue"}
      >
        {stateBusy ? (
          <Loader2 size={10} className="animate-spin" />
        ) : (
          <CircleDot size={10} />
        )}
        {isOpen ? "Close issue" : "Reopen"}
      </button>

      <AssigneesPicker
        owner={config.selectedRepo?.owner}
        repo={config.selectedRepo?.repo}
        current={(issue.assignees ?? []).map((a) => a.login)}
        onApply={async (logins) => {
          await setIssueAssignees({ number: issue.number }, logins);
          onChange?.();
        }}
      />

      <LabelsPicker
        owner={config.selectedRepo?.owner}
        repo={config.selectedRepo?.repo}
        current={issue.labels}
        onApply={async (labels) => {
          await setIssueLabels({ number: issue.number }, labels);
          onChange?.();
        }}
      />

      <MilestonePicker
        owner={config.selectedRepo?.owner}
        repo={config.selectedRepo?.repo}
        current={issue.milestone ?? null}
        onApply={async (milestone) => {
          await setIssueMilestone({ number: issue.number }, milestone);
          onChange?.();
        }}
      />

      {stateError && (
        <span className="text-[10px] text-accent-red ml-1">{stateError}</span>
      )}
    </div>
  );
}

// === Popover scaffolding ====================================================

interface PopoverProps {
  trigger: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
}

function Popover({ trigger, children }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium bg-bg-tertiary text-text-primary border border-bg-border rounded hover:border-line-strong transition-colors"
      >
        {trigger}
        <ChevronDown size={10} className="text-text-muted" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-30 min-w-[260px] max-h-[320px] overflow-y-auto bg-bg-secondary border border-bg-border rounded shadow-lg">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

// === Assignees =============================================================

interface AssigneesPickerProps {
  owner: string | undefined;
  repo: string | undefined;
  current: string[];
  onApply: (logins: string[]) => Promise<void>;
}

function AssigneesPicker({ owner, repo, current, onApply }: AssigneesPickerProps) {
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState<GitHubAssignableUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(current));
  const [filter, setFilter] = useState("");
  const [applying, setApplying] = useState(false);

  // Sync local selection if the underlying issue changed (parent re-renders).
  useEffect(() => {
    setSelected(new Set(current));
  }, [current.join("")]); // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    if (!owner || !repo || users.length > 0 || loading) return;
    setLoading(true);
    setError(null);
    try {
      const json = await githubListRepoAssignableUsers(owner, repo);
      const parsed = JSON.parse(json) as GitHubAssignableUser[];
      setUsers(parsed);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => u.login.toLowerCase().includes(q));
  }, [users, filter]);

  const dirty = useMemo(() => {
    const cur = new Set(current);
    if (cur.size !== selected.size) return true;
    for (const l of selected) if (!cur.has(l)) return true;
    return false;
  }, [current, selected]);

  const triggerLabel =
    current.length === 0
      ? "Assignees"
      : current.length === 1
        ? current[0]
        : `${current.length} assignees`;

  return (
    <Popover
      trigger={
        <span
          className="inline-flex items-center gap-1.5"
          onClick={() => void load()}
        >
          <UserPlus size={10} className="text-text-muted" /> {triggerLabel}
        </span>
      }
    >
      {(close) => (
        <div className="p-2 flex flex-col gap-1.5">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter users..."
            className="bg-bg-primary border border-bg-border rounded px-2 py-1 text-[10.5px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green/60"
            autoFocus
          />
          {loading ? (
            <div className="text-[10.5px] text-text-muted px-1 py-2">
              Loading...
            </div>
          ) : error ? (
            <div className="text-[10.5px] text-accent-red px-1 py-2">
              {error}
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-[10.5px] text-text-muted px-1 py-2">
              No assignable users.
            </div>
          ) : (
            <div className="flex flex-col">
              {filtered.map((u) => {
                const on = selected.has(u.login);
                return (
                  <button
                    type="button"
                    key={u.login}
                    onClick={() =>
                      setSelected((s) => {
                        const next = new Set(s);
                        if (next.has(u.login)) next.delete(u.login);
                        else next.add(u.login);
                        return next;
                      })
                    }
                    className={`flex items-center gap-2 px-2 py-1 text-[10.5px] rounded hover:bg-bg-tertiary ${
                      on ? "text-text-primary" : "text-text-secondary"
                    }`}
                  >
                    <span className="w-3.5 flex justify-center">
                      {on ? (
                        <Check size={10} className="text-accent-green" />
                      ) : null}
                    </span>
                    {u.avatar_url ? (
                      <img
                        src={u.avatar_url}
                        alt=""
                        className="w-3.5 h-3.5 rounded-full"
                      />
                    ) : (
                      <div className="w-3.5 h-3.5 rounded-full bg-bg-tertiary" />
                    )}
                    <span className="font-mono">{u.login}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-2 pt-1.5 border-t border-bg-border">
            <span className="text-[10px] text-text-muted">
              {selected.size} selected
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={close}
              className="text-[10px] text-text-muted hover:text-text-primary px-2 py-0.5"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!dirty || applying}
              onClick={async () => {
                setApplying(true);
                setError(null);
                try {
                  await onApply([...selected]);
                  close();
                } catch (e) {
                  // Keep the popover open + surface the failure so the user
                  // knows the optimistic update was rolled back.
                  setError(
                    typeof e === "string"
                      ? e
                      : e instanceof Error
                        ? e.message
                        : "Failed to apply",
                  );
                  return;
                } finally {
                  setApplying(false);
                }
              }}
              className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded bg-accent-green/15 text-accent-green border border-accent-green/30 hover:bg-accent-green/25 disabled:opacity-50"
            >
              {applying ? <Loader2 size={9} className="animate-spin" /> : null}
              Apply
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}

// === Labels ================================================================

interface LabelsPickerProps {
  owner: string | undefined;
  repo: string | undefined;
  current: { name: string; color: string }[];
  onApply: (labels: { name: string; color: string }[]) => Promise<void>;
}

function LabelsPicker({ owner, repo, current, onApply }: LabelsPickerProps) {
  const [loading, setLoading] = useState(false);
  const [labels, setLabels] = useState<GitHubLabel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, string>>(
    new Map(current.map((l) => [l.name, l.color])),
  );
  const [filter, setFilter] = useState("");
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    setSelected(new Map(current.map((l) => [l.name, l.color])));
  }, [current.map((l) => l.name).join("")]); // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    if (!owner || !repo || labels.length > 0 || loading) return;
    setLoading(true);
    setError(null);
    try {
      const json = await githubListRepoLabels(owner, repo);
      const parsed = JSON.parse(json) as GitHubLabel[];
      setLabels(parsed);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return labels;
    return labels.filter((l) => l.name.toLowerCase().includes(q));
  }, [labels, filter]);

  const dirty = useMemo(() => {
    if (selected.size !== current.length) return true;
    for (const l of current) if (!selected.has(l.name)) return true;
    return false;
  }, [current, selected]);

  const triggerLabel =
    current.length === 0
      ? "Labels"
      : current.length === 1
        ? current[0].name
        : `${current.length} labels`;

  return (
    <Popover
      trigger={
        <span
          className="inline-flex items-center gap-1.5"
          onClick={() => void load()}
        >
          <Tag size={10} className="text-text-muted" /> {triggerLabel}
          {current.length > 0 && (
            <span className="flex items-center gap-0.5">
              {current.slice(0, 3).map((l) => (
                <span
                  key={l.name}
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: `#${l.color}` }}
                />
              ))}
            </span>
          )}
        </span>
      }
    >
      {(close) => (
        <div className="p-2 flex flex-col gap-1.5">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter labels..."
            className="bg-bg-primary border border-bg-border rounded px-2 py-1 text-[10.5px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green/60"
            autoFocus
          />
          {loading ? (
            <div className="text-[10.5px] text-text-muted px-1 py-2">
              Loading...
            </div>
          ) : error ? (
            <div className="text-[10.5px] text-accent-red px-1 py-2">
              {error}
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-[10.5px] text-text-muted px-1 py-2">
              No labels defined.
            </div>
          ) : (
            <div className="flex flex-col">
              {filtered.map((l) => {
                const on = selected.has(l.name);
                return (
                  <button
                    type="button"
                    key={l.name}
                    onClick={() =>
                      setSelected((s) => {
                        const next = new Map(s);
                        if (next.has(l.name)) next.delete(l.name);
                        else next.set(l.name, l.color);
                        return next;
                      })
                    }
                    className={`flex items-center gap-2 px-2 py-1 text-[10.5px] rounded hover:bg-bg-tertiary ${
                      on ? "text-text-primary" : "text-text-secondary"
                    }`}
                  >
                    <span className="w-3.5 flex justify-center">
                      {on ? (
                        <Check size={10} className="text-accent-green" />
                      ) : null}
                    </span>
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: `#${l.color}` }}
                    />
                    <span className="truncate">{l.name}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-2 pt-1.5 border-t border-bg-border">
            <span className="text-[10px] text-text-muted">
              {selected.size} selected
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={close}
              className="text-[10px] text-text-muted hover:text-text-primary px-2 py-0.5"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!dirty || applying}
              onClick={async () => {
                setApplying(true);
                setError(null);
                try {
                  await onApply(
                    [...selected.entries()].map(([name, color]) => ({
                      name,
                      color,
                    })),
                  );
                  close();
                } catch (e) {
                  setError(
                    typeof e === "string"
                      ? e
                      : e instanceof Error
                        ? e.message
                        : "Failed to apply",
                  );
                  return;
                } finally {
                  setApplying(false);
                }
              }}
              className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded bg-accent-green/15 text-accent-green border border-accent-green/30 hover:bg-accent-green/25 disabled:opacity-50"
            >
              {applying ? <Loader2 size={9} className="animate-spin" /> : null}
              Apply
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}

// === Milestone (single select) =============================================

interface MilestonePickerProps {
  owner: string | undefined;
  repo: string | undefined;
  current: { number: number; title: string } | null;
  onApply: (
    milestone: { number: number; title: string } | null,
  ) => Promise<void>;
}

function MilestonePicker({ owner, repo, current, onApply }: MilestonePickerProps) {
  const [loading, setLoading] = useState(false);
  const [milestones, setMilestones] = useState<GitHubMilestone[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<number | "clear" | null>(null);

  async function load() {
    if (!owner || !repo || milestones.length > 0 || loading) return;
    setLoading(true);
    setError(null);
    try {
      const json = await githubListRepoMilestones(owner, repo);
      const parsed = JSON.parse(json) as GitHubMilestone[];
      setMilestones(parsed);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const triggerLabel = current?.title ?? "Milestone";

  return (
    <Popover
      trigger={
        <span
          className="inline-flex items-center gap-1.5"
          onClick={() => void load()}
        >
          <MilestoneIcon size={10} className="text-text-muted" /> {triggerLabel}
        </span>
      }
    >
      {(close) => (
        <div className="p-2 flex flex-col gap-1">
          {loading ? (
            <div className="text-[10.5px] text-text-muted px-1 py-2">
              Loading...
            </div>
          ) : error ? (
            <div className="text-[10.5px] text-accent-red px-1 py-2">
              {error}
            </div>
          ) : milestones.length === 0 ? (
            <div className="text-[10.5px] text-text-muted px-1 py-2">
              No open milestones.
            </div>
          ) : (
            milestones.map((m) => {
              const on = current?.number === m.number;
              const busy = applying === m.number;
              return (
                <button
                  type="button"
                  key={m.number}
                  disabled={busy}
                  onClick={async () => {
                    if (on) return;
                    setApplying(m.number);
                    setError(null);
                    try {
                      await onApply({ number: m.number, title: m.title });
                      close();
                    } catch (e) {
                      setError(
                        typeof e === "string"
                          ? e
                          : e instanceof Error
                            ? e.message
                            : "Failed to apply",
                      );
                      return;
                    } finally {
                      setApplying(null);
                    }
                  }}
                  className={`flex items-center gap-2 px-2 py-1 text-[10.5px] rounded hover:bg-bg-tertiary ${
                    on ? "text-accent-green" : "text-text-secondary"
                  }`}
                >
                  <span className="w-3.5 flex justify-center">
                    {busy ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : on ? (
                      <Check size={10} />
                    ) : null}
                  </span>
                  <MilestoneIcon size={9} className="text-text-muted" />
                  <span className="truncate">{m.title}</span>
                </button>
              );
            })
          )}
          {current && (
            <button
              type="button"
              disabled={applying === "clear"}
              onClick={async () => {
                setApplying("clear");
                setError(null);
                try {
                  await onApply(null);
                  close();
                } catch (e) {
                  setError(
                    typeof e === "string"
                      ? e
                      : e instanceof Error
                        ? e.message
                        : "Failed to apply",
                  );
                  return;
                } finally {
                  setApplying(null);
                }
              }}
              className="flex items-center gap-2 px-2 py-1 text-[10.5px] rounded hover:bg-bg-tertiary text-text-muted border-t border-bg-border mt-1 pt-2"
            >
              <span className="w-3.5 flex justify-center">
                {applying === "clear" ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <X size={10} />
                )}
              </span>
              Clear milestone
            </button>
          )}
        </div>
      )}
    </Popover>
  );
}
