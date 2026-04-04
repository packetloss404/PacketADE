import { useState } from "react";
import { Target } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useFlightStore } from "@/stores/flightStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useFlightChat } from "@/hooks/useFlightChat";
import { FlightChatPanel } from "@/components/flights/FlightChatPanel";
import type { FlightPriority } from "@/types/flight";

const ALL_PRIORITIES: FlightPriority[] = ["low", "medium", "high", "critical"];

interface NewFlightModalProps {
  onClose: () => void;
  onCreated?: (id: string) => void;
}

export function NewFlightModal({ onClose, onCreated }: NewFlightModalProps) {
  const addFlight = useFlightStore((s) => s.addFlight);
  const projectPath = useLayoutStore((s) => s.projectPath);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [priority, setPriority] = useState<FlightPriority>("medium");

  const chat = useFlightChat();

  function handleCreate() {
    if (!title.trim()) return;
    const f = addFlight({
      title: title.trim(),
      objective: objective.trim(),
      priority,
      projectPath: projectPath || "",
      issueIds: [],
    });
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
    chat.sendMessage(content, { title, objective, priority });
  }

  function handleApplySuggestion() {
    if (!chat.latestSuggestion) return;
    const s = chat.latestSuggestion;
    if (s.title !== undefined) setTitle(s.title);
    if (s.objective !== undefined) setObjective(s.objective);
    if (s.priority !== undefined) setPriority(s.priority);
    chat.dismissSuggestion();
  }

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
          onClick={handleCreate}
          disabled={!title.trim()}
          className="px-4 py-1.5 text-xs bg-accent-green/15 text-accent-green border border-accent-green/30 rounded font-medium hover:bg-accent-green/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Create Flight
        </button>
      </div>
    </div>
  );

  return (
    <Modal
      onClose={onClose}
      title="New Flight"
      icon={<Target size={14} className="text-accent-green" />}
      width="w-[780px] max-w-[95vw]"
      footer={footerContent}
    >
      <div className="flex flex-1 min-h-0" style={{ height: "min(420px, 60vh)" }}>
        {/* Left — AI Chat */}
        <div className="w-[360px] min-w-[280px] border-r border-bg-border flex flex-col">
          <FlightChatPanel
            messages={chat.messages}
            isLoading={chat.isLoading}
            streamingContent={chat.streamingContent}
            latestSuggestion={chat.latestSuggestion}
            onSend={handleChatSend}
            onApplySuggestion={handleApplySuggestion}
            onDismissSuggestion={chat.dismissSuggestion}
          />
        </div>

        {/* Right — Form */}
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
              placeholder="Describe the goal of this flight..."
              rows={6}
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
        </div>
      </div>
    </Modal>
  );
}
