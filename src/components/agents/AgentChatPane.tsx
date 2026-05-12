import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  X,
  Loader2,
  CheckCircle,
  XCircle,
  Send,
  Square,
  Mic,
  ChevronDown,
  ChevronRight,
  Compass,
  FileCheck2,
  RotateCw,
  RotateCcw,
  Download,
  MoreVertical,
  Server,
  PanelRightOpen,
  Columns2,
  Sparkles,
} from "lucide-react";
import { PermissionPrompt } from "./PermissionPrompt";
import { PendingEditPrompt } from "./PendingEditPrompt";
import { PendingApprovalsRollup } from "./PendingApprovalsRollup";
import { ThinkingBlock } from "./ThinkingBlock";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { AgentQuickActions } from "./AgentQuickActions";
import { MentionSourcePicker } from "./MentionSourcePicker";
import {
  SlashCommandPopover,
  type SlashSelection,
} from "./SlashCommandPopover";
import {
  BUILTIN_SLASH_NAMES,
  TEMPLATE_SOURCE_TAG,
} from "./slashCommandConstants";
import type { SlashCommandDef, SkillDef } from "@/lib/tauri";
import { listSlashCommands, listSkills } from "@/lib/tauri";
import { ToolDiffView } from "./ToolDiffView";
import { MemoryInjectionCard } from "./MemoryInjectionCard";
import { BashToolCallCard } from "./BashToolCallCard";
import { CheckpointPanel } from "./CheckpointPanel";
import { PlanModeApprovalMenu } from "./PlanModeApprovalMenu";
import { looksLikePlan } from "./planDetection";
import { DiffPaneTrigger } from "./DiffPaneTrigger";
import { MultiFileEditCard } from "./MultiFileEditCard";
import { ExplorationRollupCard } from "./ExplorationRollupCard";
import { AgentStatusBar } from "./AgentStatusBar";
import { SubagentToolCallCard } from "./SubagentToolCallCard";
import { TaskListCard } from "./TaskListCard";
import { ContinueInMenu } from "./ContinueInMenu";
import { AgentMosaicShell } from "./AgentMosaicShell";
import { AgentTabbedRail } from "./AgentTabbedRail";
import { storageKey } from "@/lib/brand";
import { AgentHeaderBadges } from "./AgentHeaderBadges";
import { SessionHealthBar } from "./SessionHealthBar";
import { PlanPanel } from "./PlanPanel";
import { SpecPanel } from "./SpecPanel";
import { AgentModeChip } from "./AgentModeChip";
import {
  deriveMode,
  flagsForMode,
  nextMode,
} from "./agentModeChipUtils";
import { AgentPaneSplitMenu } from "./AgentPaneSplitMenu";
import { EmbeddedDiffPane } from "./EmbeddedDiffPane";
import { AgentFilePane } from "./AgentFilePane";
import { AgentPreviewPane } from "./AgentPreviewPane";
import { TerminalPane } from "@/components/session/TerminalPane";
import { ClickablePathsRoot } from "@/components/common/wrapClickablePaths";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { API_PROVIDERS, getModelSpeed } from "@/lib/api-models";
import { calculateTurnCost } from "@/lib/tauri";
import { aggregateConversationDiffs } from "@/lib/aggregateConversationDiffs";
import { generateId } from "@/lib/storage";
import { usePreviewPaneStore } from "@/stores/previewPaneStore";
import { usePromptStore } from "@/stores/promptStore";
import { useAppStore } from "@/stores/appStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { useProfileStore } from "@/stores/profileStore";
import { useGoalStore } from "@/stores/goalStore";
import { useFlightStore } from "@/stores/flightStore";
import { buildReviewPrompt } from "@/lib/conversationReview";
import type {
  AgentConversation,
  AgentMessage,
  AgentToolCall,
} from "@/types/agent-conversation";

const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
};

const AGENT_DOT_COLORS: Record<string, string> = {
  "claude-code": "bg-accent-amber",
  codex: "bg-accent-blue",
  gemini: "bg-accent-purple",
  opencode: "bg-accent-green",
};

const STATUS_DISPLAY: Record<string, { label: string; className: string }> = {
  active: { label: "Active", className: "text-accent-green" },
  idle: { label: "Idle", className: "text-text-muted" },
  done: { label: "Done", className: "text-accent-blue" },
  failed: { label: "Failed", className: "text-accent-red" },
};

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

interface AgentChatPaneProps {
  conversationId: string;
  onClose: () => void;
}

/**
 * B8 — small "← back to plan" link shown in the chat header when this
 * conversation was spawned by a Codex handoff. Resolves the parent name
 * lazily from the store; renders nothing if the parent has been deleted
 * (cleanup is automatic — no dangling link).
 */
function BackToParentLink({ parentId }: { parentId: string }) {
  const parent = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === parentId),
  );
  const selectConversation = useAgentTaskStore((s) => s.selectConversation);
  if (!parent) return null;
  return (
    <button
      type="button"
      onClick={() => selectConversation(parentId)}
      title={`Spawned via "Hand off to Codex" from "${parent.title}"`}
      className="flex items-center gap-1 text-[10px] text-text-muted hover:text-accent-blue bg-bg-secondary border border-bg-border rounded px-1.5 py-0.5 transition-colors"
    >
      ← back to plan
    </button>
  );
}

type MentionState =
  | { kind: "none" }
  | {
      kind: "file";
      query: string;
      /** Index of the `@` in the textarea (zero-based). */
      triggerIndex: number;
      highlightedIndex: number;
    }
  | {
      kind: "slash";
      query: string;
      /** Index of the `/` in the textarea (zero-based). */
      triggerIndex: number;
      highlightedIndex: number;
    };

/**
 * Scan backward from `cursor` in `text` for a trigger char (`@` or `/`).
 * Returns the trigger position and query string if valid, else null.
 *
 * Valid trigger: char at start-of-string, or preceded by whitespace, and no
 * whitespace between trigger and cursor.
 */
function findTrigger(
  text: string,
  cursor: number,
  triggerChar: string,
): { triggerIndex: number; query: string } | null {
  // Walk backward from cursor looking for the trigger; fail if we hit whitespace first.
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === triggerChar) {
      // Ensure start-of-input or whitespace before trigger.
      if (i === 0 || /\s/.test(text[i - 1])) {
        return { triggerIndex: i, query: text.slice(i + 1, cursor) };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

export function AgentChatPane({ conversationId, onClose }: AgentChatPaneProps) {
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const sendMessage = useAgentTaskStore((s) => s.sendMessage);
  const cancelActiveConversation = useAgentTaskStore(
    (s) => s.cancelActiveConversation,
  );
  const changeModel = useAgentTaskStore((s) => s.changeModel);
  const createApiConversation = useAgentTaskStore(
    (s) => s.createApiConversation,
  );
  const selectConversation = useAgentTaskStore((s) => s.selectConversation);
  const setPlanMode = useAgentTaskStore((s) => s.setPlanMode);
  const setPermissionMode = useAgentTaskStore((s) => s.setPermissionMode);
  const setApproveWrites = useAgentTaskStore((s) => s.setApproveWrites);
  const respondPermission = useAgentTaskStore((s) => s.respondPermission);
  const respondEdit = useAgentTaskStore((s) => s.respondEdit);
  const cancelPendingTools = useAgentTaskStore((s) => s.cancelPendingTools);
  const appendAllowedToolPattern = useAgentTaskStore(
    (s) => s.appendAllowedToolPattern,
  );
  const removeDiffComment = useAgentTaskStore((s) => s.removeDiffComment);
  const clearDiffComments = useAgentTaskStore((s) => s.clearDiffComments);
  const retryLastTurn = useAgentTaskStore((s) => s.retryLastTurn);
  const exportConversation = useAgentTaskStore((s) => s.exportConversation);
  const previewOpen = usePreviewPaneStore((s) => s.open);
  const togglePreview = usePreviewPaneStore((s) => s.toggle);
  // B4 — compact tabbed rail toggle (Plan / Diff / Inspector in one
  // 340px column). Persisted in localStorage; off by default.
  const [useCompactRail, setUseCompactRail] = useState<boolean>(() => {
    if (typeof localStorage === "undefined") return false;
    try {
      return localStorage.getItem(storageKey("agent-tabbed-rail-mode")) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(
        storageKey("agent-tabbed-rail-mode"),
        useCompactRail ? "1" : "0",
      );
    } catch {
      // ignore
    }
  }, [useCompactRail]);
  const openMarkdownPreview = usePreviewPaneStore((s) => s.openMarkdown);
  const openPlanPreview = usePreviewPaneStore((s) => s.openPlan);
  const promptTemplates = usePromptStore((s) => s.templates);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const memoryGetContext = useMemoryStore((s) => s.getContextForSession);
  const reviewerProfile = useProfileStore((s) =>
    s.profiles.find((p) => p.id === "builtin-reviewer"),
  );

  const [input, setInput] = useState("");
  const [mentionState, setMentionState] = useState<MentionState>({ kind: "none" });
  const [customSlashCommands, setCustomSlashCommands] = useState<SlashCommandDef[]>([]);
  const [userSkills, setUserSkills] = useState<SkillDef[]>([]);
  const [showRewind, setShowRewind] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const lastPreviewedPlanRef = useRef<string | null>(null);

  const {
    isListening,
    transcript,
    startListening,
    stopListening,
    isSupported: voiceSupported,
  } = useVoiceInput();
  const prevTranscriptRef = useRef("");

  // Append voice transcript to input
  useEffect(() => {
    if (transcript && transcript !== prevTranscriptRef.current) {
      prevTranscriptRef.current = transcript;
      setInput((prev) => prev + transcript);
    }
  }, [transcript]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation?.messages]);

  // Auto-resize textarea
  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

  const latestPlanMessage = useMemo(() => {
    if (!conversation?.planMode) return null;
    return [...conversation.messages]
      .reverse()
      .find(
        (msg) =>
          msg.role === "assistant" &&
          !msg.isStreaming &&
          looksLikePlan(msg.content),
      ) ?? null;
  }, [conversation?.messages, conversation?.planMode]);

  useEffect(() => {
    if (!latestPlanMessage) return;
    if (lastPreviewedPlanRef.current === latestPlanMessage.id) return;
    lastPreviewedPlanRef.current = latestPlanMessage.id;
    openPlanPreview(latestPlanMessage.content, "Agent plan");
  }, [latestPlanMessage, openPlanPreview]);

  // Load user-defined slash commands from project + global dirs.
  const projectPathForSlash = conversation?.projectPath ?? "";
  useEffect(() => {
    if (!projectPathForSlash) return;
    let cancelled = false;
    listSlashCommands(projectPathForSlash)
      .then((cmds) => {
        if (!cancelled) setCustomSlashCommands(cmds);
      })
      .catch(() => {});
    listSkills(projectPathForSlash)
      .then((skills) => {
        if (!cancelled) setUserSkills(skills);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectPathForSlash]);

  // Aggregate `+adds / -dels` totals for the DiffPaneTrigger chip. Recompute
  // whenever the conversation gets new messages (cheap proxy for "new
  // tool_calls have arrived").
  const diffMessageCount = conversation?.messages.length ?? 0;
  const [diffTotals, setDiffTotals] = useState<{
    fileCount: number;
    totalAdds: number;
    totalDels: number;
  }>({ fileCount: 0, totalAdds: 0, totalDels: 0 });
  useEffect(() => {
    if (!conversation || conversation.mode !== "api") {
      setDiffTotals({ fileCount: 0, totalAdds: 0, totalDels: 0 });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await aggregateConversationDiffs(conversation);
        if (cancelled) return;
        setDiffTotals({
          fileCount: result.fileCount,
          totalAdds: result.totalAdds,
          totalDels: result.totalDels,
        });
      } catch {
        if (!cancelled) {
          setDiffTotals({ fileCount: 0, totalAdds: 0, totalDels: 0 });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Key on conversation identity, mode, and message count so streaming
    // tool-call arrivals refresh totals without firing on unrelated renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, conversation?.mode, diffMessageCount]);

  // Synthesize a SlashCommandDef per saved prompt template so they appear in
  // the popover alongside file-loaded custom commands. Slugified name becomes
  // the slash-command identifier, e.g. "Code Review" -> "/code-review".
  const templateSlashCommands = useMemo<SlashCommandDef[]>(
    () =>
      promptTemplates.map((t) => ({
        name: t.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, ""),
        description: t.name,
        body: t.content,
        source: TEMPLATE_SOURCE_TAG,
      })),
    [promptTemplates],
  );

  // Project/global slash commands plus the synthesized template commands. The
  // popover treats them uniformly; the icon differs by `source` tag so users
  // can tell templates apart at a glance.
  const allCustomSlashCommands = useMemo<SlashCommandDef[]>(
    () => [...customSlashCommands, ...templateSlashCommands],
    [customSlashCommands, templateSlashCommands],
  );

  // NOTE: hooks must run in the same order every render — compute popover
  // item count before any early return.
  const popoverItemCount = useMemo(() => {
    if (mentionState.kind === "slash") {
      const q = mentionState.query.toLowerCase();
      const builtins = BUILTIN_SLASH_NAMES.filter((c) =>
        c.startsWith(q),
      ).length;
      const custom = allCustomSlashCommands.filter((c) =>
        c.name.toLowerCase().startsWith(q),
      ).length;
      const skills = userSkills.filter(
        (s) => s.userInvocable && s.name.toLowerCase().startsWith(q),
      ).length;
      return builtins + custom + skills;
    }
    return 0;
  }, [mentionState, allCustomSlashCommands, userSkills]);

  if (!conversation) {
    return (
      <div className="flex flex-col h-full bg-bg-primary items-center justify-center">
        <span className="text-[11px] text-text-muted">
          Conversation not found
        </span>
      </div>
    );
  }

  const status = STATUS_DISPLAY[conversation.status] ?? STATUS_DISPLAY.idle;
  const agentLabel = AGENT_LABELS[conversation.agent] ?? conversation.agent;
  const dotColor = AGENT_DOT_COLORS[conversation.agent] ?? "bg-text-muted";
  const folderName =
    conversation.projectPath
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .pop() ?? conversation.projectPath;

  const isActive = conversation.status === "active";
  const isIdle = conversation.status === "idle";
  // "running" in the UI sense = actively streaming / waiting for the agent.
  // Store status for API mode is "active" during a streaming turn.
  const isRunning = isActive;
  const messages = conversation.messages;
  const lastMessage = messages[messages.length - 1];
  const lastAssistantMessage = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");
  const showThinking =
    isActive &&
    (!lastMessage || lastMessage.role === "user") &&
    messages.length > 0;

  // Tooltip shown on the header status line.
  const userMsgCount = messages.filter((m) => m.role === "user").length;
  const assistantMsgCount = messages.filter((m) => m.role === "assistant").length;

  // Show quick actions only on the last assistant message when idle
  const showQuickActions = isIdle && lastAssistantMessage !== undefined;

  // Model switcher data
  const providerInfo = API_PROVIDERS.find(
    (p) => p.agentCli === conversation.agent,
  );
  const currentModelValue = conversation.model ?? "";
  const currentModelLabel =
    providerInfo?.models.find((m) => m.value === currentModelValue)?.label ??
    currentModelValue ??
    "Model";

  /* ----------------- popover / input handling ----------------- */

  function updateMentionStateFromInput(text: string, cursor: number) {
    const fileHit = findTrigger(text, cursor, "@");
    if (fileHit) {
      setMentionState({
        kind: "file",
        query: fileHit.query,
        triggerIndex: fileHit.triggerIndex,
        highlightedIndex: 0,
      });
      return;
    }
    const slashHit = findTrigger(text, cursor, "/");
    if (slashHit) {
      setMentionState({
        kind: "slash",
        query: slashHit.query,
        triggerIndex: slashHit.triggerIndex,
        highlightedIndex: 0,
      });
      return;
    }
    setMentionState({ kind: "none" });
  }

  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const text = e.target.value;
    setInput(text);
    const cursor = e.target.selectionStart ?? text.length;
    updateMentionStateFromInput(text, cursor);
  }

  function handleSelectionChange() {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart ?? ta.value.length;
    updateMentionStateFromInput(ta.value, cursor);
  }

  function selectFileMention(insertion: string) {
    if (mentionState.kind !== "file") return;
    const before = input.slice(0, mentionState.triggerIndex);
    // Replace "@query" with the picker's already-formatted insertion (starts with "@")
    const afterStart = mentionState.triggerIndex + 1 + mentionState.query.length;
    const after = input.slice(afterStart);
    const next = `${before}${insertion} ${after}`;
    setInput(next);
    setMentionState({ kind: "none" });
    // Re-focus textarea and place cursor after the inserted text
    setTimeout(() => {
      const ta = textareaRef.current;
      if (ta) {
        const pos = before.length + insertion.length + 1;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    }, 0);
  }

  function runSlashCommand(sel: SlashSelection) {
    if (mentionState.kind !== "slash") return;
    const before = input.slice(0, mentionState.triggerIndex);
    // Drop the entire "/query" from input.
    const afterStart =
      mentionState.triggerIndex + 1 + mentionState.query.length;
    const after = input.slice(afterStart);
    const remaining = (before + after).trim();

    if (sel.kind === "custom") {
      // Send the custom command's body as a new user message.
      setInput(remaining);
      setMentionState({ kind: "none" });
      sendMessage(conversationId, sel.def.body);
      return;
    }

    if (sel.kind === "skill") {
      // Send the skill's SKILL.md body as a new user message.
      setInput(remaining);
      setMentionState({ kind: "none" });
      sendMessage(conversationId, sel.def.body);
      return;
    }

    const cmd = sel.name;

    if (cmd === "clear") {
      // Reset conversation messages inline via setState (store action not available).
      useAgentTaskStore.setState((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === conversationId
            ? { ...c, messages: [], updatedAt: Date.now() }
            : c,
        ),
      }));
      setInput(remaining);
      setMentionState({ kind: "none" });
      return;
    }

    if (cmd === "model") {
      // Open the model dropdown by clicking its trigger.
      setInput(remaining);
      setMentionState({ kind: "none" });
      setTimeout(() => {
        const btn = document.querySelector<HTMLButtonElement>(
          `[data-agent-pane-model-dropdown="${conversationId}"] button`,
        );
        btn?.click();
      }, 0);
      return;
    }

    if (cmd === "help") {
      // Insert a system-style message with the cheatsheet into the conversation.
      const helpMsg: AgentMessage = {
        id: generateId("msg"),
        role: "system",
        content: HELP_CHEATSHEET,
        timestamp: Date.now(),
      };
      useAgentTaskStore.setState((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                messages: [...c.messages, helpMsg],
                updatedAt: Date.now(),
              }
            : c,
        ),
      }));
      setInput(remaining);
      setMentionState({ kind: "none" });
      return;
    }

    if (cmd === "new") {
      // Start a new API conversation using same agent/path/model as this one.
      setInput(remaining);
      setMentionState({ kind: "none" });
      const conv = conversation;
      if (!conv || conv.mode !== "api" || !conv.model) return;
      const model = conv.model;
      void (async () => {
        try {
          const newId = await createApiConversation(
            conv.agent,
            conv.projectPath,
            model,
            "",
            conv.systemPromptOverride ?? null,
            undefined,
            undefined,
            null,
            undefined,
            false,
            conv.allowedTools ?? null,
            conv.memoryContextEnabled ?? false,
          );
          selectConversation(newId);
        } catch (e) {
          console.warn("Failed to start new conversation:", e);
        }
      })();
      return;
    }

    if (cmd === "plan") {
      setInput(remaining);
      setMentionState({ kind: "none" });
      void setPlanMode(conversationId, !conversation?.planMode);
      return;
    }

    if (cmd === "permissions") {
      // Focus the permission-mode <select> so the user can arrow-key through.
      setInput(remaining);
      setMentionState({ kind: "none" });
      setTimeout(() => {
        const sel = document.querySelector<HTMLSelectElement>(
          `[data-agent-pane-permissions-dropdown="${conversationId}"] select`,
        );
        sel?.focus();
      }, 0);
      return;
    }

    if (cmd === "compact") {
      // Pragmatic v1 compact: trim the local transcript view only. It does
      // not call a provider-specific context compaction API.
      setInput(remaining);
      setMentionState({ kind: "none" });
      const noteMsg: AgentMessage = {
        id: generateId("msg"),
        role: "system",
        content:
          "(local transcript trimmed — provider/backend context was not compacted)",
        timestamp: Date.now(),
      };
      useAgentTaskStore.setState((s) => ({
        conversations: s.conversations.map((c) => {
          if (c.id !== conversationId) return c;
          const tail = c.messages.slice(-4);
          return {
            ...c,
            messages: [noteMsg, ...tail],
            updatedAt: Date.now(),
          };
        }),
      }));
      return;
    }

    if (cmd === "usage") {
      setInput(remaining);
      setMentionState({ kind: "none" });
      setActiveView("cost_dashboard");
      return;
    }

    if (cmd === "history") {
      setInput(remaining);
      setMentionState({ kind: "none" });
      setActiveView("history");
      return;
    }

    if (cmd === "goal") {
      // B5 — promote this conversation's checklist into a persistent
      // goal that survives the conversation closing. If a goal already
      // exists for this conversation, no-op (one goal per conversation
      // for v1).
      setInput(remaining);
      setMentionState({ kind: "none" });
      const conv = conversation;
      if (!conv) return;
      const existing = useGoalStore
        .getState()
        .getGoalForConversation(conversationId);
      if (existing) {
        const noteMsg: AgentMessage = {
          id: generateId("msg"),
          role: "system",
          content: `(/goal — already bound to goal "${existing.title}")`,
          timestamp: Date.now(),
        };
        useAgentTaskStore.setState((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversationId
              ? { ...c, messages: [...c.messages, noteMsg], updatedAt: Date.now() }
              : c,
          ),
        }));
        return;
      }
      const title =
        (conv.plan && conv.plan[0]?.content) ||
        (conv.spec?.criteria[0]) ||
        conv.title ||
        "Untitled goal";
      const linkedFlight = useFlightStore
        .getState()
        .flights.find((f) => f.linkedSessionIds.includes(conversationId));
      useGoalStore.getState().addGoal({
        title,
        conversationId,
        missionId: linkedFlight?.id,
        checklist: conv.plan ?? [],
        status: "active",
      });
      const okMsg: AgentMessage = {
        id: generateId("msg"),
        role: "system",
        content: `(/goal — created persistent goal "${title}"${linkedFlight ? ` bound to mission "${linkedFlight.title}"` : ""})`,
        timestamp: Date.now(),
      };
      useAgentTaskStore.setState((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === conversationId
            ? { ...c, messages: [...c.messages, okMsg], updatedAt: Date.now() }
            : c,
        ),
      }));
      return;
    }

    if (cmd === "review") {
      // Spawn a Reviewer subagent fed the current conversation's staged
      // diffs. The reviewer gets a fresh conversation (so its findings stay
      // separate from the work-in-progress thread) using the read-only
      // Reviewer profile + the current conversation's model.
      setInput(remaining);
      setMentionState({ kind: "none" });
      const conv = conversation;
      if (!conv || conv.mode !== "api" || !conv.model) return;
      const model = conv.model;
      const profile = reviewerProfile;
      void (async () => {
        try {
          const prompt = await buildReviewPrompt(conv);
          if (!prompt) {
            const noDiffMsg: AgentMessage = {
              id: generateId("msg"),
              role: "system",
              content:
                "(/review skipped — no pending write_file edits found in this conversation)",
              timestamp: Date.now(),
            };
            useAgentTaskStore.setState((s) => ({
              conversations: s.conversations.map((c) =>
                c.id === conversationId
                  ? {
                      ...c,
                      messages: [...c.messages, noDiffMsg],
                      updatedAt: Date.now(),
                    }
                  : c,
              ),
            }));
            return;
          }
          const newId = await createApiConversation(
            conv.agent,
            conv.projectPath,
            model,
            prompt,
            profile?.systemPrompt ?? null,
            undefined,
            true, // planMode — reviewer is read-only
            null,
            undefined,
            false,
            profile?.allowedTools ?? null,
            false,
          );
          selectConversation(newId);
        } catch (e) {
          console.warn("/review failed:", e);
        }
      })();
      return;
    }
  }

  function handleSend() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setMentionState({ kind: "none" });
    sendMessage(conversationId, text);
  }

  function handleStop() {
    void cancelActiveConversation(conversationId);
  }

  // Claude Code-style mode cycle. Applies flagsForMode(next) to the
  // conversation: planMode + permissionMode + approveWrites move together so
  // the chip always reflects the actual posture.
  function cycleMode() {
    if (!conversation || conversation.mode !== "api") return;
    const current = deriveMode(conversation);
    const next = nextMode(current);
    const flags = flagsForMode(next);
    if (flags.planMode !== conversation.planMode) {
      void setPlanMode(conversationId, flags.planMode);
    }
    if (flags.permissionMode !== conversation.permissionMode) {
      void setPermissionMode(conversationId, flags.permissionMode);
    }
    if (flags.approveWrites !== (conversation.approveWrites ?? false)) {
      void setApproveWrites(conversationId, flags.approveWrites);
    }
  }

  // Cursor-style "reasoning nudge" — Alt+. raises model thoroughness, Alt+,
  // drops it. Walks the active provider's model list and switches to the next
  // model whose `getModelSpeed` heuristic matches the desired direction. No-op
  // if the conversation isn't API-mode, has no provider, or there's no model
  // at the target speed level.
  function nudgeReasoning(direction: "up" | "down") {
    if (!conversation || conversation.mode !== "api") return;
    const provider = providerInfo;
    if (!provider) return;
    const current = conversation.model;
    if (!current) return;
    const currentSpeed = getModelSpeed(current);
    const SPEED_ORDER: Array<"fast" | "balanced" | "thorough"> = [
      "fast",
      "balanced",
      "thorough",
    ];
    const currentIdx = SPEED_ORDER.indexOf(currentSpeed);
    const targetIdx =
      direction === "up"
        ? Math.min(SPEED_ORDER.length - 1, currentIdx + 1)
        : Math.max(0, currentIdx - 1);
    if (targetIdx === currentIdx) return;
    const targetSpeed = SPEED_ORDER[targetIdx];
    const candidate = provider.models.find(
      (m) => getModelSpeed(m.value) === targetSpeed && m.value !== current,
    );
    if (!candidate) return;
    void changeModel(conversationId, candidate.value);
  }

  function handleOpenMarkdown(path: string) {
    if (!/\.mdx?$/i.test(path)) return;
    openMarkdownPreview(path);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Popover key handling
    if (mentionState.kind === "file") {
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionState({ kind: "none" });
        return;
      }
      // File mention selection is handled by the popover's onMouseDown; arrow
      // keys update highlightedIndex purely on our side via a cached count.
      // FileMentionPopover fetches results async, so we can't easily know the
      // final length here — we let the dropdown handle selection via click.
      // Enter/Tab to accept: find the popover's currently-highlighted DOM row.
      if (e.key === "Enter" || e.key === "Tab") {
        const el = document.querySelector<HTMLDivElement>(
          '[data-agent-pane-mention-popover] [role="option"][aria-selected="true"]',
        );
        if (el) {
          e.preventDefault();
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          return;
        }
        // If no file selection available, fall through to send.
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionState((ms) =>
          ms.kind === "file"
            ? { ...ms, highlightedIndex: ms.highlightedIndex + 1 }
            : ms,
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionState((ms) =>
          ms.kind === "file"
            ? {
                ...ms,
                highlightedIndex: Math.max(0, ms.highlightedIndex - 1),
              }
            : ms,
        );
        return;
      }
    }

    if (mentionState.kind === "slash") {
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionState({ kind: "none" });
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionState((ms) =>
          ms.kind === "slash"
            ? {
                ...ms,
                highlightedIndex: Math.min(
                  popoverItemCount - 1,
                  ms.highlightedIndex + 1,
                ),
              }
            : ms,
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionState((ms) =>
          ms.kind === "slash"
            ? {
                ...ms,
                highlightedIndex: Math.max(0, ms.highlightedIndex - 1),
              }
            : ms,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const q = mentionState.query.toLowerCase();
        const builtins = BUILTIN_SLASH_NAMES.filter((c) => c.startsWith(q));
        const customMatches = allCustomSlashCommands.filter((c) =>
          c.name.toLowerCase().startsWith(q),
        );
        const skillMatches = userSkills.filter(
          (s) => s.userInvocable && s.name.toLowerCase().startsWith(q),
        );
        const all: SlashSelection[] = [
          ...builtins.map((name) => ({ kind: "builtin" as const, name })),
          ...customMatches.map((def) => ({ kind: "custom" as const, def })),
          ...skillMatches.map((def) => ({ kind: "skill" as const, def })),
        ];
        const picked = all[mentionState.highlightedIndex] ?? all[0];
        if (picked) {
          e.preventDefault();
          runSlashCommand(picked);
          return;
        }
      }
    }

    // Claude-Code-style mode cycle. Shift+Tab walks default → plan → manual
    // → yolo → default and applies the flag triplet. Inside a textarea this
    // would otherwise just shift focus out, which isn't useful here.
    if (e.shiftKey && e.key === "Tab" && mentionState.kind === "none") {
      e.preventDefault();
      cycleMode();
      return;
    }

    // Codex-style mid-turn reasoning nudge. Alt+. raises model thoroughness,
    // Alt+, drops it. Works whether or not the agent is mid-stream — the next
    // turn (or the in-flight one, depending on backend) uses the new model.
    if (e.altKey && (e.key === "." || e.key === ",")) {
      e.preventDefault();
      nudgeReasoning(e.key === "." ? "up" : "down");
      return;
    }

    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      handleSend();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }
    // Tab outside any popover sends-as-queued. Useful for "I have follow-up
    // notes I want to give the agent for the next turn while it's still
    // working on this one." sendMessage already routes to queueing when the
    // agent is mid-stream; pre-stream it just behaves like Enter.
    if (e.key === "Tab" && !e.shiftKey && input.trim().length > 0) {
      e.preventDefault();
      handleSend();
    }
  }

  /* ----------------- render ----------------- */

  // Design-style status line: "N turns · M tool calls · P pending approvals".
  const turnCount = messages.filter((m) => m.role === "user").length;
  const toolCallCount = messages.reduce(
    (sum, m) => sum + (m.toolCalls?.length ?? 0),
    0,
  );
  const pendingApprovalCount =
    (conversation.pendingEdits?.length ?? 0) +
    (conversation.pendingPermissions?.length ?? 0);
  const statusLineParts: string[] = [];
  if (turnCount > 0) statusLineParts.push(`${turnCount} turn${turnCount === 1 ? "" : "s"}`);
  if (toolCallCount > 0)
    statusLineParts.push(`${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"}`);
  if (pendingApprovalCount > 0)
    statusLineParts.push(
      `${pendingApprovalCount} pending approval${pendingApprovalCount === 1 ? "" : "s"}`,
    );

  const chatContent = (
    <div className="flex flex-col h-full">
      {/* Header bar — design-faithful: sparkle avatar + title + status line */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 bg-bg-secondary border-b border-line-soft shrink-0">
        {/* Sparkle avatar */}
        <div className="w-[26px] h-[26px] shrink-0 rounded-md bg-accent-soft border border-accent-line grid place-items-center">
          <Sparkles size={13} className="text-accent-green" />
        </div>
        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[13px] font-semibold text-text-primary truncate">
              {conversation.title || agentLabel}
            </span>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
            <span className={`text-[10px] font-medium ${status.className}`}>
              {status.label}
            </span>
            {conversation.sshTarget && (
              <span
                className="flex items-center gap-1 text-[10px] text-accent-green bg-accent-soft border border-accent-line rounded px-1.5 py-0.5"
                title={`Tools run on ${conversation.sshTarget.user}@${conversation.sshTarget.host}:${conversation.sshTarget.remotePath}`}
              >
                <Server size={10} />
                {conversation.sshTarget.host}
              </span>
            )}
            <AgentHeaderBadges
              conversationId={conversationId}
              agent={conversation.agent}
            />
            {/* B8: when this conversation was spawned by a "Hand off to
                Codex" action, show a back-link to the parent. Click
                jumps; silently absent when the parent has been
                deleted. */}
            {conversation.parentConversationId && (
              <BackToParentLink parentId={conversation.parentConversationId} />
            )}
          </div>
          <span
            className="text-[10.5px] text-text-secondary truncate"
            title={`${userMsgCount} sent, ${assistantMsgCount} received`}
          >
            {statusLineParts.length > 0
              ? statusLineParts.join(" · ")
              : `${folderName} · ready`}
          </span>
        </div>

        {/* Right-side action group */}
        <div className="flex items-center gap-1 shrink-0">

        {/* Transcript verbosity (API mode only) */}
        {conversation.mode === "api" && (
          <select
            value={conversation.transcriptVerbosity ?? "normal"}
            onChange={(e) => {
              const next = e.target.value as "summary" | "normal" | "verbose";
              useAgentTaskStore.setState((s) => ({
                conversations: s.conversations.map((c) =>
                  c.id === conversationId
                    ? { ...c, transcriptVerbosity: next, updatedAt: Date.now() }
                    : c,
                ),
              }));
            }}
            title="Transcript density: Summary collapses tool calls and hides thinking; Verbose shows raw inputs."
            className="bg-bg-secondary border border-bg-border rounded text-[10px] px-1 py-0.5 text-text-secondary"
          >
            <option value="summary">Summary</option>
            <option value="normal">Normal</option>
            <option value="verbose">Verbose</option>
          </select>
        )}

        {/* Memory-context toggle (API mode only).
            Prepends learned patterns + prior lessons + recent session summaries
            to the system prompt. Requires a system-prompt override to be set —
            active by default for Scout (read-only investigator) profile. */}
        {conversation.mode === "api" && (
          <button
            onClick={() => {
              useAgentTaskStore.setState((s) => ({
                conversations: s.conversations.map((c) =>
                  c.id === conversationId
                    ? {
                        ...c,
                        memoryContextEnabled: !(c.memoryContextEnabled ?? false),
                        updatedAt: Date.now(),
                      }
                    : c,
                ),
              }));
            }}
            title={
              conversation.memoryContextEnabled
                ? (() => {
                    const ctx = memoryGetContext(conversation.projectPath);
                    if (!ctx.trim()) {
                      return "Memory context ON — no patterns learned yet for this project";
                    }
                    // Cap the tooltip so a giant memory dump doesn't fill the
                    // viewport. The full context is what the model sees.
                    const preview =
                      ctx.length > 600 ? `${ctx.slice(0, 600)}…` : ctx;
                    return `Memory context ON — injecting:\n\n${preview}`;
                  })()
                : "Memory context OFF — click to include learned patterns in system prompt"
            }
            className={`border rounded px-1.5 py-0.5 text-[10px] transition-colors ${
              conversation.memoryContextEnabled
                ? "bg-accent-blue/15 border-accent-blue/40 text-accent-blue"
                : "bg-bg-secondary border-bg-border text-text-muted hover:text-text-secondary"
            }`}
          >
            Memory
          </button>
        )}

        {/* Model switcher (API mode only) */}
        {providerInfo && conversation.mode === "api" && (
          <div data-agent-pane-model-dropdown={conversationId}>
            <Dropdown
              align="right"
              trigger={
                <span className="text-[11px] text-text-secondary">
                  {currentModelLabel}
                </span>
              }
            >
              {providerInfo.models.map((m) => (
                <DropdownItem
                  key={m.value}
                  onClick={() => {
                    void changeModel(conversationId, m.value);
                  }}
                >
                  <span
                    className={
                      m.value === currentModelValue
                        ? "text-accent-green text-[11px]"
                        : "text-[11px]"
                    }
                  >
                    {m.label}
                  </span>
                </DropdownItem>
              ))}
            </Dropdown>
          </div>
        )}

        {/* Plan mode + permission + approve-writes (API mode only) */}
        {conversation.mode === "api" && (
          <div className="flex items-center gap-1.5">
            <AgentModeChip conversation={conversation} onCycle={cycleMode} />
            <button
              type="button"
              onClick={() => void setPlanMode(conversationId, !conversation.planMode)}
              title={conversation.planMode ? "Plan mode ON — writes/bash disabled" : "Plan mode OFF — all tools enabled"}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors ${
                conversation.planMode
                  ? "border-accent-amber/40 text-accent-amber bg-accent-amber/10"
                  : "border-bg-border text-text-muted hover:text-text-primary"
              }`}
            >
              <Compass size={11} />
              Plan
            </button>
            <div data-agent-pane-permissions-dropdown={conversationId}>
              <select
                value={conversation.permissionMode ?? "auto"}
                onChange={(e) =>
                  void setPermissionMode(
                    conversationId,
                    e.target.value as "auto" | "ask_for_risky" | "allow_all" | "deny_all",
                  )
                }
                title="Permission mode for risky tools"
                className="bg-bg-secondary border border-bg-border rounded text-[10px] px-1 py-0.5 text-text-secondary"
              >
                <option value="auto">Auto</option>
                <option value="ask_for_risky">Ask risky</option>
                <option value="allow_all">Allow all</option>
                <option value="deny_all">Deny risky</option>
              </select>
            </div>
            <button
              type="button"
              onClick={() => void setApproveWrites(conversationId, !conversation.approveWrites)}
              title={conversation.approveWrites ? "Approve writes ON — confirm each write_file" : "Approve writes OFF"}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors ${
                conversation.approveWrites
                  ? "border-accent-amber/40 text-accent-amber bg-accent-amber/10"
                  : "border-bg-border text-text-muted hover:text-text-primary"
              }`}
            >
              <FileCheck2 size={11} />
              Approve
            </button>
            <Dropdown
              align="right"
              trigger={
                <span className="p-0.5 text-text-muted hover:text-text-primary inline-flex">
                  <MoreVertical size={12} />
                </span>
              }
            >
              <DropdownItem
                onClick={async () => {
                  try {
                    const md = await exportConversation(conversationId);
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
                }}
              >
                <span className="flex items-center gap-1.5 text-[11px]">
                  <Download size={11} /> Export as Markdown
                </span>
              </DropdownItem>
            </Dropdown>
          </div>
        )}

        {/* Diff pane trigger — uses live aggregate totals (`+adds / -dels`)
            computed from the conversation's write_file tool calls. */}
        {conversation.mode === "api" && (
          <DiffPaneTrigger
            conversationId={conversationId}
            fileCount={diffTotals.fileCount}
            totalAdds={diffTotals.totalAdds}
            totalDels={diffTotals.totalDels}
          />
        )}

        <button
          type="button"
          onClick={togglePreview}
          className={`p-0.5 rounded transition-colors ${
            previewOpen
              ? "text-accent-blue bg-accent-blue/10"
              : "text-text-muted hover:text-text-primary"
          }`}
          title={previewOpen ? "Collapse preview pane" : "Open preview pane"}
          aria-label={previewOpen ? "Collapse preview pane" : "Open preview pane"}
        >
          <PanelRightOpen size={12} />
        </button>

        {/* B4 — toggle the compact tabbed right rail (Plan / Diff /
            Inspector in a single column) on/off. Persisted. */}
        <button
          type="button"
          onClick={() => setUseCompactRail((v) => !v)}
          className={`p-0.5 rounded transition-colors ${
            useCompactRail
              ? "text-accent-blue bg-accent-blue/10"
              : "text-text-muted hover:text-text-primary"
          }`}
          title={
            useCompactRail
              ? "Hide compact tabbed rail"
              : "Show compact tabbed rail (Plan / Diff / Inspector)"
          }
          aria-label="Toggle compact tabbed rail"
        >
          <Columns2 size={12} />
        </button>

        {/* Split menu (open diff/terminal/file panes inside this conversation) */}
        <AgentPaneSplitMenu conversationId={conversationId} />

        {/* Continue in… */}
        <ContinueInMenu conversation={conversation} />

        {/* Rewind button */}
        <button
          onClick={() => setShowRewind((v) => !v)}
          className={`p-0.5 rounded transition-colors ${
            showRewind ? "text-accent-blue" : "text-text-muted hover:text-text-primary"
          }`}
          title="Rewind / checkpoints"
        >
          <RotateCcw size={12} />
        </button>

        {/* Right: close */}
        <button
          onClick={onClose}
          className="p-0.5 text-text-muted hover:text-text-primary rounded transition-colors"
          title="Close pane"
        >
          <X size={12} />
        </button>
        </div>
      </div>

      {/* Session health strip — model · ctx % · tokens · cost · branch */}
      <SessionHealthBar conversation={conversation} />

      {/* F10: Plan-first three-stage FSM. Spec → Plan → Code. SpecPanel
          renders only when specStage === "spec"; PlanPanel reads the rest. */}
      <SpecPanel conversation={conversation} />

      {/* Pinned plan / todo panel — surfaces the agent's latest TodoWrite or
          task_list checklist so users can steer mid-task. */}
      <PlanPanel conversation={conversation} />

      {/* Messages area */}
      <ClickablePathsRoot
        projectPath={conversation.projectPath}
        onOpenMarkdown={handleOpenMarkdown}
      >
        <div
          ref={messagesContainerRef}
          className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5"
        >
          {/* Memory injection callout — surfaces when memoryContextEnabled */}
          {conversation.mode === "api" && conversation.memoryContextEnabled && (
            <MemoryInjectionCard />
          )}

          {conversation.messages.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <span className="text-[11px] text-text-muted">No messages yet</span>
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id}>
              <MessageBubble
                message={msg}
                conversation={conversation}
                isLastAssistant={msg.id === lastAssistantMessage?.id}
                onRetry={
                  msg.id === lastAssistantMessage?.id && !msg.isStreaming
                    ? () => void retryLastTurn(conversationId)
                    : undefined
                }
              />
              {showQuickActions && msg.id === lastAssistantMessage?.id && (
                <AgentQuickActions
                  conversationId={conversationId}
                  message={msg}
                />
              )}
            </div>
          ))}

          {/* Plan-mode approval menu — visible when plan mode is on AND
              the last assistant message is a plan-shaped doc. */}
          {conversation.planMode &&
            lastMessage?.role === "assistant" &&
            !lastMessage.isStreaming &&
            looksLikePlan(lastMessage.content) && (
              <PlanModeApprovalMenu
                conversationId={conversationId}
                planText={lastMessage.content}
              />
            )}

          {/* Thinking indicator */}
          {showThinking && (
            <div className="flex items-start gap-2">
              <div className="flex items-center gap-1.5 px-3 py-2 bg-bg-secondary border border-bg-border rounded-lg text-[11px] text-text-muted">
                <Loader2 size={10} className="animate-spin" />
                Thinking...
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </ClickablePathsRoot>

      {/* Pending user-approval prompts */}
      {(conversation.pendingEdits ?? conversation.pendingPermissions) && (
        <div className="shrink-0 px-3 py-2 flex flex-col gap-2 border-t border-bg-border bg-bg-primary">
          <PendingApprovalsRollup
            pendingEdits={conversation.pendingEdits ?? []}
            pendingPermissions={conversation.pendingPermissions ?? []}
            onApplyAllEdits={() => {
              for (const item of conversation.pendingEdits ?? []) {
                void respondEdit(conversationId, item.id, "apply");
              }
            }}
            onRejectAllEdits={() => {
              for (const item of conversation.pendingEdits ?? []) {
                void respondEdit(conversationId, item.id, "reject");
              }
            }}
            onAllowAllPermissions={() => {
              for (const item of conversation.pendingPermissions ?? []) {
                void respondPermission(conversationId, item.id, "allow_once");
              }
            }}
            onDenyAllPermissions={() => {
              for (const item of conversation.pendingPermissions ?? []) {
                void respondPermission(conversationId, item.id, "deny");
              }
            }}
            onCancelAllPending={() => {
              void cancelPendingTools(conversationId);
            }}
          />
          {(conversation.pendingEdits ?? []).map((item) => (
            <PendingEditPrompt
              key={item.id}
              item={item}
              projectPath={conversation.projectPath}
              conversationId={conversationId}
              onApply={(toolId, mergedContent) =>
                void respondEdit(conversationId, toolId, "apply", mergedContent)
              }
              onReject={(toolId) => void respondEdit(conversationId, toolId, "reject")}
            />
          ))}
          {(conversation.pendingPermissions ?? []).map((item) => (
            <PermissionPrompt
              key={item.id}
              item={item}
              conversationAllowedTools={conversation.allowedTools}
              onAllowOnce={(toolId) => void respondPermission(conversationId, toolId, "allow_once")}
              onAllowAlways={(toolId) => void respondPermission(conversationId, toolId, "allow_always")}
              onDeny={(toolId) => void respondPermission(conversationId, toolId, "deny")}
              onAllowAlwaysWithPattern={(toolId, pattern) => {
                // Resolve the in-flight prompt as allow_always, then write
                // the derived rule into the conversation's allowlist so
                // future same-pattern tool calls skip the prompt.
                void respondPermission(conversationId, toolId, "allow_always");
                appendAllowedToolPattern(conversationId, pattern);
              }}
            />
          ))}
        </div>
      )}

      {/* Status bar — project + branch */}
      <AgentStatusBar conversation={conversation} />

      {/* B1: queued hover-`+` diff comments. Folded into the next user
          turn as a "File comments:" preamble; cleared on send or via the
          inline X. Only renders when the queue is non-empty. */}
      {(conversation.pendingDiffComments?.length ?? 0) > 0 && (
        <div className="shrink-0 border-t border-accent-blue/30 bg-accent-blue/5 px-3 py-1.5 flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider text-accent-blue">
            {conversation.pendingDiffComments!.length} file comment
            {conversation.pendingDiffComments!.length === 1 ? "" : "s"} queued
          </span>
          <span className="text-[10px] text-text-muted">
            attached on next send
          </span>
          <div className="flex items-center gap-1 flex-wrap flex-1 min-w-0">
            {conversation.pendingDiffComments!.map((dc) => (
              <span
                key={dc.id}
                className="inline-flex items-center gap-1 text-[10px] bg-bg-secondary border border-bg-border rounded px-1.5 py-0.5 max-w-full"
                title={`${dc.path}:${dc.line} — ${dc.text}`}
              >
                <span className="font-mono text-text-secondary truncate max-w-[140px]">
                  {dc.path.split(/[\\/]/).pop()}:{dc.line}
                </span>
                <button
                  type="button"
                  onClick={() => removeDiffComment(conversationId, dc.id)}
                  className="text-text-faint hover:text-accent-red"
                  title="Remove this comment"
                >
                  <X size={9} />
                </button>
              </span>
            ))}
          </div>
          <button
            type="button"
            onClick={() => clearDiffComments(conversationId)}
            className="text-[10px] text-text-muted hover:text-text-secondary ml-auto"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Input area */}
      <div className="shrink-0 border-t border-bg-border px-3 py-2 bg-bg-primary relative">
        {/* Popovers anchored above the textarea */}
        <div
          className="absolute left-3 right-3 bottom-full"
          data-agent-pane-mention-popover
        >
          <MentionSourcePicker
            visible={mentionState.kind === "file"}
            projectPath={conversation.projectPath}
            query={mentionState.kind === "file" ? mentionState.query : ""}
            highlightedIndex={
              mentionState.kind === "file" ? mentionState.highlightedIndex : 0
            }
            onSelect={selectFileMention}
          />
          <SlashCommandPopover
            customCommands={allCustomSlashCommands}
            userSkills={userSkills}
            visible={mentionState.kind === "slash"}
            query={mentionState.kind === "slash" ? mentionState.query : ""}
            highlightedIndex={
              mentionState.kind === "slash" ? mentionState.highlightedIndex : 0
            }
            onSelect={runSlashCommand}
          />
        </div>

        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            data-agent-pane-input
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onKeyUp={handleSelectionChange}
            onClick={handleSelectionChange}
            placeholder="Send a message..."
            rows={1}
            className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-muted focus:outline-none resize-none leading-relaxed"
          />

          {/* Mic button */}
          {voiceSupported && (
            <button
              onClick={isListening ? stopListening : startListening}
              className={`p-1 rounded transition-colors shrink-0 ${
                isListening
                  ? "bg-accent-green/20 text-accent-green animate-pulse"
                  : "text-text-muted hover:text-text-primary hover:bg-bg-hover"
              }`}
              title={isListening ? "Stop recording" : "Voice input"}
            >
              <Mic size={12} />
            </button>
          )}

          {/* Send / Stop */}
          {isRunning ? (
            <button
              onClick={handleStop}
              className="p-1 text-accent-red hover:bg-accent-red/10 rounded transition-colors shrink-0"
              title="Stop"
            >
              <Square size={12} />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="p-1 text-accent-green hover:bg-accent-green/10 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
              title="Send (Enter)"
            >
              <Send size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-full bg-bg-primary">
      <div className="flex-1 min-w-0">
        <AgentMosaicShell
          conversationId={conversationId}
          chat={chatContent}
          diff={<EmbeddedDiffPane conversationId={conversationId} />}
          terminal={
            <TerminalPane
              paneId={`agent-${conversationId}-term`}
              projectPath={conversation.projectPath}
            />
          }
          file={
            <AgentFilePane
              conversationId={conversationId}
              projectPath={conversation.projectPath}
              sshTarget={conversation.sshTarget ?? null}
              onSelectFile={handleOpenMarkdown}
            />
          }
        />
      </div>
      {previewOpen && <AgentPreviewPane projectPath={conversation.projectPath} />}
      {useCompactRail && <AgentTabbedRail conversationId={conversationId} />}
      {showRewind && (
        <div className="w-72 shrink-0 border-l border-bg-border">
          <CheckpointPanel
            conversationId={conversationId}
            onClose={() => setShowRewind(false)}
          />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Message bubble                                                      */
/* ------------------------------------------------------------------ */

function MessageBubble({
  message,
  conversation,
  isLastAssistant,
  onRetry,
}: {
  message: AgentMessage;
  conversation: AgentConversation;
  isLastAssistant?: boolean;
  onRetry?: () => void;
}) {
  if (message.role === "system") {
    return (
      <div className="flex justify-center">
        <div className="text-[10px] text-text-muted px-2 py-1 bg-bg-secondary/50 border border-bg-border rounded max-w-[90%]">
          <MarkdownRenderer
            content={message.content}
            className="text-[10px] leading-relaxed"
          />
        </div>
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div
          className={`max-w-[85%] px-3 py-1.5 rounded-lg text-xs text-text-primary ${
            message.queued
              ? "bg-accent-amber/10 border border-accent-amber/30"
              : "bg-accent-blue/15"
          }`}
        >
          <div>{message.content}</div>
          {message.queued && (
            <span className="text-[10px] text-accent-amber ml-1">
              (queued)
            </span>
          )}
        </div>
      </div>
    );
  }

  // assistant
  const verbosity = conversation.transcriptVerbosity ?? "normal";
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-1.5">
        {/* Thinking block — hidden in summary mode */}
        {verbosity !== "summary" && message.thinking && message.thinking.length > 0 && (
          <ThinkingBlock text={message.thinking} streaming={message.isStreaming} />
        )}

        {/* Exploration rollup — collapses read_file/grep/glob/list_files into one line */}
        {message.toolCalls && message.toolCalls.length > 0 && !message.isStreaming && (
          <ExplorationRollupCard toolCalls={message.toolCalls} />
        )}

        {/* Tool calls — group write_file edits when there are 3+ */}
        {message.toolCalls && message.toolCalls.length > 0 && (() => {
          // Hide explored-only tool calls (already summarized above) when not streaming
          const isExplored = (name: string) =>
            ["read_file", "Read", "grep", "Grep", "glob", "Glob", "search",
             "list_directory", "list_files", "LS", "ls"].includes(name);
          const visibleToolCalls = message.isStreaming
            ? message.toolCalls
            : message.toolCalls.filter((tc) => !isExplored(tc.name));
          if (visibleToolCalls.length === 0) return null;
          const writeFileCalls = visibleToolCalls.filter(
            (tc) =>
              tc.name === "write_file" &&
              (tc.status === "done" || tc.status === "error"),
          );
          const otherCalls = visibleToolCalls.filter(
            (tc) => !writeFileCalls.includes(tc),
          );
          const groupWrites = writeFileCalls.length >= 3;
          return (
            <div className="flex flex-col gap-1">
              {groupWrites && (
                <MultiFileEditCard
                  toolCalls={writeFileCalls}
                  conversationId={conversation.id}
                  projectPath={conversation.projectPath}
                />
              )}
              {(groupWrites ? otherCalls : visibleToolCalls).map((tc) =>
                tc.name === "bash" ? (
                  <BashToolCallCard
                    key={tc.id}
                    toolCall={tc}
                    conversationId={conversation.id}
                    verbosity={verbosity}
                  />
                ) : tc.name === "spawn_subagent" ? (
                  <SubagentToolCallCard
                    key={tc.id}
                    toolCall={tc}
                    conversationId={conversation.id}
                    verbosity={verbosity}
                  />
                ) : tc.name === "task_list" ? (
                  <TaskListCard
                    key={tc.id}
                    toolCall={tc}
                    verbosity={verbosity}
                  />
                ) : (
                  <ToolCallCard
                    key={tc.id}
                    toolCall={tc}
                    projectPath={conversation.projectPath}
                    verbosity={verbosity}
                  />
                ),
              )}
            </div>
          );
        })()}

        {/* Content */}
        {message.content && (
          <div className="px-3 py-2 bg-bg-secondary border border-bg-border rounded-lg text-xs">
            <MarkdownRenderer
              content={message.content}
              className="text-xs leading-relaxed"
            />
          </div>
        )}

        {/* Streaming cursor */}
        {message.isStreaming && (
          <span className="inline-block w-1.5 h-3.5 bg-accent-green/70 rounded-sm animate-pulse ml-1" />
        )}

        {/* Footer row: cost pill + retry */}
        <div className="flex items-center gap-2">
          <AssistantCostPill
            message={message}
            model={conversation.model ?? ""}
          />
          {isLastAssistant && !message.isStreaming && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              title="Retry this turn"
              className="text-text-muted hover:text-text-primary text-[10px] p-0.5 rounded transition-colors"
            >
              <RotateCw size={11} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cost pill                                                           */
/* ------------------------------------------------------------------ */

function AssistantCostPill({
  message,
  model,
}: {
  message: AgentMessage;
  model: string;
}) {
  // Only render if token info is present on the message.
  // NOTE: the store's `done` handler does not currently persist tokens onto
  // AgentMessage — this pill stays hidden until that wiring lands. The type
  // supports the fields so no refactor is needed downstream.
  const [cost, setCost] = useState<number | null>(null);

  const {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  } = message;

  useEffect(() => {
    if (inputTokens == null || outputTokens == null || !model) {
      setCost(null);
      return;
    }
    let cancelled = false;
    calculateTurnCost(
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens ?? 0,
      cacheWriteTokens ?? 0,
    )
      .then((n) => {
        if (!cancelled) setCost(n);
      })
      .catch(() => {
        if (!cancelled) setCost(null);
      });
    return () => {
      cancelled = true;
    };
  }, [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, model]);

  if (inputTokens == null || outputTokens == null) return null;
  const totalTokens = inputTokens + outputTokens;
  return (
    <div className="text-[10px] text-text-muted mt-1 font-mono">
      {totalTokens} tok
      {cost != null && ` · $${cost.toFixed(4)}`}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tool call card                                                      */
/* ------------------------------------------------------------------ */

interface WriteFileInput {
  path?: string;
  content?: string;
}

/**
 * Parse a tool call's `input` field (if captured on the tool call) for
 * write_file path+content. Returns null if unavailable or malformed.
 *
 * Note: AgentToolCall currently doesn't carry `input` — kept best-effort so
 * diff rendering lights up automatically once the store records it.
 */
function parseWriteFileInput(tc: AgentToolCall): WriteFileInput | null {
  const anyTc = tc as AgentToolCall & { input?: unknown };
  const raw = anyTc.input;
  if (raw == null) return null;
  try {
    let obj: unknown = raw;
    if (typeof raw === "string") obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      const rec = obj as Record<string, unknown>;
      const path =
        typeof rec.path === "string"
          ? rec.path
          : typeof rec.file_path === "string"
            ? (rec.file_path as string)
            : undefined;
      const content =
        typeof rec.content === "string" ? rec.content : undefined;
      if (path && content != null) return { path, content };
    }
  } catch {
    return null;
  }
  return null;
}

function ToolCallCard({
  toolCall,
  projectPath,
  verbosity = "normal",
}: {
  toolCall: AgentToolCall;
  projectPath: string;
  verbosity?: "summary" | "normal" | "verbose";
}) {
  const [expanded, setExpanded] = useState(verbosity === "verbose");

  const writeFileInput =
    toolCall.name === "write_file" ? parseWriteFileInput(toolCall) : null;

  const statusIcon =
    toolCall.status === "running" ? (
      <Loader2 size={10} className="animate-spin" />
    ) : toolCall.status === "error" ? (
      <XCircle size={10} className="text-accent-red" />
    ) : (
      <CheckCircle size={10} className="text-accent-green" />
    );

  // Status dot mirrors the design (green=done, amber+pulse=running, muted=else).
  const dotClass =
    toolCall.status === "running"
      ? "bg-accent-amber animate-pulse"
      : toolCall.status === "error"
        ? "bg-accent-red"
        : "bg-accent-green";

  // write_file with parseable input gets a diff view (replaces summary body).
  if (writeFileInput) {
    return (
      <div className="border border-bg-border rounded-md overflow-hidden bg-bg-secondary">
        <div className="flex items-center gap-2 px-2.5 py-1.5 bg-bg-tertiary border-b border-line-soft">
          {statusIcon}
          <span className="text-[12px] font-medium text-text-primary">Edit</span>
          {toolCall.file && (
            <span className="font-mono text-[10.5px] text-text-secondary truncate">
              {toolCall.file}
            </span>
          )}
          <span className="flex-1" />
          <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
          <span className="text-[10.5px] capitalize text-text-secondary">
            {toolCall.status}
          </span>
        </div>
        <ToolDiffView
          projectPath={projectPath}
          filePath={writeFileInput.path!}
          newContent={writeFileInput.content!}
        />
      </div>
    );
  }

  const summary = toolCall.summary ?? "";
  const fullContent = toolCall.fullContent ?? summary;
  const summaryPreview = summary
    .split("\n")
    .slice(0, 2)
    .join("\n");
  const hasMore =
    (toolCall.fullContent && toolCall.fullContent !== summary) ||
    summary.split("\n").length > 2 ||
    summary.length > 160;

  return (
    <div className="border border-bg-border rounded-md overflow-hidden bg-bg-secondary">
      <button
        type="button"
        onClick={() => hasMore && setExpanded((v) => !v)}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left bg-bg-tertiary ${
          hasMore ? "hover:bg-bg-elevated cursor-pointer" : "cursor-default"
        } ${expanded && hasMore ? "border-b border-line-soft" : ""} transition-colors`}
      >
        {statusIcon}
        <span className="text-[12px] font-medium text-text-primary">{toolCall.name}</span>
        {toolCall.file && (
          <span className="font-mono text-[10.5px] text-text-secondary truncate">
            {toolCall.file}
          </span>
        )}
        {!expanded && summaryPreview && verbosity !== "summary" && (
          <span className="ml-1 truncate text-text-muted text-[10.5px] flex-1 min-w-0">
            {summaryPreview.replace(/\n/g, " ↵ ")}
          </span>
        )}
        <span className="flex-1" />
        <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
        <span className="text-[10.5px] capitalize text-text-secondary">
          {toolCall.status}
        </span>
        {hasMore && (
          expanded ? (
            <ChevronDown size={10} className="text-text-muted" />
          ) : (
            <ChevronRight size={10} className="text-text-muted" />
          )
        )}
      </button>
      {expanded && hasMore && (
        <pre className="text-[11px] font-mono whitespace-pre-wrap bg-bg-primary p-2 max-h-96 overflow-y-auto text-text-primary">
          {fullContent}
        </pre>
      )}
      {expanded && verbosity === "verbose" && toolCall.input && (
        <pre className="text-[10px] font-mono whitespace-pre-wrap bg-bg-secondary border-t border-line-soft p-2 max-h-48 overflow-y-auto text-text-muted">
          input: {toolCall.input}
        </pre>
      )}
    </div>
  );
}
