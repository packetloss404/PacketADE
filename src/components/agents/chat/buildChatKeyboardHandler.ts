import type { RefObject } from "react";
import type {
  SkillDef,
  SlashCommandDef,
} from "@/lib/tauri";
import type { SlashSelection } from "../SlashCommandPopover";
import { BUILTIN_SLASH_NAMES } from "../slashCommandConstants";
import type { AgentMessage } from "@/types/agent-conversation";

export type MentionState =
  | { kind: "none" }
  | {
      kind: "file";
      query: string;
      triggerIndex: number;
      highlightedIndex: number;
    }
  | {
      kind: "slash";
      query: string;
      triggerIndex: number;
      highlightedIndex: number;
    };

interface ChatKeyboardDeps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  input: string;
  setInput: (s: string) => void;
  messages: AgentMessage[];
  mentionState: MentionState;
  setMentionState: React.Dispatch<React.SetStateAction<MentionState>>;
  historyIndex: number;
  setHistoryIndex: (n: number) => void;
  historySourceRef: { current: "user" | "history" };
  popoverItemCount: number;
  allCustomSlashCommands: SlashCommandDef[];
  userSkills: SkillDef[];
  setStashedDraft: (s: string | null) => void;
  cycleMode: () => void;
  nudgeReasoning: (dir: "up" | "down") => void;
  runSlashCommand: (sel: SlashSelection) => void;
  handleSend: () => void;
}

/**
 * Builds the textarea keyDown handler. Wraps the layered key routing logic:
 * popover-aware mention/slash navigation, shell-style ↑/↓ history, Shift+Tab
 * mode cycle, Alt+./, reasoning nudge, Ctrl+S stash, Enter/Tab send.
 *
 * Not a hook itself (doesn't call React internals) — naming follows
 * factory-style helpers.
 */
export function buildChatKeyboardHandler(deps: ChatKeyboardDeps) {
  const {
    textareaRef,
    input,
    setInput,
    messages,
    mentionState,
    setMentionState,
    historyIndex,
    setHistoryIndex,
    historySourceRef,
    popoverItemCount,
    allCustomSlashCommands,
    userSkills,
    setStashedDraft,
    cycleMode,
    nudgeReasoning,
    runSlashCommand,
    handleSend,
  } = deps;

  return function handleKeyDown(
    e: React.KeyboardEvent<HTMLTextAreaElement>,
  ) {
    if (mentionState.kind === "file") {
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionState({ kind: "none" });
        return;
      }
      // FileMentionPopover fetches results async, so delegate accept to a
      // mousedown dispatch on the highlighted DOM row.
      if (e.key === "Enter" || e.key === "Tab") {
        const el = document.querySelector<HTMLDivElement>(
          '[data-agent-pane-mention-popover] [role="option"][aria-selected="true"]',
        );
        if (el) {
          e.preventDefault();
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          return;
        }
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

    // Shell-style ↑/↓ history. Only triggers when no popover is open and
    // either the composer is empty or the caret is at the very start so it
    // doesn't fight multiline editing.
    if (
      mentionState.kind === "none" &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      !e.shiftKey
    ) {
      const ta = textareaRef.current;
      const caretAtStart =
        !!ta && ta.selectionStart === 0 && ta.selectionEnd === 0;
      const eligible = input.length === 0 || caretAtStart;
      const userMsgs = messages
        .filter((m) => m.role === "user")
        .map((m) => m.content);

      if (e.key === "ArrowUp" && eligible && userMsgs.length > 0) {
        const nextIdx = Math.min(userMsgs.length - 1, historyIndex + 1);
        if (nextIdx !== historyIndex) {
          e.preventDefault();
          setHistoryIndex(nextIdx);
          historySourceRef.current = "history";
          setInput(userMsgs[userMsgs.length - 1 - nextIdx]);
        }
        return;
      }
      if (e.key === "ArrowDown" && historyIndex >= 0) {
        e.preventDefault();
        const nextIdx = historyIndex - 1;
        setHistoryIndex(nextIdx);
        historySourceRef.current = "history";
        setInput(nextIdx < 0 ? "" : userMsgs[userMsgs.length - 1 - nextIdx]);
        return;
      }
      if (e.key === "Escape" && historyIndex >= 0) {
        e.preventDefault();
        setHistoryIndex(-1);
        historySourceRef.current = "history";
        setInput("");
        return;
      }
    }

    if (e.shiftKey && e.key === "Tab" && mentionState.kind === "none") {
      e.preventDefault();
      cycleMode();
      return;
    }

    if (e.altKey && (e.key === "." || e.key === ",")) {
      e.preventDefault();
      nudgeReasoning(e.key === "." ? "up" : "down");
      return;
    }

    // Ctrl+S — stash the current draft. Composer clears, chip appears above.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      if (input.trim().length > 0) {
        e.preventDefault();
        setStashedDraft(input);
        setInput("");
        setHistoryIndex(-1);
        return;
      }
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
    // Tab outside any popover sends-as-queued. sendMessage already routes to
    // queueing when the agent is mid-stream.
    if (e.key === "Tab" && !e.shiftKey && input.trim().length > 0) {
      e.preventDefault();
      handleSend();
    }
  };
}
