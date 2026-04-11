import { useState } from "react";
import {
  Loader2,
  Check,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Rocket,
  FileText,
} from "lucide-react";
import { parseSpecToFlight } from "@/lib/tauri";
import { useFlightStore } from "@/stores/flightStore";
import { useOrchestrationStore } from "@/stores/orchestrationStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore } from "@/stores/appStore";
import { Modal } from "@/components/ui/Modal";
import { parseJsonFromResponse } from "@/lib/storage";
import { TASK_TYPE_LABELS } from "@/types/routing";
import type { FlightPriority, TaskType } from "@/types/flight";
import type {
  FlightPlanCandidate,
  FlightPlanMilestoneCandidate,
  FlightPlanTaskCandidate,
} from "@/types/spec";

type Phase = "paste" | "loading" | "preview" | "creating";

const ALL_PRIORITIES: FlightPriority[] = ["low", "medium", "high", "critical"];

const VALID_TASK_TYPES: TaskType[] = [
  "implementation", "testing", "review", "validation",
  "research", "refactor", "documentation",
];

function parseFlightPlan(raw: string): FlightPlanCandidate {
  const parsed = parseJsonFromResponse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.milestones)) {
    throw new Error("Expected a JSON object with a milestones array");
  }

  const milestones = (parsed.milestones as Record<string, unknown>[]).map(
    (ms): FlightPlanMilestoneCandidate => ({
      title: String(ms.title || "Untitled Milestone"),
      description: String(ms.description || ""),
      validationCriteria: Array.isArray(ms.validationCriteria)
        ? ms.validationCriteria.map(String)
        : [],
      tasks: Array.isArray(ms.tasks)
        ? (ms.tasks as Record<string, unknown>[]).map(
            (t): FlightPlanTaskCandidate => ({
              title: String(t.title || "Untitled Task"),
              description: String(t.description || ""),
              type: VALID_TASK_TYPES.includes(t.type as TaskType)
                ? (t.type as TaskType)
                : "implementation",
              dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
              selected: true,
            }),
          )
        : [],
      selected: true,
    }),
  );

  if (milestones.length === 0) {
    throw new Error("No milestones were generated from the spec");
  }

  return {
    title: String(parsed.title || ""),
    objective: String(parsed.objective || ""),
    priority: (["low", "medium", "high", "critical"].includes(parsed.priority as string)
      ? parsed.priority
      : "medium") as FlightPlanCandidate["priority"],
    milestones,
  };
}

interface SpecToFlightModalProps {
  onClose: () => void;
}

export function SpecToFlightModal({ onClose }: SpecToFlightModalProps) {
  const [phase, setPhase] = useState<Phase>("paste");
  const [specText, setSpecText] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Flight plan state (editable in preview)
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [priority, setPriority] = useState<FlightPriority>("medium");
  const [milestones, setMilestones] = useState<FlightPlanMilestoneCandidate[]>([]);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const addFlight = useFlightStore((s) => s.addFlight);
  const addMilestone = useFlightStore((s) => s.addMilestone);
  const addTask = useFlightStore((s) => s.addTask);
  const setActiveFlight = useFlightStore((s) => s.setActiveFlight);
  const launchFlight = useOrchestrationStore((s) => s.launchFlight);
  const projectPath = useLayoutStore((s) => s.projectPath);
  const setActiveView = useAppStore((s) => s.setActiveView);

  const selectedMilestones = milestones.filter((m) => m.selected);
  const totalTasks = selectedMilestones.reduce(
    (sum, m) => sum + m.tasks.filter((t) => t.selected).length,
    0,
  );

  async function handleGenerate() {
    if (!specText.trim()) return;
    setPhase("loading");
    setError(null);
    try {
      const raw = await parseSpecToFlight(specText);
      const plan = parseFlightPlan(raw);
      setTitle(plan.title);
      setObjective(plan.objective);
      setPriority(plan.priority);
      setMilestones(plan.milestones);
      setPhase("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("paste");
    }
  }

  function toggleMilestone(idx: number) {
    setMilestones((prev) =>
      prev.map((m, i) =>
        i === idx
          ? {
              ...m,
              selected: !m.selected,
              tasks: m.tasks.map((t) => ({ ...t, selected: !m.selected })),
            }
          : m,
      ),
    );
  }

  function toggleTask(msIdx: number, taskIdx: number) {
    setMilestones((prev) =>
      prev.map((m, mi) => {
        if (mi !== msIdx) return m;
        const tasks = m.tasks.map((t, ti) =>
          ti === taskIdx ? { ...t, selected: !t.selected } : t,
        );
        const anySelected = tasks.some((t) => t.selected);
        return { ...m, tasks, selected: anySelected };
      }),
    );
  }

  function toggleCollapse(idx: number) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  async function handleCreate(launch: boolean) {
    if (!title.trim()) return;
    setPhase("creating");

    const flight = addFlight({
      title: title.trim(),
      objective: objective.trim(),
      priority,
      projectPath: projectPath || "",
      issueIds: [],
    });

    // Resolve positional dependsOn refs to real task IDs
    const taskIdMap = new Map<string, string>();

    for (let mi = 0; mi < milestones.length; mi++) {
      const ms = milestones[mi];
      if (!ms.selected) continue;

      const msId = addMilestone(flight.id, {
        title: ms.title,
        description: ms.description,
        validationCriteria: ms.validationCriteria,
      });

      for (let ti = 0; ti < ms.tasks.length; ti++) {
        const task = ms.tasks[ti];
        if (!task.selected) continue;

        const resolvedDeps = task.dependsOn
          .map((ref) => taskIdMap.get(ref))
          .filter((id): id is string => id != null);

        const taskId = addTask(flight.id, msId, {
          title: task.title,
          description: task.description,
          type: task.type,
          dependsOn: resolvedDeps,
        });
        taskIdMap.set(`m${mi}-t${ti}`, taskId);
      }
    }

    setActiveFlight(flight.id);

    if (launch) {
      await launchFlight(flight.id);
    }
    setActiveView("flight_deck");

    onClose();
  }

  const footerContent = (
    <div className="flex items-center justify-between">
      {phase === "preview" ? (
        <>
          <button
            onClick={() => {
              setPhase("paste");
              setMilestones([]);
            }}
            className="flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary transition-colors"
          >
            <ChevronLeft size={12} />
            Back
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleCreate(false)}
              disabled={totalTasks === 0}
              className="px-3 py-1.5 text-[11px] font-medium rounded border border-bg-border text-text-secondary hover:text-text-primary hover:border-accent-green/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span className="flex items-center gap-1.5">
                <FileText size={11} />
                Create as Draft
              </span>
            </button>
            <button
              onClick={() => handleCreate(true)}
              disabled={totalTasks === 0}
              className="px-3 py-1.5 text-[11px] font-medium rounded bg-accent-green text-bg-primary hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span className="flex items-center gap-1.5">
                <Rocket size={11} />
                Create & Launch
              </span>
            </button>
          </div>
        </>
      ) : phase === "paste" ? (
        <>
          <div />
          <button
            onClick={handleGenerate}
            disabled={!specText.trim()}
            className="px-3 py-1.5 text-[11px] font-medium rounded bg-accent-green text-bg-primary hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Generate Flight Plan
          </button>
        </>
      ) : (
        <div />
      )}
    </div>
  );

  return (
    <Modal
      onClose={onClose}
      title="Import Spec to Flight"
      icon={<Rocket size={14} className="text-accent-green" />}
      width="w-[780px] max-w-[95vw]"
      footer={footerContent}
    >
      <div className="p-4" style={{ maxHeight: "min(520px, 65vh)", overflowY: "auto" }}>
        {/* Phase: Paste */}
        {phase === "paste" && (
          <div className="flex flex-col gap-3">
            <p className="text-[11px] text-text-muted">
              Paste your project spec from Vibe Architect below. Claude will parse
              it into a structured flight plan with milestones and tasks.
            </p>
            {error && (
              <div className="flex items-center gap-2 px-3 py-2 rounded bg-red-500/10 border border-red-500/30">
                <AlertCircle size={12} className="text-red-400 shrink-0" />
                <span className="text-[11px] text-red-400">{error}</span>
              </div>
            )}
            <textarea
              value={specText}
              onChange={(e) => setSpecText(e.target.value)}
              placeholder="Paste your project spec here..."
              className="w-full h-64 px-3 py-2 text-[11px] font-mono bg-bg-primary border border-bg-border rounded text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-green resize-none"
            />
          </div>
        )}

        {/* Phase: Loading */}
        {phase === "loading" && (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <Loader2 size={24} className="text-accent-green animate-spin" />
            <span className="text-xs text-text-muted">
              Claude is building your flight plan...
            </span>
          </div>
        )}

        {/* Phase: Creating */}
        {phase === "creating" && (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <Loader2 size={24} className="text-accent-green animate-spin" />
            <span className="text-xs text-text-muted">Creating flight...</span>
          </div>
        )}

        {/* Phase: Preview */}
        {phase === "preview" && (
          <div className="flex flex-col gap-4">
            {/* Flight details */}
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-medium text-text-secondary">
                  Flight Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full bg-bg-primary text-xs text-text-primary px-3 py-2 rounded border border-bg-border outline-none focus:border-accent-green/50"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-medium text-text-secondary">
                  Objective
                </label>
                <textarea
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  rows={2}
                  className="w-full bg-bg-primary text-xs text-text-primary px-3 py-2 rounded border border-bg-border outline-none focus:border-accent-green/50 resize-none"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-medium text-text-secondary">
                  Priority
                </label>
                <div className="flex rounded-lg border border-bg-border overflow-hidden">
                  {ALL_PRIORITIES.map((p) => (
                    <button
                      key={p}
                      onClick={() => setPriority(p)}
                      className={`flex-1 py-1.5 text-xs font-medium transition-colors border-r last:border-r-0 border-bg-border ${
                        priority === p
                          ? "bg-accent-green/15 text-accent-green"
                          : "bg-bg-primary text-text-muted hover:text-text-secondary"
                      }`}
                    >
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Summary */}
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-text-muted">
                {selectedMilestones.length} milestone{selectedMilestones.length !== 1 ? "s" : ""},{" "}
                {totalTasks} task{totalTasks !== 1 ? "s" : ""} selected
              </span>
            </div>

            {/* Milestones */}
            <div className="flex flex-col gap-2">
              {milestones.map((ms, mi) => (
                <div
                  key={mi}
                  className={`rounded border transition-colors ${
                    ms.selected
                      ? "border-accent-green/30 bg-accent-green/5"
                      : "border-bg-border bg-bg-primary opacity-60"
                  }`}
                >
                  {/* Milestone header */}
                  <div className="flex items-center gap-2 px-3 py-2">
                    <div
                      onClick={() => toggleMilestone(mi)}
                      className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 cursor-pointer ${
                        ms.selected
                          ? "bg-accent-green border-accent-green"
                          : "border-bg-border"
                      }`}
                    >
                      {ms.selected && <Check size={10} className="text-bg-primary" />}
                    </div>
                    <button
                      onClick={() => toggleCollapse(mi)}
                      className="p-0.5 text-text-muted hover:text-text-primary transition-colors"
                    >
                      {collapsed.has(mi) ? (
                        <ChevronRight size={12} />
                      ) : (
                        <ChevronDown size={12} />
                      )}
                    </button>
                    <div className="flex-1 min-w-0">
                      <span className="text-[11px] font-semibold text-text-primary">
                        {ms.title}
                      </span>
                      <span className="text-[9px] text-text-muted ml-2">
                        {ms.tasks.filter((t) => t.selected).length}/{ms.tasks.length} tasks
                      </span>
                    </div>
                    {ms.validationCriteria.length > 0 && (
                      <span className="text-[9px] text-text-muted">
                        {ms.validationCriteria.length} criteria
                      </span>
                    )}
                  </div>

                  {/* Description */}
                  {!collapsed.has(mi) && ms.description && (
                    <div className="px-3 pb-1">
                      <p className="text-[10px] text-text-muted pl-[52px]">
                        {ms.description}
                      </p>
                    </div>
                  )}

                  {/* Tasks */}
                  {!collapsed.has(mi) && (
                    <div className="flex flex-col gap-0.5 px-3 pb-2">
                      {ms.tasks.map((task, ti) => {
                        const typeLabel =
                          TASK_TYPE_LABELS[task.type]?.label ?? task.type;
                        return (
                          <div
                            key={ti}
                            onClick={() => toggleTask(mi, ti)}
                            className={`flex items-center gap-2 pl-[52px] pr-2 py-1.5 rounded cursor-pointer transition-colors ${
                              task.selected
                                ? "hover:bg-accent-green/10"
                                : "opacity-50 hover:opacity-70"
                            }`}
                          >
                            <div
                              className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                                task.selected
                                  ? "bg-accent-green border-accent-green"
                                  : "border-bg-border"
                              }`}
                            >
                              {task.selected && (
                                <Check size={8} className="text-bg-primary" />
                              )}
                            </div>
                            <span className="text-[11px] text-text-primary flex-1 min-w-0 truncate">
                              {task.title}
                            </span>
                            <span
                              className={`text-[9px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                                task.type === "testing" || task.type === "validation"
                                  ? "bg-accent-blue/15 text-accent-blue"
                                  : task.type === "review"
                                    ? "bg-accent-purple/15 text-accent-purple"
                                    : task.type === "documentation"
                                      ? "bg-accent-amber/15 text-accent-amber"
                                      : "bg-bg-elevated text-text-muted"
                              }`}
                            >
                              {typeLabel}
                            </span>
                            {task.dependsOn.length > 0 && (
                              <span
                                className="text-[8px] text-text-muted shrink-0"
                                title={`Depends on: ${task.dependsOn.join(", ")}`}
                              >
                                dep:{task.dependsOn.length}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
