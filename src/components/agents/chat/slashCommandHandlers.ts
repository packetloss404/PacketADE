import { generateId } from "@/lib/storage";
import { buildReviewPrompt } from "@/lib/conversationReview";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useGoalStore } from "@/stores/goalStore";
import { useFlightStore } from "@/stores/flightStore";
import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";
import type { AgentProfile } from "@/types/profiles";
import type { AppView } from "@/stores/appStore";

const HELP_CHEATSHEET =
  "**Keybinding cheatsheet**\n" +
  "\n" +
  "- Enter — send\n" +
  "- Shift+Enter — newline\n" +
  "- Tab — send as queued (delivered after the current turn finishes)\n" +
  "- Ctrl+Enter — also sends\n" +
  "- Shift+Tab — cycle mode (default → plan → manual → yolo)\n" +
  "- Alt+. / Alt+, — nudge model toward thorough / fast\n" +
  "- @ — mention a file\n" +
  "- / — run a slash command (try /usage, /history, /template)\n" +
  "- Stop button — cancels mid-stream";

export interface SlashCommandContext {
  conversationId: string;
  conversation: AgentConversation;
  setPlanMode: (id: string, on: boolean) => Promise<void> | void;
  createApiConversation: ReturnType<
    typeof useAgentTaskStore.getState
  >["createApiConversation"];
  selectConversation: (id: string) => void;
  setActiveView: (view: AppView) => void;
  reviewerProfile?: AgentProfile;
}

function appendMessage(conversationId: string, msg: AgentMessage) {
  useAgentTaskStore.setState((s) => ({
    conversations: s.conversations.map((c) =>
      c.id === conversationId
        ? { ...c, messages: [...c.messages, msg], updatedAt: Date.now() }
        : c,
    ),
  }));
}

function sysMessage(content: string): AgentMessage {
  return {
    id: generateId("msg"),
    role: "system",
    content,
    timestamp: Date.now(),
  };
}

export const slashCommandHandlers: Record<
  string,
  (ctx: SlashCommandContext) => void
> = {
  clear: ({ conversationId }) => {
    useAgentTaskStore.setState((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, messages: [], updatedAt: Date.now() }
          : c,
      ),
    }));
  },

  model: ({ conversationId }) => {
    setTimeout(() => {
      const btn = document.querySelector<HTMLButtonElement>(
        `[data-agent-pane-model-dropdown="${conversationId}"] button`,
      );
      btn?.click();
    }, 0);
  },

  help: ({ conversationId }) => {
    appendMessage(conversationId, sysMessage(HELP_CHEATSHEET));
  },

  new: ({ conversation, createApiConversation, selectConversation }) => {
    if (conversation.mode !== "api" || !conversation.model) return;
    const model = conversation.model;
    void (async () => {
      try {
        const newId = await createApiConversation(
          conversation.agent,
          conversation.projectPath,
          model,
          "",
          conversation.systemPromptOverride ?? null,
          undefined,
          undefined,
          null,
          undefined,
          false,
          conversation.allowedTools ?? null,
          conversation.memoryContextEnabled ?? false,
        );
        selectConversation(newId);
      } catch (e) {
        console.warn("Failed to start new conversation:", e);
      }
    })();
  },

  plan: ({ conversationId, conversation, setPlanMode }) => {
    void setPlanMode(conversationId, !conversation.planMode);
  },

  permissions: ({ conversationId }) => {
    setTimeout(() => {
      const sel = document.querySelector<HTMLSelectElement>(
        `[data-agent-pane-permissions-dropdown="${conversationId}"] select`,
      );
      sel?.focus();
    }, 0);
  },

  compact: ({ conversationId }) => {
    useAgentTaskStore.setState((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== conversationId) return c;
        const tail = c.messages.slice(-4);
        return {
          ...c,
          messages: [
            sysMessage(
              "(local transcript trimmed — provider/backend context was not compacted)",
            ),
            ...tail,
          ],
          updatedAt: Date.now(),
        };
      }),
    }));
  },

  usage: ({ setActiveView }) => {
    setActiveView("cost_dashboard");
  },

  history: ({ setActiveView }) => {
    setActiveView("history");
  },

  goal: ({ conversationId, conversation }) => {
    const existing = useGoalStore
      .getState()
      .getGoalForConversation(conversationId);
    if (existing) {
      appendMessage(
        conversationId,
        sysMessage(`(/goal — already bound to goal "${existing.title}")`),
      );
      return;
    }
    const title =
      (conversation.plan && conversation.plan[0]?.content) ||
      conversation.spec?.criteria[0] ||
      conversation.title ||
      "Untitled goal";
    const linkedFlight = useFlightStore
      .getState()
      .flights.find((f) => f.linkedSessionIds.includes(conversationId));
    useGoalStore.getState().addGoal({
      title,
      conversationId,
      missionId: linkedFlight?.id,
      checklist: conversation.plan ?? [],
      status: "active",
    });
    appendMessage(
      conversationId,
      sysMessage(
        `(/goal — created persistent goal "${title}"${linkedFlight ? ` bound to mission "${linkedFlight.title}"` : ""})`,
      ),
    );
  },

  review: ({
    conversationId,
    conversation,
    createApiConversation,
    selectConversation,
    reviewerProfile,
  }) => {
    if (conversation.mode !== "api" || !conversation.model) return;
    const model = conversation.model;
    void (async () => {
      try {
        const prompt = await buildReviewPrompt(conversation);
        if (!prompt) {
          appendMessage(
            conversationId,
            sysMessage(
              "(/review skipped — no pending write_file edits found in this conversation)",
            ),
          );
          return;
        }
        const newId = await createApiConversation(
          conversation.agent,
          conversation.projectPath,
          model,
          prompt,
          reviewerProfile?.systemPrompt ?? null,
          undefined,
          true, // planMode — reviewer is read-only
          null,
          undefined,
          false,
          reviewerProfile?.allowedTools ?? null,
          false,
        );
        selectConversation(newId);
      } catch (e) {
        console.warn("/review failed:", e);
      }
    })();
  },
};
