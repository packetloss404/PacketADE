import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  Play,
  Target,
  X,
  LayoutGrid,
  UserPlus,
  Check,
  ExternalLink,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import {
  useIssueStore,
  type Issue,
  type IssueStatus,
} from "@/stores/issueStore";
import { useFlightStore } from "@/stores/flightStore";
import { useAppStore } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { writePty } from "@/lib/tauri";
import { getLabelColor, getPriorityColor } from "@/lib/colors";
import { IssueDependencyList } from "./IssueDependencyList";
import { IssueCommentList } from "./IssueCommentList";
import { IssueCommentComposer } from "./IssueCommentComposer";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";

interface IssueDetailProps {
  issueId: string;
  onClose: () => void;
}

const STATUS_BUTTONS: { key: IssueStatus; label: string }[] = [
  { key: "backlog", label: "Backlog" },
  { key: "up_next", label: "Up Next" },
  { key: "todo", label: "To Do" },
  { key: "in_progress", label: "In Progress" },
  { key: "in_review", label: "In Review" },
  { key: "qa", label: "QA" },
  { key: "done", label: "Done" },
  { key: "blocked", label: "Blocked" },
  { key: "needs_human", label: "Needs Human" },
];

function getStatusButtonColor(status: IssueStatus, isActive: boolean): string {
  if (!isActive) return "bg-bg-primary border-bg-border text-text-muted hover:bg-bg-hover hover:text-text-secondary";
  switch (status) {
    case "backlog": return "bg-text-faint/20 border-text-faint/40 text-text-secondary";
    case "up_next": return "bg-accent-blue/15 border-accent-blue/35 text-accent-blue";
    case "todo": return "bg-text-muted/20 border-text-muted/40 text-text-primary";
    case "in_progress": return "bg-accent-blue/20 border-accent-blue/40 text-accent-blue";
    case "in_review": return "bg-accent-purple/20 border-accent-purple/40 text-accent-purple";
    case "qa": return "bg-accent-amber/20 border-accent-amber/40 text-accent-amber";
    case "done": return "bg-accent-green/20 border-accent-green/40 text-accent-green";
    case "blocked": return "bg-accent-red/20 border-accent-red/40 text-accent-red";
    case "needs_human": return "bg-accent-purple/20 border-accent-purple/40 text-accent-purple";
    default: return "bg-bg-elevated border-bg-border text-text-primary";
  }
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  return (
    d.toLocaleDateString("en-US", {
      month: "numeric",
      day: "numeric",
      year: "numeric",
    }) +
    " at " +
    d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })
  );
}

/**
 * v0.8.5: IssueDetail — the unified detail panel that opens when a Kanban
 * card is clicked. Combines status controls, acceptance-criteria management,
 * dependencies, flight assignment, the v0.8.5-B workspace handoff link
 * (read-only here; CTA lives on the card), assignee editing, and the new
 * inline comment thread.
 *
 * This component replaces the older `IssueDetailView` as the IssueBoard's
 * detail panel mount, but `IssueDetailView` is still exported for any
 * surface that imports it directly.
 */
export function IssueDetail({ issueId, onClose }: IssueDetailProps) {
  const issues = useIssueStore((s) => s.issues);
  const moveIssue = useIssueStore((s) => s.moveIssue);
  const updateIssue = useIssueStore((s) => s.updateIssue);
  const toggleCriterion = useIssueStore((s) => s.toggleCriterion);
  const addCriterion = useIssueStore((s) => s.addCriterion);
  const removeCriterion = useIssueStore((s) => s.removeCriterion);
  const addBlockedBy = useIssueStore((s) => s.addBlockedBy);
  const removeBlockedBy = useIssueStore((s) => s.removeBlockedBy);
  const addBlocks = useIssueStore((s) => s.addBlocks);
  const removeBlocks = useIssueStore((s) => s.removeBlocks);
  const assignToFlight = useIssueStore((s) => s.assignToFlight);

  const flights = useFlightStore((s) => s.flights);
  const addIssueToFlight = useFlightStore((s) => s.addIssueToFlight);
  const removeIssueFromFlight = useFlightStore((s) => s.removeIssueFromFlight);

  const workspaces = useWorkspaceStore((s) => s.workspaces);

  const [showDepGraph, setShowDepGraph] = useState(false);
  const [newCriterionText, setNewCriterionText] = useState("");
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [editingAssignee, setEditingAssignee] = useState(false);
  const [assigneeDraft, setAssigneeDraft] = useState("");

  const foundIssue = issues.find((i) => i.id === issueId);
  if (!foundIssue) return null;
  const issue = foundIssue;

  const priorityInfo = getPriorityColor(issue.priority);
  const checkedCount = issue.acceptanceCriteria.filter((c) => c.checked).length;
  const totalCriteria = issue.acceptanceCriteria.length;
  const comments = issue.comments ?? [];

  const blockedByIssues = issue.blockedBy
    .map((id) => issues.find((i) => i.id === id))
    .filter(Boolean) as Issue[];
  const blocksIssues = issue.blocks
    .map((id) => issues.find((i) => i.id === id))
    .filter(Boolean) as Issue[];

  const availableForBlockedBy = issues.filter(
    (i) => i.id !== issue.id && !issue.blockedBy.includes(i.id),
  );
  const availableForBlocks = issues.filter(
    (i) => i.id !== issue.id && !issue.blocks.includes(i.id),
  );

  const linkedWorkspace = issue.workspaceId
    ? workspaces.find((w) => w.id === issue.workspaceId)
    : null;

  function handleAddCriterion() {
    if (!newCriterionText.trim()) return;
    addCriterion(issueId, newCriterionText.trim());
    setNewCriterionText("");
  }

  function startEditingAssignee() {
    setAssigneeDraft(issue.assignee ?? "");
    setEditingAssignee(true);
  }

  function commitAssignee() {
    const next = assigneeDraft.trim();
    updateIssue(issueId, { assignee: next.length === 0 ? undefined : next });
    setEditingAssignee(false);
  }

  function buildIssuePrompt(): string {
    const lines: string[] = [];
    lines.push(`Work on this issue:`);
    lines.push(``);
    lines.push(`## ${issue.ticketId}: ${issue.title}`);
    if (issue.description) {
      lines.push(``);
      lines.push(issue.description);
    }
    if (issue.acceptanceCriteria.length > 0) {
      lines.push(``);
      lines.push(`### Acceptance Criteria`);
      for (const c of issue.acceptanceCriteria) {
        lines.push(`- [${c.checked ? "x" : " "}] ${c.text}`);
      }
    }
    if (issue.labels.length > 0) {
      lines.push(``);
      lines.push(`Labels: ${issue.labels.join(", ")}`);
    }
    if (issue.priority) {
      lines.push(`Priority: ${issue.priority}`);
    }
    return lines.join("\n");
  }

  async function handleSendToWorkspace(workspaceId: string) {
    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    const paneWithSession = ws.panes.find((p) => p.sessionId);
    if (!paneWithSession?.sessionId) return;

    const prompt = buildIssuePrompt();
    await writePty(paneWithSession.sessionId, prompt + "\r");

    // Stamp the linkage on the Issue so the card reflects "→ Workspace"
    // and we never re-offer the Send CTA for an Issue that's already in
    // a workspace. Mirrors what `sendIssueToWorkspace` does for new
    // workspaces; this branch is the "send to an existing pane" path.
    useIssueStore.getState().updateIssue(issue.id, {
      workspaceId,
      sessionId: paneWithSession.sessionId,
      sentToWorkspaceAt: Date.now(),
      status: issue.status === "done" ? issue.status : "in_progress",
    });

    useWorkspaceStore.getState().setActiveWorkspace(workspaceId);
    useAppStore.getState().setActiveView("workspace");
    onClose();
  }

  async function handleCreateAndSend() {
    // Use the canonical orchestrator action so the Issue picks up the
    // worktree-with-hook (auto-Done loop) and the linkage stamps land in
    // one place. The card's CTA goes through the same path.
    await useIssueStore.getState().sendIssueToWorkspace(issue.id);
    onClose();
  }

  function jumpToLinkedWorkspace() {
    if (!linkedWorkspace) return;
    useWorkspaceStore.getState().setActiveWorkspace(linkedWorkspace.id);
    useAppStore.getState().setActiveView("workspace");
    onClose();
  }

  function buildDepGraph(): string[] {
    const lines: string[] = [];
    lines.push(`${issue.ticketId}`);
    if (blockedByIssues.length > 0) {
      for (const b of blockedByIssues) {
        const marker = b.status === "done" ? "[done]" : "[pending]";
        lines.push(`  <- ${b.ticketId} ${marker}`);
      }
    }
    if (blocksIssues.length > 0) {
      for (const b of blocksIssues) {
        const marker = b.status === "done" ? "[done]" : "[pending]";
        lines.push(`  -> ${b.ticketId} ${marker}`);
      }
    }
    return lines;
  }

  const titleWithMeta = (
    <>
      <span className={issue.status === "done" ? "line-through opacity-60" : ""}>
        {issue.ticketId}: {issue.title}
      </span>
      <div className="flex items-center gap-2 mt-1 flex-wrap">
        <span className={`text-[11px] font-medium ${priorityInfo.cls}`}>
          {priorityInfo.text}
        </span>
        <span className="text-[10px] text-text-muted">
          {formatDate(issue.createdAt)}
        </span>
        {issue.labels.map((label) => {
          const color = getLabelColor(label);
          return (
            <span
              key={label}
              className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${color.bg} ${color.text}`}
            >
              {label}
            </span>
          );
        })}
        {issue.epic && (
          <span className="text-[9px] px-1.5 py-0.5 bg-accent-purple/15 text-accent-purple rounded font-medium">
            {issue.epic}
          </span>
        )}
      </div>
    </>
  );

  return (
    <Modal onClose={onClose} title="" width="w-[600px]">
      <div className="px-5 pt-1 pb-3 border-b border-bg-border">
        <h2 className="text-sm font-semibold text-text-primary leading-snug">
          {titleWithMeta}
        </h2>
      </div>

      <div className="px-5 py-4 flex flex-col gap-4">
        {/* Description (markdown so notes from spec import render properly) */}
        {issue.description && (
          <div className="text-xs text-text-secondary leading-relaxed">
            <MarkdownRenderer content={issue.description} />
          </div>
        )}

        {/* Status buttons row */}
        <div>
          <label className="block text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">
            Status
          </label>
          <div className="flex flex-wrap gap-1.5">
            {STATUS_BUTTONS.map((s) => (
              <button
                key={s.key}
                onClick={() => moveIssue(issueId, s.key)}
                className={`px-2.5 py-1 text-[11px] rounded border transition-colors ${getStatusButtonColor(s.key, issue.status === s.key)}`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Linked workspace pill (read-only — handoff CTA lives on the card) */}
        {linkedWorkspace && (
          <div>
            <label className="block text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">
              Workspace
            </label>
            <button
              type="button"
              onClick={jumpToLinkedWorkspace}
              className="inline-flex items-center gap-2 px-2.5 py-1.5 bg-bg-primary border border-bg-border rounded hover:border-accent-green/40 transition-colors group"
            >
              <LayoutGrid size={12} className="text-accent-green flex-shrink-0" />
              <span className="text-[11px] text-text-primary truncate">
                {linkedWorkspace.name}
              </span>
              <ExternalLink
                size={10}
                className="text-text-muted group-hover:text-accent-green transition-colors"
              />
            </button>
          </div>
        )}

        {/* Work on this issue (only when no linked workspace) */}
        {!linkedWorkspace && (
          !showWorkspacePicker ? (
            <button
              onClick={() => setShowWorkspacePicker(true)}
              className="flex items-center justify-center gap-2 py-2.5 bg-accent-green/15 border border-accent-green/30 rounded-lg text-accent-green text-xs font-medium hover:bg-accent-green/25 transition-colors"
            >
              <Play size={14} />
              Work on this issue
            </button>
          ) : (
            <WorkspacePicker
              onSelect={(wsId) => void handleSendToWorkspace(wsId)}
              onCreate={handleCreateAndSend}
              onCancel={() => setShowWorkspacePicker(false)}
            />
          )
        )}

        {/* Assignee */}
        <div>
          <label className="block text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">
            Assignee
          </label>
          {editingAssignee ? (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                autoFocus
                value={assigneeDraft}
                onChange={(e) => setAssigneeDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitAssignee();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditingAssignee(false);
                  }
                }}
                placeholder='username, email, or "me"'
                className="flex-1 bg-bg-primary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
              />
              <button
                type="button"
                onClick={commitAssignee}
                className="p-1 text-accent-green hover:text-accent-green/80 transition-colors"
                title="Save"
              >
                <Check size={12} />
              </button>
              <button
                type="button"
                onClick={() => setEditingAssignee(false)}
                className="p-1 text-text-muted hover:text-text-secondary transition-colors"
                title="Cancel"
              >
                <X size={12} />
              </button>
            </div>
          ) : issue.assignee ? (
            <button
              type="button"
              onClick={startEditingAssignee}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-bg-primary border border-bg-border rounded text-[11px] text-text-primary hover:border-accent-green/40 transition-colors"
            >
              <UserPlus size={11} className="text-accent-green" />
              {issue.assignee}
            </button>
          ) : (
            <button
              type="button"
              onClick={startEditingAssignee}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-bg-primary border border-dashed border-bg-border rounded text-[11px] text-text-muted hover:text-text-secondary hover:border-line-strong transition-colors"
            >
              <UserPlus size={11} />
              Assign...
            </button>
          )}
        </div>

        {/* Flight assignment */}
        <div>
          <label className="block text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">
            Flight
          </label>
          {issue.flightId ? (
            <div className="flex items-center gap-2 px-2.5 py-1.5 bg-bg-primary border border-bg-border rounded">
              <Target size={12} className="text-accent-green flex-shrink-0" />
              <span className="text-[11px] text-text-primary flex-1 truncate">
                {flights.find((f) => f.id === issue.flightId)?.title || "Unknown flight"}
              </span>
              <button
                onClick={() => {
                  if (issue.flightId) {
                    removeIssueFromFlight(issue.flightId, issue.id);
                    assignToFlight(issue.id, null);
                  }
                }}
                className="p-0.5 text-text-muted hover:text-accent-red transition-colors flex-shrink-0"
                title="Remove from flight"
              >
                <X size={10} />
              </button>
            </div>
          ) : (
            <select
              className="w-full bg-bg-primary border border-bg-border rounded px-2 py-1.5 text-[11px] text-text-secondary focus:outline-none focus:border-accent-green"
              value=""
              onChange={(e) => {
                if (e.target.value) {
                  addIssueToFlight(e.target.value, issue.id);
                  assignToFlight(issue.id, e.target.value);
                }
              }}
            >
              <option value="">Assign to flight...</option>
              {flights.map((f) => (
                <option key={f.id} value={f.id}>{f.title}</option>
              ))}
            </select>
          )}
        </div>

        <IssueDependencyList
          label="Blocked By"
          emptyText="No blockers"
          selectPlaceholder="Select blocking issue..."
          linkedIssues={blockedByIssues}
          availableIssues={availableForBlockedBy}
          onAdd={(targetId) => addBlockedBy(issueId, targetId)}
          onRemove={(targetId) => removeBlockedBy(issueId, targetId)}
        />

        <IssueDependencyList
          label="Blocks"
          emptyText="No downstream issues"
          selectPlaceholder="Select issue to block..."
          linkedIssues={blocksIssues}
          availableIssues={availableForBlocks}
          onAdd={(targetId) => addBlocks(issueId, targetId)}
          onRemove={(targetId) => removeBlocks(issueId, targetId)}
        />

        {(blockedByIssues.length > 0 || blocksIssues.length > 0) && (
          <div>
            <button
              onClick={() => setShowDepGraph(!showDepGraph)}
              className="flex items-center gap-1 text-[10px] text-text-muted uppercase tracking-wider hover:text-text-secondary transition-colors"
            >
              {showDepGraph ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Dependency Graph
            </button>
            {showDepGraph && (
              <div className="mt-1.5 p-2 bg-bg-primary rounded border border-bg-border">
                <pre className="text-[10px] text-text-secondary font-mono leading-relaxed">
                  {buildDepGraph().join("\n")}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* Acceptance Criteria */}
        <div>
          <label className="block text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">
            Acceptance Criteria ({checkedCount}/{totalCriteria} complete)
          </label>
          {issue.acceptanceCriteria.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {issue.acceptanceCriteria.map((criterion) => (
                <div key={criterion.id} className="flex items-start gap-2 group">
                  <input
                    type="checkbox"
                    checked={criterion.checked}
                    onChange={() => toggleCriterion(issueId, criterion.id)}
                    className="mt-0.5 accent-[#00ff41] cursor-pointer"
                  />
                  <span
                    className={`text-[11px] leading-snug flex-1 ${
                      criterion.checked ? "line-through text-text-muted" : "text-text-secondary"
                    }`}
                  >
                    {criterion.text}
                  </span>
                  <button
                    onClick={() => removeCriterion(issueId, criterion.id)}
                    className="p-0.5 text-text-muted hover:text-accent-red opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-text-muted">No acceptance criteria defined</p>
          )}

          <div className="flex items-center gap-1.5 mt-2">
            <input
              type="text"
              value={newCriterionText}
              onChange={(e) => setNewCriterionText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddCriterion();
                }
              }}
              placeholder="Add criterion..."
              className="flex-1 bg-bg-primary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
            />
            <button
              onClick={handleAddCriterion}
              disabled={!newCriterionText.trim()}
              className="p-1 text-text-muted hover:text-accent-green transition-colors disabled:opacity-30"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        {/* Comments thread (v0.8.5) */}
        <div>
          <label className="block text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">
            Comments
          </label>
          <IssueCommentList issueId={issueId} comments={comments} />
          <div className="mt-2">
            <IssueCommentComposer issueId={issueId} />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function WorkspacePicker({
  onSelect,
  onCreate,
  onCancel,
}: {
  onSelect: (workspaceId: string) => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const projectPath = useLayoutStore((s) => s.projectPath);
  const projectName = projectPath.split(/[/\\]/).pop() || "Workspace";

  const activeWorkspaces = workspaces.filter(
    (w) =>
      w.status === "active" &&
      w.projectPath.replace(/\\/g, "/").toLowerCase() ===
        projectPath.replace(/\\/g, "/").toLowerCase(),
  );

  const workspacesWithSessions = activeWorkspaces.filter((w) =>
    w.panes.some((p) => p.sessionId),
  );

  return (
    <div className="bg-bg-primary border border-bg-border rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-text-muted uppercase tracking-wider font-medium">
          Send to workspace
        </span>
        <button
          onClick={onCancel}
          className="text-text-muted hover:text-text-primary"
        >
          <X size={12} />
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {workspacesWithSessions.map((ws) => (
          <button
            key={ws.id}
            onClick={() => onSelect(ws.id)}
            className="flex items-center gap-2 w-full px-3 py-2 text-left bg-bg-secondary border border-bg-border rounded-lg hover:border-accent-green/30 hover:bg-bg-hover transition-colors"
          >
            <LayoutGrid size={12} className="text-text-muted flex-shrink-0" />
            <span className="text-[11px] text-text-primary font-medium truncate">
              {ws.name}
            </span>
            <span className="text-[10px] text-text-muted ml-auto flex-shrink-0">
              {ws.panes.filter((p) => p.sessionId).length} active
            </span>
          </button>
        ))}
        <button
          onClick={onCreate}
          className="flex items-center gap-2 w-full px-3 py-2 text-left bg-accent-green/5 border border-accent-green/20 rounded-lg hover:bg-accent-green/10 transition-colors"
        >
          <Plus size={12} className="text-accent-green flex-shrink-0" />
          <span className="text-[11px] text-accent-green font-medium truncate">
            Create workspace "{projectName}"
          </span>
        </button>
      </div>
    </div>
  );
}
