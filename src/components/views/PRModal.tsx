import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  GitBranch,
  GitPullRequest,
  Loader2,
  Lock,
  Milestone as MilestoneIcon,
  Tag,
  UserPlus,
  X,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
// v0.8-E: AI PR description generator. Mounts next to the description
// textarea below.
import { PRDescriptionButton } from "@/components/views/github/PRDescriptionButton";
import { useGitHubStore } from "@/stores/githubStore";
import {
  githubListBranches,
  githubListRepoAssignableUsers,
  githubListRepoLabels,
  githubListRepoMilestones,
  githubSetPrLabels,
  githubSetPrMilestone,
  githubSetPrReviewers,
  type GitHubBranchInfo,
} from "@/lib/tauri";
import type {
  GitHubAssignableUser,
  GitHubIssue,
  GitHubLabel,
  GitHubMilestone,
} from "@/types/github";

/**
 * v0.8-G upgrade: rich PR creation modal.
 *
 * The caller still supplies an `onSubmit(title, body, head, base, draft)`
 * callback that wraps `githubStore.createPR` (which now accepts the
 * `draft` parameter). Post-create reviewer/label/milestone calls run
 * directly through the `github_*` bindings — the store doesn't need to
 * learn the new fields.
 *
 * Branch / reviewer / label / milestone lookups all run against the
 * user's currently-selected repo (read from
 * `githubStore.config.selectedRepo`).
 */
interface PRModalProps {
  onClose: () => void;
  onSubmit: (
    title: string,
    body: string,
    head: string,
    base: string,
    draft: boolean,
  ) => Promise<string>;
  isLoading: boolean;
  /** v0.8 spec compliance: pre-seed the "Closes #N" picker. Typically
   *  supplied by GitHubView with the currently-focused issue number so
   *  opening the modal while reading an issue auto-links it. Defaults
   *  to no seed. */
  initialLinkedIssues?: number[];
  allowAiAssist?: boolean;
  allowDraft?: boolean;
}

type PublishStep = "reviewers" | "labels" | "milestone";
type StepStatus = "idle" | "running" | "ok" | "error";

export function PRModal({
  onClose,
  onSubmit,
  isLoading,
  initialLinkedIssues,
  allowAiAssist = true,
  allowDraft = true,
}: PRModalProps) {
  // v0.8-E: AI description generator needs the selected repo for the
  // backend GitHub fetch. The button stays disabled while head/base/repo
  // aren't all populated so we don't kick off a doomed compare round-trip.
  const selectedRepo = useGitHubStore((s) => s.config.selectedRepo);
  const issues = useGitHubStore((s) => s.issues);
  // v0.8: seed the "Open as draft" checkbox with the user's persisted
  // default from Settings → GitHub.
  const defaultDraftPrs = useGitHubStore((s) => s.defaultDraftPrs);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [head, setHead] = useState("");
  const [base, setBase] = useState("main");
  const [draft, setDraft] = useState(defaultDraftPrs);

  const [linkedIssues, setLinkedIssues] = useState<number[]>(initialLinkedIssues ?? []);

  // v0.8 spec: seed `linkedIssues` from the initial prop on modal open.
  // The PRModal is mounted/unmounted via `showPRModal` in GitHubView, so
  // the effect fires fresh on each open. Joining the array to a string
  // key keeps the effect stable across array-identity churn from parents.
  useEffect(() => {
    if (initialLinkedIssues && initialLinkedIssues.length > 0) {
      setLinkedIssues(initialLinkedIssues);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLinkedIssues?.join(",")]);

  const [reviewers, setReviewers] = useState<string[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [milestone, setMilestone] = useState<number | null>(null);

  const [branches, setBranches] = useState<GitHubBranchInfo[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [assignableUsers, setAssignableUsers] = useState<GitHubAssignableUser[]>([]);
  const [repoLabels, setRepoLabels] = useState<GitHubLabel[]>([]);
  const [milestones, setMilestones] = useState<GitHubMilestone[]>([]);

  const [result, setResult] = useState<string | null>(null);
  const [stepStatus, setStepStatus] = useState<Record<PublishStep, StepStatus>>({
    reviewers: "idle",
    labels: "idle",
    milestone: "idle",
  });
  const [stepError, setStepError] = useState<Record<PublishStep, string | null>>({
    reviewers: null,
    labels: null,
    milestone: null,
  });

  // Lazy-load the repo pickers when the modal opens. Errors are swallowed
  // here — they just leave the dropdowns empty, the user can still create
  // the PR with no labels/reviewers/milestone.
  useEffect(() => {
    if (!selectedRepo) return;
    let cancelled = false;
    const { owner, repo } = selectedRepo;
    setBranchesLoading(true);
    void Promise.all([
      githubListBranches(owner, repo).catch(() => [] as GitHubBranchInfo[]),
      githubListRepoAssignableUsers(owner, repo).catch(() => "[]"),
      githubListRepoLabels(owner, repo).catch(() => "[]"),
      githubListRepoMilestones(owner, repo).catch(() => "[]"),
    ]).then(([branchList, usersJson, labelsJson, milestonesJson]) => {
      if (cancelled) return;
      setBranches(branchList);
      try {
        setAssignableUsers(JSON.parse(usersJson as string) as GitHubAssignableUser[]);
      } catch {
        setAssignableUsers([]);
      }
      try {
        setRepoLabels(JSON.parse(labelsJson as string) as GitHubLabel[]);
      } catch {
        setRepoLabels([]);
      }
      try {
        setMilestones(JSON.parse(milestonesJson as string) as GitHubMilestone[]);
      } catch {
        setMilestones([]);
      }
      setBranchesLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedRepo]);

  // Sort branches: main/master/develop first, then alphabetically.
  const sortedBranches = useMemo(() => {
    const priority = (name: string) =>
      name === "main" ? 0 : name === "master" ? 1 : name === "develop" ? 2 : 3;
    return [...branches].sort((a, b) => {
      const pd = priority(a.name) - priority(b.name);
      if (pd !== 0) return pd;
      return a.name.localeCompare(b.name);
    });
  }, [branches]);

  // Open issues only — closed issues can't be auto-closed by a new PR.
  const openIssues = useMemo(() => issues.filter((i) => i.state === "open"), [issues]);

  function buildBody(): string {
    if (linkedIssues.length === 0) return body;
    const prefix = linkedIssues.map((n) => `Closes #${n}`).join(", ");
    return `${prefix}\n\n${body}`;
  }

  async function runPostCreateSteps(prNumber: number) {
    if (!selectedRepo) return;
    const { owner, repo } = selectedRepo;
    const set = (step: PublishStep, status: StepStatus, error: string | null = null) => {
      setStepStatus((s) => ({ ...s, [step]: status }));
      setStepError((s) => ({ ...s, [step]: error }));
    };

    if (reviewers.length > 0) {
      set("reviewers", "running");
      try {
        await githubSetPrReviewers(owner, repo, prNumber, reviewers);
        set("reviewers", "ok");
      } catch (e) {
        set("reviewers", "error", typeof e === "string" ? e : ((e as Error)?.message ?? "failed"));
      }
    }
    if (labels.length > 0) {
      set("labels", "running");
      try {
        await githubSetPrLabels(owner, repo, prNumber, labels);
        set("labels", "ok");
      } catch (e) {
        set("labels", "error", typeof e === "string" ? e : ((e as Error)?.message ?? "failed"));
      }
    }
    if (milestone != null) {
      set("milestone", "running");
      try {
        await githubSetPrMilestone(owner, repo, prNumber, milestone);
        set("milestone", "ok");
      } catch (e) {
        set("milestone", "error", typeof e === "string" ? e : ((e as Error)?.message ?? "failed"));
      }
    }
  }

  async function handleSubmit() {
    try {
      const json = await onSubmit(title, buildBody(), head, base, allowDraft && draft);
      const pr = JSON.parse(json) as { number?: number; html_url?: string };
      setResult(pr.html_url || "PR created successfully");
      if (pr.number) {
        await runPostCreateSteps(pr.number);
      }
    } catch {
      /* error handled by store */
    }
  }

  const footer = (
    <div className="flex items-center justify-end gap-2">
      <button
        onClick={onClose}
        className="px-3 py-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary"
      >
        Cancel
      </button>
      <button
        onClick={handleSubmit}
        disabled={!title.trim() || !head.trim() || isLoading}
        className="bg-accent-purple/15 border-accent-purple/30 hover:bg-accent-purple/25 rounded border px-4 py-1.5 text-xs font-medium text-accent-purple transition-colors disabled:opacity-50"
      >
        {isLoading ? "Creating..." : allowDraft && draft ? "Create draft PR" : "Create PR"}
      </button>
    </div>
  );

  return (
    <Modal
      onClose={onClose}
      title="Create Pull Request"
      icon={<GitPullRequest size={14} className="text-accent-purple" />}
      footer={footer}
      width="w-[640px] max-w-[95vw]"
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="PR title"
          className="w-full rounded border border-bg-border bg-bg-primary px-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus:border-accent-purple focus:outline-none"
        />
        {/* v0.8-E: AI-generated description button mounts directly above
            the description textarea so the user can one-click generate
            then edit. Disabled until head/base/repo are all populated. */}
        {/* v0.8-E: pr desc button mount */}
        {allowAiAssist && selectedRepo && (
          <PRDescriptionButton
            owner={selectedRepo.owner}
            repo={selectedRepo.repo}
            base={base}
            head={head}
            draftTitle={title || undefined}
            onGenerated={(md) => setBody(md)}
            disabled={!head.trim() || !base.trim()}
          />
        )}
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Description..."
          rows={4}
          className="w-full resize-none rounded border border-bg-border bg-bg-primary px-3 py-2 text-xs text-text-primary placeholder:text-text-muted focus:border-accent-purple focus:outline-none"
        />

        {/* Head + Base branch pickers */}
        <div className="flex gap-2">
          <BranchPicker
            label="Head branch"
            value={head}
            onChange={setHead}
            branches={sortedBranches}
            loading={branchesLoading}
            placeholder="feature-branch"
          />
          <BranchPicker
            label="Base branch"
            value={base}
            onChange={setBase}
            branches={sortedBranches}
            loading={branchesLoading}
            placeholder="main"
          />
        </div>

        {/* Draft toggle */}
        {allowDraft && (
          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-text-secondary">
            <input
              type="checkbox"
              checked={draft}
              onChange={(e) => setDraft(e.target.checked)}
              className="accent-accent-purple"
            />
            <span>Open as draft</span>
            <span className="text-[10px] text-text-muted">
              · Skips reviewer auto-request until marked ready
            </span>
          </label>
        )}

        {/* Linked issues */}
        <PickerField
          icon={<GitPullRequest size={11} className="text-accent-blue" />}
          label="Closes issues"
          options={openIssues.map((i: GitHubIssue) => ({
            key: String(i.number),
            label: `#${i.number} ${i.title}`,
            secondary: i.labels.map((l) => l.name).join(", "),
          }))}
          selectedKeys={linkedIssues.map(String)}
          onToggle={(key) => {
            const n = Number(key);
            setLinkedIssues((cur) => (cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]));
          }}
          emptyHint="No open issues"
          searchPlaceholder="Search issues…"
        />

        {/* Reviewers */}
        <PickerField
          icon={<UserPlus size={11} className="text-accent-green" />}
          label="Reviewers"
          options={assignableUsers.map((u) => ({
            key: u.login,
            label: u.login,
            avatar: u.avatar_url,
          }))}
          selectedKeys={reviewers}
          onToggle={(key) =>
            setReviewers((cur) =>
              cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key],
            )
          }
          emptyHint="No assignable users"
          searchPlaceholder="Search users…"
        />

        {/* Labels */}
        <PickerField
          icon={<Tag size={11} className="text-accent-amber" />}
          label="Labels"
          options={repoLabels.map((l) => ({
            key: l.name,
            label: l.name,
            color: l.color,
          }))}
          selectedKeys={labels}
          onToggle={(key) =>
            setLabels((cur) => (cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key]))
          }
          emptyHint="No labels"
          searchPlaceholder="Search labels…"
        />

        {/* Milestone */}
        <SinglePicker
          icon={<MilestoneIcon size={11} className="text-accent-purple" />}
          label="Milestone"
          options={milestones.map((m) => ({
            key: String(m.number),
            label: m.title,
            secondary: m.state,
          }))}
          selectedKey={milestone != null ? String(milestone) : null}
          onSelect={(key) => setMilestone(key == null ? null : Number(key))}
          emptyHint="No open milestones"
        />

        {result && (
          <div className="bg-accent-green/10 rounded px-3 py-2 text-[11px] text-accent-green">
            {result}
          </div>
        )}

        {/* Post-create step progress */}
        {(stepStatus.reviewers !== "idle" ||
          stepStatus.labels !== "idle" ||
          stepStatus.milestone !== "idle") && (
          <div className="flex flex-col gap-1 rounded border border-bg-border bg-bg-primary px-3 py-2 text-[11px]">
            <StepRow
              label="Requesting reviewers"
              status={stepStatus.reviewers}
              error={stepError.reviewers}
            />
            <StepRow label="Applying labels" status={stepStatus.labels} error={stepError.labels} />
            <StepRow
              label="Setting milestone"
              status={stepStatus.milestone}
              error={stepError.milestone}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------- Sub-components -------------------------------------------------

interface BranchPickerProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  branches: GitHubBranchInfo[];
  loading: boolean;
  placeholder: string;
}

function BranchPicker({
  label,
  value,
  onChange,
  branches,
  loading,
  placeholder,
}: BranchPickerProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(f));
  }, [branches, filter]);

  return (
    <div className="relative flex-1">
      <label className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-muted">
        <GitBranch size={9} />
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setFilter(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={loading ? "Loading branches…" : placeholder}
        className="w-full rounded border border-bg-border bg-bg-primary px-3 py-1.5 pr-7 text-xs text-text-primary placeholder:text-text-muted focus:border-accent-purple focus:outline-none"
      />
      <ChevronDown
        size={11}
        className="pointer-events-none absolute right-2 top-[26px] text-text-muted"
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded border border-bg-border bg-bg-secondary shadow-lg">
          {filtered.slice(0, 50).map((b) => (
            <button
              key={b.name}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(b.name);
                setFilter("");
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-2 px-3 py-1 text-left text-xs text-text-primary hover:bg-bg-tertiary"
            >
              <span className="flex items-center gap-1.5 truncate">
                <GitBranch size={10} className="text-text-muted" />
                {b.name}
              </span>
              {b.isProtected && <Lock size={9} className="text-accent-amber" />}
            </button>
          ))}
          {filtered.length > 50 && (
            <div className="px-3 py-1 text-[10px] text-text-muted">
              Showing first 50 of {filtered.length}. Refine search to narrow.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface PickerOption {
  key: string;
  label: string;
  secondary?: string;
  color?: string;
  avatar?: string;
}

interface PickerFieldProps {
  icon: React.ReactNode;
  label: string;
  options: PickerOption[];
  selectedKeys: string[];
  onToggle: (key: string) => void;
  emptyHint: string;
  searchPlaceholder: string;
}

function PickerField({
  icon,
  label,
  options,
  selectedKeys,
  onToggle,
  emptyHint,
  searchPlaceholder,
}: PickerFieldProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const selectedOptions = useMemo(
    () => options.filter((o) => selectedKeys.includes(o.key)),
    [options, selectedKeys],
  );

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-muted">
        {icon}
        {label}
      </label>
      <div className="flex min-h-[28px] flex-wrap items-center gap-1 rounded border border-bg-border bg-bg-primary px-2 py-1">
        {selectedOptions.length === 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-[11px] text-text-muted hover:text-text-primary"
          >
            Add {label.toLowerCase()}…
          </button>
        )}
        {selectedOptions.map((o) => (
          <span
            key={o.key}
            className="border-accent-purple/30 bg-accent-purple/10 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-accent-purple"
            style={
              o.color
                ? {
                    borderColor: `#${o.color}80`,
                    backgroundColor: `#${o.color}20`,
                    color: `#${o.color}`,
                  }
                : undefined
            }
          >
            {o.avatar && <img src={o.avatar} alt="" className="h-3 w-3 rounded-full" />}
            {o.label}
            <button type="button" onClick={() => onToggle(o.key)} className="hover:opacity-80">
              <X size={9} />
            </button>
          </span>
        ))}
        {selectedOptions.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-1 text-[11px] text-text-muted hover:text-text-primary"
          >
            +
          </button>
        )}
      </div>
      {open && (
        <div className="rounded border border-bg-border bg-bg-secondary shadow">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="w-full border-b border-bg-border bg-transparent px-3 py-1 text-xs text-text-primary placeholder:text-text-muted focus:outline-none"
          />
          <div className="max-h-44 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-text-muted">{emptyHint}</div>
            ) : (
              filtered.slice(0, 100).map((o) => {
                const selected = selectedKeys.includes(o.key);
                return (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => onToggle(o.key)}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-1 text-left text-xs hover:bg-bg-tertiary ${
                      selected ? "text-accent-purple" : "text-text-primary"
                    }`}
                  >
                    <span className="flex items-center gap-2 truncate">
                      {o.avatar && <img src={o.avatar} alt="" className="h-3 w-3 rounded-full" />}
                      {o.color && (
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ backgroundColor: `#${o.color}` }}
                        />
                      )}
                      <span className="truncate">{o.label}</span>
                    </span>
                    {selected && <span className="text-[10px]">✓</span>}
                    {o.secondary && !selected && (
                      <span className="truncate text-[10px] text-text-muted">{o.secondary}</span>
                    )}
                  </button>
                );
              })
            )}
          </div>
          <div className="border-t border-bg-border px-3 py-1 text-right">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-[10px] text-text-muted hover:text-text-primary"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface SinglePickerProps {
  icon: React.ReactNode;
  label: string;
  options: PickerOption[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  emptyHint: string;
}

function SinglePicker({
  icon,
  label,
  options,
  selectedKey,
  onSelect,
  emptyHint,
}: SinglePickerProps) {
  const selected = options.find((o) => o.key === selectedKey);
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-muted">
        {icon}
        {label}
      </label>
      <select
        value={selectedKey ?? ""}
        onChange={(e) => onSelect(e.target.value === "" ? null : e.target.value)}
        className="w-full rounded border border-bg-border bg-bg-primary px-2 py-1 text-xs text-text-primary focus:border-accent-purple focus:outline-none"
      >
        <option value="">— None —</option>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      {selected?.secondary && (
        <span className="text-[10px] text-text-muted">{selected.secondary}</span>
      )}
      {options.length === 0 && <span className="text-[10px] text-text-muted">{emptyHint}</span>}
    </div>
  );
}

function StepRow({
  label,
  status,
  error,
}: {
  label: string;
  status: StepStatus;
  error: string | null;
}) {
  if (status === "idle") return null;
  return (
    <div className="flex items-center gap-2">
      {status === "running" && <Loader2 size={11} className="animate-spin text-accent-blue" />}
      {status === "ok" && <span className="text-accent-green">✓</span>}
      {status === "error" && <span className="text-accent-red">✗</span>}
      <span className="text-text-secondary">{label}</span>
      {error && <span className="ml-auto truncate text-accent-red">{error}</span>}
    </div>
  );
}
