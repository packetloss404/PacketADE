import { Plane } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { linkConversationToFlight } from "@/lib/agentHandoffs";
import { useFlightStore } from "@/stores/flightStore";
import type { AgentConversation } from "@/types/agent-conversation";

interface AddConversationToFlightModalProps {
  conversation: AgentConversation;
  onClose: () => void;
  onFeedback: (message: string) => void;
}

export function AddConversationToFlightModal({
  conversation,
  onClose,
  onFeedback,
}: AddConversationToFlightModalProps) {
  const flights = useFlightStore((state) =>
    state.flights.filter(
      (flight) =>
        flight.status !== "done" &&
        flight.status !== "cancelled" &&
        flight.status !== "failed",
    ),
  );

  function handleLink(flightId: string) {
    const result = linkConversationToFlight(conversation.id, flightId, {
      openFlight: true,
    });
    if (!result.ok) {
      onFeedback(result.message);
      return;
    }
    onFeedback(
      result.alreadyLinked
        ? "Opened the already-linked Flight"
        : "Conversation linked to Flight",
    );
    onClose();
  }

  return (
    <Modal
      title="Add agent conversation to Flight"
      icon={<Plane size={15} className="text-accent-blue" />}
      onClose={onClose}
      closeOnEscape
      width="w-[520px]"
    >
      <div className="space-y-2 p-5">
        <div className="mb-3 text-ui text-text-secondary">
          Flight Deck receives a reference to{" "}
          <span className="font-medium text-text-primary">{conversation.title}</span>.
          The conversation ID, transcript, approvals, review, and worktree remain
          authoritative in Agents.
        </div>
        {flights.length === 0 ? (
          <div className="rounded border border-bg-border bg-bg-primary px-3 py-4 text-center text-ui text-text-muted">
            No active Flights are available. Create one in Flight Deck first.
          </div>
        ) : (
          flights.map((flight) => {
            const linked = flight.linkedSessionIds.includes(conversation.id);
            return (
              <button
                key={flight.id}
                type="button"
                onClick={() => handleLink(flight.id)}
                className="flex w-full items-center gap-3 rounded border border-bg-border bg-bg-primary px-3 py-2.5 text-left transition-colors hover:border-accent-blue/40 hover:bg-bg-hover"
              >
                <Plane size={13} className="shrink-0 text-accent-blue" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium text-text-primary">
                    {flight.title || "Untitled Flight"}
                  </span>
                  <span className="block truncate text-meta text-text-muted">
                    {flight.projectPath}
                  </span>
                </span>
                <span
                  className={
                    linked ? "text-meta text-accent-green" : "text-meta text-text-muted"
                  }
                >
                  {linked ? "Linked · Open" : "Link & open"}
                </span>
              </button>
            );
          })
        )}
      </div>
    </Modal>
  );
}
