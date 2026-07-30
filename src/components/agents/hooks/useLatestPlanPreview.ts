import { useEffect, useMemo, useRef } from "react";
import { looksLikePlan } from "../planDetection";
import { openPlanPreview } from "@/lib/previewDock";
import type { AgentConversation } from "@/types/agent-conversation";

/**
 * When plan mode is active and the agent has emitted a plan-shaped assistant
 * message, push it into the preview dock exactly once per message id.
 *
 * P0-3: the target is stamped with `conversationId`, so a plan detected for
 * conversation A can never be resolved against conversation B's project.
 */
export function useLatestPlanPreview(
  conversation: AgentConversation | undefined,
  conversationId: string,
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
    openPlanPreview(conversationId, latestPlanMessage.content, "Agent plan");
  }, [latestPlanMessage, conversationId]);

  return latestPlanMessage;
}
