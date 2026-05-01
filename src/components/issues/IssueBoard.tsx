import { useState, useMemo } from "react";
import { Plus, Search, Github } from "lucide-react";
import {
  useIssueStore,
  type Issue,
  type IssueStatus,
} from "@/stores/issueStore";
import { useFlightStore } from "@/stores/flightStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { APP_NAME_LOWER } from "@/lib/brand";
import { IssueCard } from "./IssueCard";
import { NewIssueForm } from "./NewIssueForm";
import { IssueDetailView } from "./IssueDetailView";
import { SpecImportModal } from "@/components/views/SpecImportModal";

const DESIGN_COLUMNS: { key: IssueStatus; label: string }[] = [
  { key: "todo", label: "To Do" },
  { key: "in_progress", label: "In Progress" },
  { key: "qa", label: "QA" },
  { key: "needs_human", label: "Needs Human" },
  { key: "done", label: "Done" },
];

export function IssueBoard() {
  const issues = useIssueStore((s) => s.issues);
  const labels = useIssueStore((s) => s.labels);
  const moveIssue = useIssueStore((s) => s.moveIssue);
  const flights = useFlightStore((s) => s.flights);
  const activeWorkspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId));

  const [showNewIssue, setShowNewIssue] = useState(false);
  const [showSpecImport, setShowSpecImport] = useState(false);
  const [newIssueColumn, setNewIssueColumn] = useState<IssueStatus>("todo");
  const [dragOverColumn, setDragOverColumn] = useState<IssueStatus | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);

  const [filterText, setFilterText] = useState("");
  const [filterFlight, setFilterFlight] = useState<string>("all");
  const [filterLabel, setFilterLabel] = useState<string>("all");

  const filteredIssues = useMemo(() => {
    return issues.filter((issue) => {
      if (filterText) {
        const q = filterText.toLowerCase();
        const labelMatch = issue.labels.some((l) => l.toLowerCase().includes(q));
        const flight = flights.find((f) => f.issueIds.includes(issue.id));
        const flightMatch = flight ? flight.title.toLowerCase().includes(q) : false;
        if (
          !issue.title.toLowerCase().includes(q) &&
          !issue.description.toLowerCase().includes(q) &&
          !issue.ticketId.toLowerCase().includes(q) &&
          !labelMatch &&
          !flightMatch
        ) {
          return false;
        }
      }
      if (filterLabel !== "all" && !issue.labels.includes(filterLabel)) return false;
      if (filterFlight === "unassigned" && issue.flightId !== null) return false;
      if (filterFlight !== "all" && filterFlight !== "unassigned" && issue.flightId !== filterFlight) return false;
      return true;
    });
  }, [issues, flights, filterText, filterFlight, filterLabel]);

  const totalIssues = filteredIssues.length;
  const projectName = activeWorkspace?.name ?? APP_NAME_LOWER;

  function handleDragStart(e: React.DragEvent, issueId: string) {
    e.dataTransfer.setData("text/plain", issueId);
    e.dataTransfer.effectAllowed = "move";
    setDraggingId(issueId);
  }

  function handleDragEnd() {
    setDraggingId(null);
    setDragOverColumn(null);
  }

  function handleDragOver(e: React.DragEvent, columnKey: IssueStatus) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverColumn(columnKey);
  }

  function handleDragLeave() {
    setDragOverColumn(null);
  }

  function handleDrop(e: React.DragEvent, columnKey: IssueStatus) {
    e.preventDefault();
    const issueId = e.dataTransfer.getData("text/plain");
    if (issueId) {
      moveIssue(issueId, columnKey);
    }
    setDragOverColumn(null);
    setDraggingId(null);
  }

  function getIssuesForColumn(status: IssueStatus): Issue[] {
    return filteredIssues.filter((i) => i.status === status);
  }

  return (
    <div className="flex flex-1 flex-col gap-2.5 bg-bg-primary p-3 min-h-0 h-full">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold text-text-primary">
          Backlog &middot; {projectName}
        </span>
        <span className="rounded-full border border-bg-border bg-bg-secondary px-1.5 py-0 text-[10px] text-text-muted">
          {totalIssues} issue{totalIssues === 1 ? "" : "s"}
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 rounded-md border border-bg-border bg-bg-secondary px-2 py-1 text-[11px] text-text-secondary min-w-[200px]">
          <Search size={11} className="text-text-muted flex-shrink-0" />
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Filter by label, agent, flight…"
            className="flex-1 bg-transparent text-text-primary placeholder:text-text-muted focus:outline-none"
          />
        </div>
        <select
          value={filterLabel}
          onChange={(e) => setFilterLabel(e.target.value)}
          className="rounded-md border border-bg-border bg-bg-secondary px-2 py-1 text-[11px] text-text-secondary focus:border-accent-line focus:outline-none"
        >
          <option value="all">All labels</option>
          {labels.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
        <select
          value={filterFlight}
          onChange={(e) => setFilterFlight(e.target.value)}
          className="rounded-md border border-bg-border bg-bg-secondary px-2 py-1 text-[11px] text-text-secondary focus:border-accent-line focus:outline-none"
        >
          <option value="all">All flights</option>
          <option value="unassigned">Unassigned</option>
          {flights.map((f) => (
            <option key={f.id} value={f.id}>{f.title}</option>
          ))}
        </select>
        <button
          onClick={() => setShowSpecImport(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-bg-border bg-bg-secondary px-2 py-1 text-[11px] text-text-secondary transition-colors hover:border-line-strong hover:text-text-primary"
        >
          <Github size={11} />
          Sync GitHub
        </button>
        <button
          onClick={() => {
            setNewIssueColumn("todo");
            setShowNewIssue(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-accent-line bg-accent-soft px-2 py-1 text-[11px] font-medium text-accent-green transition-colors hover:bg-accent-green/20"
        >
          <Plus size={11} />
          New issue
        </button>
      </div>

      <div className="grid flex-1 grid-cols-5 gap-2.5 min-h-0">
        {DESIGN_COLUMNS.map((col) => {
          const columnIssues = getIssuesForColumn(col.key);
          const isDragOver = dragOverColumn === col.key;

          return (
            <div
              key={col.key}
              className={`flex min-h-0 flex-col overflow-hidden rounded-md border bg-bg-secondary transition-colors ${
                isDragOver ? "border-accent-line" : "border-bg-border"
              }`}
              onDragOver={(e) => handleDragOver(e, col.key)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, col.key)}
              onDragEnd={handleDragEnd}
            >
              <div className="flex items-center gap-1.5 border-b border-line-soft bg-bg-secondary px-2.5 py-2">
                <span className="text-[11px] font-semibold text-text-primary">
                  {col.label}
                </span>
                <span className="rounded-full border border-bg-border bg-bg-tertiary px-1.5 text-[10px] text-text-muted">
                  {columnIssues.length}
                </span>
                <div className="flex-1" />
                <button
                  onClick={() => {
                    setNewIssueColumn(col.key);
                    setShowNewIssue(true);
                  }}
                  className="text-text-faint transition-colors hover:text-text-secondary"
                >
                  <Plus size={11} />
                </button>
              </div>

              <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
                {isDragOver && draggingId && (
                  <div className="mx-1 h-1 rounded-full bg-accent-line transition-all" />
                )}
                {columnIssues.map((issue) => (
                  <IssueCard
                    key={issue.id}
                    issue={issue}
                    onDragStart={(e) => handleDragStart(e, issue.id)}
                    onClick={() => setSelectedIssueId(issue.id)}
                    isDragging={draggingId === issue.id}
                  />
                ))}
                <button
                  onClick={() => {
                    setNewIssueColumn(col.key);
                    setShowNewIssue(true);
                  }}
                  className="inline-flex items-center justify-center gap-1.5 rounded-md border border-dashed border-line-strong bg-transparent px-2 py-1.5 text-[11px] text-text-faint transition-colors hover:border-text-muted hover:text-text-muted"
                >
                  <Plus size={11} />
                  Add
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {showNewIssue && (
        <NewIssueForm
          defaultStatus={newIssueColumn}
          onClose={() => setShowNewIssue(false)}
        />
      )}

      {selectedIssueId && (
        <IssueDetailView
          issueId={selectedIssueId}
          onClose={() => setSelectedIssueId(null)}
        />
      )}

      {showSpecImport && (
        <SpecImportModal onClose={() => setShowSpecImport(false)} />
      )}
    </div>
  );
}
