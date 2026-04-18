import { useState } from "react";
import { Target, Rocket, ListTree } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useFlightStore } from "@/stores/flightStore";
import { useOrchestrationStore } from "@/stores/orchestrationStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useFlightChat } from "@/hooks/useFlightChat";
import { FlightChatPanel } from "@/components/flights/FlightChatPanel";
import type { FlightPriority } from "@/types/flight";
import type { FlightPlanSuggestion } from "@/hooks/useFlightChat";

const ALL_PRIORITIES: FlightPriority[] = ["low", "medium", "high", "critical"];

interface NewFlightModalProps {
  onClose: () => void;
  onCreated?: (id: string) => void;
}

export function NewFlightModal({ onClose, onCreated }: NewFlightModalProps) {
  const addFlight = useFlightStore((s) => s.addFlight);
  const addMilestone = useFlightStore((s) => s.addMilestone);
  const addTask = useFlightStore((s) => s.addTask);
  const launchFlight = useOrchestrationStore((s) => s.launchFlight);
  const projectPath = useLayoutStore((s) => s.projectPath);
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [priority, setPriority] = useState<FlightPriority>("medium");
  const [appliedPlan, setAppliedPlan] = useState<FlightPlanSuggestion | null>(null);

  const chat = useFlightChat();

  function applyPlanToFlight(flightId: string, plan: FlightPlanSuggestion) {
    for (const ms of plan.milestones) {
      const msId = addMilestone(flightId, {
        title: ms.title,
        description: ms.description,
        validationCriteria: ms.validationCriteria,
      });
      // Build a title->id map for dependsOn resolution within this milestone
      const titleToId = new Map<string, string>();
      for (const task of ms.tasks) {
        const taskId = addTask(flightId, msId, {
          title: task.title,
          description: task.description,
          type: task.type,
          dependsOn: task.dependsOn
            .map((dep) => titleToId.get(dep))
            .filter((id): id is string => id !== undefined),
        });
        titleToId.set(task.title, taskId);
      }
    }
  }

  function handleCreate(andLaunch = false) {
    if (!title.trim()) return;
    const f = addFlight({
      title: title.trim(),
      objective: objective.trim(),
      priority,
      projectPath: activeWorkspace?.projectPath || projectPath || "",
      workspaceId: activeWorkspace?.id ?? null,
      issueIds: [],
    });

    // Apply the plan (milestones + tasks) if one was accepted
    const plan = appliedPlan ?? chat.latestPlan;
    if (plan) {
      applyPlanToFlight(f.id, plan);
    }

    if (andLaunch && plan) {
      void launchFlight(f.id);
    }

    onCreated?.(f.id);
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      handleCreate();
    }
  }

  function handleChatSend(content: string) {
    // Pass current milestones to give the AI context about what's already planned
    const milestones = appliedPlan
      ? appliedPlan.milestones.map((m) => ({
          title: m.title,
          tasks: m.tasks.map((t) => ({ title: t.title, type: t.type })),
        }))
      : [];
    chat.sendMessage(content, { title, objective, priority, milestones });
  }

  function handleApplySuggestion() {
    if (!chat.latestSuggestion) return;
    const s = chat.latestSuggestion;
    if (s.title !== undefined) setTitle(s.title);
    if (s.objective !== undefined) setObjective(s.objective);
    if (s.priority !== undefined) setPriority(s.priority);
    chat.dismissSuggestion();
  }

  function handleApplyPlan() {
    if (!chat.latestPlan) return;
    const p = chat.latestPlan;
    if (p.title) setTitle(p.title);
    if (p.objective) setObjective(p.objective);
    if (p.priority) setPriority(p.priority);
    setAppliedPlan(p);
    chat.dismissPlan();
  }

  function handleDismissPlan() {
    chat.dismissPlan();
  }

  const hasPlan = appliedPlan !== null || chat.latestPlan !== null;
  const activePlan = appliedPlan ?? chat.latestPlan;

  const footerContent = (
    <div className="flex items-center justify-between">
      <span className="text-[10px] text-text-muted">Ctrl+Enter to create</span>
      <div className="flex items-center gap-2">
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => handleCreate(false)}
          disabled={!title.trim()}
          className="px-4 py-1.5 text-xs bg-bg-elevated text-text-primary border border-bg-border rounded font-medium hover:bg-bg-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Create Flight
        </button>
        {hasPlan && (
          <button
            onClick={() => handleCreate(true)}
            disabled={!title.trim()}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs bg-accent-green/15 text-accent-green border border-accent-green/30 rounded font-medium hover:bg-accent-green/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Rocket size={11} />
            Create &amp; Launch
          </button>
        )}
      </div>
    </div>
  );

  return (
    <Modal
      onClose={onClose}
      title="New Mission"
      icon={<Target size={14} className="text-accent-green" />}
      width="w-[1060px] max-w-[92vw]"
      footer={footerContent}
    >
      <div className="flex flex-1 min-h-0" style={{ height: "min(600px, 72vh)" }}>
        {/* Left — AI Chat */}
        <div className="w-[460px] min-w-[320px] border-r border-bg-border flex flex-col">
          <FlightChatPanel
            messages={chat.messages}
            isLoading={chat.isLoading}
            streamingContent={chat.streamingContent}
            latestSuggestion={chat.latestSuggestion}
            latestPlan={chat.latestPlan}
            onSend={handleChatSend}
            onApplySuggestion={handleApplySuggestion}
            onDismissSuggestion={chat.dismissSuggestion}
            onApplyPlan={handleApplyPlan}
            onDismissPlan={handleDismissPlan}
          />
        </div>

        {/* Right — Form + Plan Preview */}
        <div className="flex-1 px-5 py-4 flex flex-col gap-4 overflow-y-auto" onKeyDown={handleKeyDown}>
          {/* Title */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-text-secondary">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What are you building?"
              className="w-full bg-bg-primary text-xs text-text-primary placeholder:text-text-muted px-3 py-2 rounded border border-bg-border outline-none focus:border-accent-green/50"
            />
          </div>

          {/* Objective */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-text-secondary">
              Objective <span className="text-text-muted font-normal">(optional)</span>
            </label>
            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="Describe the goal of this mission..."
              rows={4}
              className="w-full bg-bg-primary text-xs text-text-primary placeholder:text-text-muted px-3 py-2 rounded border border-bg-border outline-none focus:border-accent-green/50 resize-none"
            />
          </div>

          {/* Priority */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-text-secondary">Priority</label>
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

          {/* Plan Preview */}
          {activePlan && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <ListTree size={12} className="text-accent-green" />
                <label className="text-[11px] font-medium text-text-secondary">
                  Flight Plan
                </label>
                {appliedPlan && (
                  <span className="text-[9px] text-accent-green bg-accent-green/10 px-1.5 py-0.5 rounded">
                    Applied
                  </span>
                )}
              </div>
              <div className="bg-bg-primary border border-bg-border rounded p-3 space-y-2.5">
                {activePlan.milestones.map((ms, i) => (
                  <div key={i}>
                    <div className="text-[11px] font-medium text-text-primary">
                      {i + 1}. {ms.title}
                    </div>
                    {ms.description && (
                      <p className="text-[10px] text-text-muted mt-0.5">{ms.description}</p>
                    )}
                    <div className="mt-1 space-y-0.5 pl-3">
                      {ms.tasks.map((task, j) => (
                        <div key={j} className="flex items-center gap-2 text-[10px]">
                          <span className="w-1 h-1 rounded-full bg-text-muted flex-shrink-0" />
                          <span className="text-text-secondary">{task.title}</span>
                          <span className="text-text-muted px-1 py-0.5 bg-bg-elevated rounded text-[9px]">
                            {task.type}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
