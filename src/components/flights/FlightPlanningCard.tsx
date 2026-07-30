import { useMemo, useState } from "react";
import { CheckCircle2, MessageSquareText, Route } from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useFlightStore } from "@/stores/flightStore";
import { openConversationInAgents } from "@/stores/sessionGlue";
import { materializeFlightPlan, parseLatestFlightPlan } from "@/lib/flightPlanning";
import type { Flight } from "@/types/flight";

export function FlightPlanningCard({ flight }: { flight: Flight }) {
  const updateFlight = useFlightStore((state) => state.updateFlight);
  const appendCoordinationEvent = useFlightStore((state) => state.appendCoordinationEvent);
  const conversation = useAgentTaskStore((state) =>
    flight.planningConversationId
      ? state.conversations.find((item) => item.id === flight.planningConversationId)
      : undefined,
  );
  const [feedback, setFeedback] = useState<string | null>(null);

  const planSummary = useMemo(() => {
    if (flight.milestones.length === 0) return "No plan applied yet";
    const taskCount = flight.milestones.reduce((sum, milestone) => sum + milestone.tasks.length, 0);
    return `${flight.milestones.length} milestone${flight.milestones.length === 1 ? "" : "s"} · ${taskCount} task${taskCount === 1 ? "" : "s"}`;
  }, [flight.milestones]);

  if (!flight.planningConversationId) return null;

  function openConversation() {
    if (!conversation) {
      setFeedback("The linked planning conversation is not available on this device.");
      return;
    }
    openConversationInAgents(conversation.id);
  }

  function applyLatestPlan() {
    if (!conversation) {
      setFeedback("The linked planning conversation is not available on this device.");
      return;
    }
    try {
      const parsed = parseLatestFlightPlan(conversation.messages);
      const plan = materializeFlightPlan(flight.id, parsed);
      updateFlight(flight.id, {
        title: plan.title ?? flight.title,
        objective: plan.objective ?? flight.objective,
        milestones: plan.milestones,
        status: "ready",
      });
      appendCoordinationEvent(flight.id, {
        type: "handoff",
        summary: `Applied conversation-backed plan: ${plan.milestones.length} milestone${plan.milestones.length === 1 ? "" : "s"}, ${plan.taskCount} task${plan.taskCount === 1 ? "" : "s"}.`,
        metadata: { source: "planning_conversation", conversationId: conversation.id },
      });
      setFeedback("Latest structured plan applied to the Flight.");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="border-accent-purple/25 bg-accent-purple/5 flex flex-col gap-2 rounded border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Route size={13} className="text-accent-purple" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold text-text-primary">Upfront plan</div>
          <div className="text-[10px] text-text-muted">
            {planSummary} · refined in a normal read-only agent conversation
          </div>
        </div>
        <button
          type="button"
          onClick={openConversation}
          className="flex items-center gap-1 rounded border border-bg-border px-2 py-1 text-[10px] text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
        >
          <MessageSquareText size={10} />
          Open conversation
        </button>
        <button
          type="button"
          onClick={applyLatestPlan}
          disabled={!conversation}
          className="bg-accent-purple/10 border-accent-purple/30 hover:bg-accent-purple/20 flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium text-accent-purple transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        >
          <CheckCircle2 size={10} />
          {flight.milestones.length > 0 ? "Replace with latest" : "Apply latest plan"}
        </button>
      </div>
      {feedback && (
        <div className="text-[10px] leading-relaxed text-text-secondary">{feedback}</div>
      )}
    </div>
  );
}
