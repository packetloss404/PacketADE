import { useMemo, useRef, useState, useEffect } from "react";
import { Check, ChevronDown, Tag, Plane, LayoutGrid, UserPlus, X } from "lucide-react";

export interface IssueFilterSelection {
  labels: string[];
  epics: string[];
  workspaces: string[];
  assignees: string[];
}

interface IssueFilterChipsProps {
  /** Available options for each category. */
  labels: string[];
  epics: string[];
  workspaces: { id: string; name: string }[];
  assignees: string[];
  /** Current selection. */
  selection: IssueFilterSelection;
  onChange: (next: IssueFilterSelection) => void;
}

/**
 * v0.8.5: filter chip strip above the Kanban columns. Each category is a
 * multi-select popover; selection is local React state owned by the parent
 * (`IssueBoard`) and is **not** persisted across reloads.
 *
 * Filter semantics: within a category, all selected values are OR'd
 * (issue passes if it has any of the selected labels). Across categories,
 * categories are AND'd (typical Kanban filter behaviour).
 */
export function IssueFilterChips({
  labels,
  epics,
  workspaces,
  assignees,
  selection,
  onChange,
}: IssueFilterChipsProps) {
  function setLabels(next: string[]) {
    onChange({ ...selection, labels: next });
  }
  function setEpics(next: string[]) {
    onChange({ ...selection, epics: next });
  }
  function setWorkspaces(next: string[]) {
    onChange({ ...selection, workspaces: next });
  }
  function setAssignees(next: string[]) {
    onChange({ ...selection, assignees: next });
  }

  const hasAny =
    selection.labels.length +
      selection.epics.length +
      selection.workspaces.length +
      selection.assignees.length >
    0;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <FilterChip
        icon={<Tag size={10} className="text-text-muted" />}
        label="Label"
        options={labels.map((l) => ({ value: l, label: l }))}
        selected={selection.labels}
        onApply={setLabels}
      />
      <FilterChip
        icon={<LayoutGrid size={10} className="text-text-muted" />}
        label="Epic"
        options={epics.map((e) => ({ value: e, label: e }))}
        selected={selection.epics}
        onApply={setEpics}
      />
      <FilterChip
        icon={<Plane size={10} className="text-text-muted" />}
        label="Workspace"
        options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
        selected={selection.workspaces}
        onApply={setWorkspaces}
      />
      <FilterChip
        icon={<UserPlus size={10} className="text-text-muted" />}
        label="Assignee"
        options={assignees.map((a) => ({ value: a, label: a }))}
        selected={selection.assignees}
        onApply={setAssignees}
      />
      {hasAny && (
        <button
          type="button"
          onClick={() =>
            onChange({ labels: [], epics: [], workspaces: [], assignees: [] })
          }
          className="inline-flex items-center gap-1 text-[10.5px] text-text-muted hover:text-accent-red transition-colors px-1.5 py-0.5"
        >
          <X size={10} />
          Clear filters
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface FilterChipProps {
  icon: React.ReactNode;
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onApply: (next: string[]) => void;
}

function FilterChip({ icon, label, options, selected, onApply }: FilterChipProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
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

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, filter]);

  const count = selected.length;
  const triggerLabel =
    count === 0
      ? label
      : count === 1
        ? // Show the actual selected name when only one is picked.
          options.find((o) => o.value === selected[0])?.label ?? label
        : `${count} ${label.toLowerCase()}s`;

  function toggle(value: string) {
    if (selected.includes(value)) {
      onApply(selected.filter((v) => v !== value));
    } else {
      onApply([...selected, value]);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 px-2 py-1 text-[10.5px] font-medium rounded border transition-colors ${
          count > 0
            ? "bg-accent-green/15 text-accent-green border-accent-green/30 hover:bg-accent-green/25"
            : "bg-bg-secondary text-text-secondary border-bg-border hover:border-line-strong hover:text-text-primary"
        }`}
        title={`Filter by ${label.toLowerCase()}`}
      >
        {icon}
        <span>{triggerLabel}</span>
        {count > 0 && (
          <span className="text-[9.5px] rounded-full bg-accent-green/25 px-1.5 leading-tight">
            {count}
          </span>
        )}
        <ChevronDown size={9} className="text-text-muted" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-30 min-w-[200px] max-w-[280px] max-h-[300px] overflow-y-auto bg-bg-secondary border border-bg-border rounded shadow-lg p-2 flex flex-col gap-1.5">
          {options.length > 6 && (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${label.toLowerCase()}s...`}
              className="bg-bg-primary border border-bg-border rounded px-2 py-1 text-[10.5px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green/60"
              autoFocus
            />
          )}
          {filtered.length === 0 ? (
            <div className="text-[10.5px] text-text-muted px-1 py-2">
              No {label.toLowerCase()}s available.
            </div>
          ) : (
            <div className="flex flex-col">
              {filtered.map((o) => {
                const on = selected.includes(o.value);
                return (
                  <button
                    type="button"
                    key={o.value}
                    onClick={() => toggle(o.value)}
                    className={`flex items-center gap-2 px-2 py-1 text-[10.5px] rounded hover:bg-bg-tertiary text-left ${
                      on ? "text-text-primary" : "text-text-secondary"
                    }`}
                  >
                    <span className="w-3.5 flex justify-center flex-shrink-0">
                      {on ? <Check size={10} className="text-accent-green" /> : null}
                    </span>
                    <span className="truncate">{o.label}</span>
                  </button>
                );
              })}
            </div>
          )}
          {count > 0 && (
            <div className="flex items-center gap-2 pt-1 border-t border-bg-border">
              <span className="text-[10px] text-text-muted">{count} selected</span>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => onApply([])}
                className="text-[10px] text-text-muted hover:text-accent-red transition-colors"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
