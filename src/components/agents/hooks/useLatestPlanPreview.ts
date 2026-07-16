import { useEffect, useMemo, useRef } from "react";
import { looksLikePlan } from "../planDetection";
import type { AgentConversation } from "@/types/agent-conversation";

/**
 * When plan mode is active and the agent has emitted a plan-shaped assistant
 * message, push it into the shared preview pane exactly once per message id.
 */
export function useLatestPlanPreview(
  conversation: AgentConversation | undefined,
  openPlanPreview: (content: string, title: string) => void,
) {
  const lastPreviewedPlanRef = useRef<string | null>(null);

  const planMode = conversation?.planMode ?? false;
  const messages = conversation?.messages;
  const latestPlanMessage = useMemo(() => {
    if (!planMode || !messages) return null;
    return (
      [...messages]
        .reverse()
        .find(
          (msg) =>
            msg.role === "assistant" &&
            !msg.isStreaming &&
            looksLikePlan(msg.content),
        ) ?? null
    );
  }, [messages, planMode]);

  useEffect(() => {
    if (!latestPlanMessage) return;
    if (lastPreviewedPlanRef.current === latestPlanMessage.id) return;
    lastPreviewedPlanRef.current = latestPlanMessage.id;
    openPlanPreview(latestPlanMessage.content, "Agent plan");
  }, [latestPlanMessage, openPlanPreview]);

  return latestPlanMessage;
}
