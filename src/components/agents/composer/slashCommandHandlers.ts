import { generateId } from "@/lib/storage";
import { buildReviewPrompt } from "@/lib/conversationReview";
import {
  requestConversationSave,
  useAgentTaskStore,
} from "@/stores/agentTaskStore";
import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";
import type { AgentProfile } from "@/types/profiles";
import type { AppView } from "@/stores/appStore";
import {
  requestOpenModeChipPopover,
  requestOpenModelDropdown,
} from "../paneEvents";

const HELP_CHEATSHEET =
  "**Keybinding cheatsheet**\n" +
  "\n" +
  "- Enter — send\n" +
  "- Shift+Enter — newline\n" +
  "- Ctrl+Enter — also sends\n" +
  "- Shift+Tab — cycle mode (default → plan → manual → deny → yolo)\n" +
  "- @ — mention a file\n" +
  "- / — run a slash command (try /usage, /history, /review)\n" +
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
  requestConversationSave(conversationId);
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
    requestConversationSave(conversationId);
  },

  model: ({ conversationId }) => {
    requestOpenModelDropdown(conversationId);
  },

  help: ({ conversationId }) => {
    appendMessage(conversationId, sysMessage(HELP_CHEATSHEET));
  },

  new: ({ conversation, createApiConversation, selectConversation }) => {
    if (conversation.mode !== "api" || !conversation.model) return;
    const model = conversation.model;
    void (async () => {
      try {
        const newId = await createApiConversation({
          agent: conversation.agent,
          projectPath: conversation.projectPath,
          model,
          initialMessage: "",
          // M1(b): DO NOT inherit the old conversation's baked
          // `systemPromptOverride`. That field stores the fully assembled
          // prompt — memory brief + AGENTS.md already prepended at the old
          // session's creation (see agentTaskStore.createApiConversation). If we
          // passed it back in while also inheriting `memoryContextEnabled`,
          // createApiConversation would prepend a SECOND brief, and it prepends
          // AGENTS.md unconditionally (not gated on the flag), so a second
          // AGENTS.md block too. Passing null lets createApiConversation rebuild
          // exactly ONE brief (from the inherited flag) and ONE AGENTS.md for
          // the fresh session. The profile's own prompt is not separately
          // retained on the conversation, so it isn't re-applied here.
          systemPromptOverride: null,
          planMode: conversation.planMode ?? false,
          sshTarget: null,
          skipBackendStart: false,
          allowedTools: conversation.allowedTools ?? null,
          memoryContextEnabled: conversation.memoryContextEnabled ?? false,
          attachments: null,
          enabledMcpServerIds: conversation.enabledMcpServerIds ?? null,
          permissionMode: conversation.permissionMode,
          approveWrites: conversation.approveWrites,
        });
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
    requestOpenModeChipPopover(conversationId);
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
    requestConversationSave(conversationId);
  },

  usage: ({ setActiveView }) => {
    setActiveView("cost_dashboard");
  },

  history: ({ setActiveView }) => {
    setActiveView("history");
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
        const newId = await createApiConversation({
          agent: conversation.agent,
          projectPath: conversation.projectPath,
          model,
          initialMessage: prompt,
          systemPromptOverride: reviewerProfile?.systemPrompt ?? null,
          planMode: true, // reviewer is read-only
          sshTarget: null,
          skipBackendStart: false,
          allowedTools: reviewerProfile?.allowedTools ?? null,
          memoryContextEnabled: false,
        });
        selectConversation(newId);
      } catch (e) {
        console.warn("/review failed:", e);
      }
    })();
  },
};
