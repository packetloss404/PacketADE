import { useAgentTaskStore } from "@/stores/agentTaskStore";
import type { AgentConversation } from "@/types/agent-conversation";

/** Export the conversation as Markdown and trigger a browser download. */
export async function handleExport(conversation: AgentConversation) {
  try {
    const md = await useAgentTaskStore
      .getState()
      .exportConversation(conversation.id);
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(conversation.title || "conversation").replace(/[^a-z0-9-_ ]/gi, "_")}.md`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.warn("Export failed:", err);
  }
}
