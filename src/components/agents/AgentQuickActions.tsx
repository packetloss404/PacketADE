import { MessageSquare, Undo2, ArrowRight } from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import type { AgentMessage } from "@/types/agent-conversation";

interface AgentQuickActionsProps {
  conversationId: string;
  message: AgentMessage;
}

const QUICK_ACTIONS = [
  { label: "Continue", prompt: "continue", icon: ArrowRight },
  { label: "Explain", prompt: "explain that in more detail", icon: MessageSquare },
  { label: "Undo", prompt: "undo the last change", icon: Undo2 },
] as const;

export function AgentQuickActions({ conversationId }: AgentQuickActionsProps) {
  const sendMessage = useAgentTaskStore((s) => s.sendMessage);

  function handleAction(prompt: string) {
    sendMessage(conversationId, prompt);
  }

  return (
    <div className="flex items-center gap-1.5 mt-1">
      {QUICK_ACTIONS.map((action) => {
        const Icon = action.icon;
        return (
          <button
            key={action.label}
            onClick={() => handleAction(action.prompt)}
            className="flex items-center gap-1 rounded bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-secondary transition-colors hover:bg-bg-border hover:text-text-primary"
            title={action.prompt}
          >
            <Icon size={10} />
            <span className="text-[11px]">{action.label}</span>
          </button>
        );
      })}
    </div>
  );
}
