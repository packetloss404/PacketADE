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

/** Export the conversation as a JSON file and trigger a browser download.
 * Uses the same Blob + object-URL save path as the Markdown export. */
export function exportConversationJson(conversation: AgentConversation) {
  try {
    const payload = {
      id: conversation.id,
      title: conversation.title,
      agent: conversation.agent,
      provider: conversation.provider ?? null,
      model: conversation.model ?? null,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messages: conversation.messages,
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(conversation.title || "conversation").replace(/[^a-z0-9-_ ]/gi, "_")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.warn("JSON export failed:", err);
  }
}

/** Copy the conversation's Markdown transcript to the clipboard.
 * Resolves to true on success, false on failure. */
export async function copyTranscriptToClipboard(
  conversation: AgentConversation,
): Promise<boolean> {
  try {
    const md = await useAgentTaskStore
      .getState()
      .exportConversation(conversation.id);
    await navigator.clipboard.writeText(md);
    return true;
  } catch (err) {
    console.warn("Copy transcript failed:", err);
    return false;
  }
}
