import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { BookmarkPlus, Pencil, RotateCcw, RotateCw } from "lucide-react";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip } from "@/components/ui/Tooltip";
import { buildTranscriptMemoryInput } from "@/lib/memoryCapture";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { ExplorationRollupCard } from "../ExplorationRollupCard";
import { PlanModeApprovalMenu } from "../PlanModeApprovalMenu";
import { ThinkingBlock } from "../ThinkingBlock";
import { looksLikePlan } from "../planDetection";
import { ToolCallRenderer } from "./ToolCallRenderer";
import type {
  AgentConversation,
  AgentMessage,
} from "@/types/agent-conversation";

// Virtualization tuning. The last N rows always mount immediately so the
// bottom of the transcript (streaming message, quick actions, diff viewer)
// renders instantly and the "stick to bottom" scroll lands on real content.
// Everything above is lazily mounted as it approaches the viewport.
const TAIL_FORCE_MOUNT = 10;
// Reserved height for a not-yet-mounted row. Keeps the scroll container
// overflowing (so off-screen rows stay off-screen) and gives the scrollbar a
// sensible size before real heights are known. WKWebView has NO CSS scroll
// anchoring, so LazyMessageRow compensates scrollTop manually when a row
// mounts above the viewport (see the layout effect there).
const PLACEHOLDER_MIN_HEIGHT = 72;

interface MessageListProps {
  conversation: AgentConversation;
  conversationId: string;
  editingMessageId: string | null;
  editingText: string;
  onStartEdit: (msgId: string, content: string) => void;
  onChangeEdit: (text: string) => void;
  onSubmitEdit: (msgId: string) => void;
  onCancelEdit: () => void;
  /** Inline per-message Restore: truncates the transcript to before this
   * message and re-runs it, via forkAndResend (subsumes checkpoints). */
  onRestoreFrom: (msgId: string, content: string) => void;
  onRetryLastTurn: () => void;
  isActive: boolean;
  // Scroll container that owns the message viewport (from AgentChatPane).
  // Used as the IntersectionObserver root for lazy row mounting.
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
}

export function MessageList({
  conversation,
  conversationId,
  editingMessageId,
  editingText,
  onStartEdit,
  onChangeEdit,
  onSubmitEdit,
  onCancelEdit,
  onRestoreFrom,
  onRetryLastTurn,
  isActive,
  scrollContainerRef,
}: MessageListProps) {
  const messages = conversation.messages;
  const lastMessage = messages[messages.length - 1];
  const lastAssistantMessage = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");
  const showThinking =
    isActive &&
    (!lastMessage || lastMessage.role === "user") &&
    messages.length > 0;

  // Shared IntersectionObserver for lazy row mounting. One observer per list
  // instance watches every placeholder row; when a row nears the viewport it
  // mounts once and is unobserved (mount-once, never unmount — preserves per
  // card local state like expanded tool output and streaming auto-scroll).
  const observerRef = useRef<IntersectionObserver | null>(null);
  const visibilityCallbacks = useRef(new Map<Element, () => void>());
  const register = useCallback(
    (el: Element, onVisible: () => void) => {
      if (typeof IntersectionObserver === "undefined") {
        onVisible();
        return () => {};
      }
      if (!observerRef.current) {
        observerRef.current = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const cb = visibilityCallbacks.current.get(entry.target);
              if (cb) {
                visibilityCallbacks.current.delete(entry.target);
                observerRef.current?.unobserve(entry.target);
                cb();
              }
            }
          },
          { root: scrollContainerRef?.current ?? null, rootMargin: "600px 0px" },
        );
      }
      visibilityCallbacks.current.set(el, onVisible);
      observerRef.current.observe(el);
      return () => {
        visibilityCallbacks.current.delete(el);
        observerRef.current?.unobserve(el);
      };
    },
    [scrollContainerRef],
  );
  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      visibilityCallbacks.current.clear();
    },
    [],
  );

  const tailStart = Math.max(0, messages.length - TAIL_FORCE_MOUNT);

  return (
    <>
      {messages.map((msg, index) => {
        const isLastAssistant = msg.id === lastAssistantMessage?.id;
        // Always mount the tail window + the last assistant message so the
        // streaming card, quick actions and diff viewer never get windowed out.
        const forceMount = index >= tailStart || isLastAssistant;
        return (
          <LazyMessageRow
            key={msg.id}
            forceMount={forceMount}
            register={register}
            scrollContainerRef={scrollContainerRef}
          >
            <MessageBubble
              message={msg}
              conversation={conversation}
              isLastAssistant={isLastAssistant}
              onRetry={
                isLastAssistant && !msg.isStreaming ? onRetryLastTurn : undefined
              }
              isEditing={editingMessageId === msg.id}
              editingText={editingText}
              onStartEdit={
                msg.role === "user"
                  ? () => onStartEdit(msg.id, msg.content)
                  : undefined
              }
              onRestoreFrom={
                msg.role === "user"
                  ? () => onRestoreFrom(msg.id, msg.content)
                  : undefined
              }
              onChangeEdit={onChangeEdit}
              onSubmitEdit={() => onSubmitEdit(msg.id)}
              onCancelEdit={onCancelEdit}
            />
          </LazyMessageRow>
        );
      })}

      {conversation.planMode &&
        lastMessage?.role === "assistant" &&
        !lastMessage.isStreaming &&
        looksLikePlan(lastMessage.content) && (
          <PlanModeApprovalMenu
            conversationId={conversationId}
            planText={lastMessage.content}
          />
        )}

      {showThinking && (
        <div className="flex items-start gap-2">
          <div className="flex items-center gap-1.5 px-3 py-2 bg-bg-secondary rounded text-ui text-text-muted">
            <Spinner size={10} className="text-text-muted" label="Thinking" />
            Thinking...
          </div>
        </div>
      )}
    </>
  );
}

// Lazily mounts a single message row. Force-mounted rows (tail window / last
// assistant) render immediately; the rest render a fixed-height placeholder
// until they scroll near the viewport, then mount once and stay mounted so no
// card loses local state and scroll position never jumps from an unmount.
function LazyMessageRow({
  forceMount,
  register,
  scrollContainerRef,
  children,
}: {
  forceMount: boolean;
  register: (el: Element, onVisible: () => void) => () => void;
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(forceMount);
  const rowRef = useRef<HTMLDivElement>(null);
  // Placeholder height captured at the moment the observer told this row to
  // mount; consumed by the compensation layout effect below.
  const placeholderHeightRef = useRef<number | null>(null);

  useEffect(() => {
    if (forceMount) {
      setMounted(true);
      return;
    }
    const el = rowRef.current;
    if (!el) return;
    return register(el, () => {
      placeholderHeightRef.current = el.getBoundingClientRect().height;
      setMounted(true);
    });
  }, [forceMount, register]);

  // WKWebView has no CSS scroll anchoring, so when a placeholder above the
  // viewport grows to its real height the visible content lurches down by the
  // difference (Safari never adjusts scrollTop the way Chromium/Gecko do).
  // Compensate manually: measure the height delta in a layout effect (same
  // frame, before paint) and shift the scroll container by it when the row
  // sits above the viewport top. Rows at/below the viewport top need nothing,
  // and the at-bottom pin in useScrollState still owns the follow behavior.
  useLayoutEffect(() => {
    if (!mounted) return;
    const placeholderHeight = placeholderHeightRef.current;
    placeholderHeightRef.current = null;
    if (placeholderHeight == null) return;
    const el = rowRef.current;
    const container = scrollContainerRef?.current;
    if (!el || !container) return;
    const delta = el.getBoundingClientRect().height - placeholderHeight;
    if (delta === 0) return;
    if (el.getBoundingClientRect().top < container.getBoundingClientRect().top) {
      container.scrollBy(0, delta);
    }
  }, [mounted, scrollContainerRef]);

  return (
    <div
      ref={rowRef}
      className="animate-[welcomeFadeIn_200ms_ease-out] motion-reduce:animate-none"
      style={mounted ? undefined : { minHeight: PLACEHOLDER_MIN_HEIGHT }}
    >
      {mounted ? children : null}
    </div>
  );
}

function MessageBubble({
  message,
  conversation,
  isLastAssistant,
  onRetry,
  isEditing,
  editingText,
  onStartEdit,
  onRestoreFrom,
  onChangeEdit,
  onSubmitEdit,
  onCancelEdit,
}: {
  message: AgentMessage;
  conversation: AgentConversation;
  isLastAssistant?: boolean;
  onRetry?: () => void;
  isEditing?: boolean;
  editingText?: string;
  onStartEdit?: () => void;
  onRestoreFrom?: () => void;
  onChangeEdit?: (text: string) => void;
  onSubmitEdit?: () => void;
  onCancelEdit?: () => void;
}) {
  // Two-step confirm for the inline Restore action — it discards every
  // later message (fork-and-resend truncates in place), so a single stray
  // hover-click must not be destructive. Local state is safe here: rows
  // are mount-once (LazyMessageRow never unmounts them).
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  // M4: manual "+ Add to memory" on assistant turns. Both hooks read
  // unconditionally at the top so hook order stays stable across the role
  // early-returns below.
  const [captured, setCaptured] = useState(false);
  const captureManually = useMemoryStore((s) => s.captureManually);
  // Global transcript view mode (P1-17) — read unconditionally at the top so
  // this hook call stays stable across the role early-returns below.
  const verbosity = useAgentSettingsStore((s) => s.transcriptViewMode);
  if (message.role === "system") {
    return (
      <div className="flex justify-center">
        <div className="text-meta text-text-muted px-2 py-1 bg-bg-secondary/50 rounded max-w-[90%]">
          <MarkdownRenderer
            content={message.content}
            className="text-meta leading-relaxed"
          />
        </div>
      </div>
    );
  }

  if (message.role === "user") {
    if (isEditing) {
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] w-full px-3 py-2 rounded text-xs bg-accent-blue/10 border border-accent-blue/40 flex flex-col gap-1.5">
            <textarea
              autoFocus
              value={editingText ?? ""}
              onChange={(e) => onChangeEdit?.(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  onSubmitEdit?.();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancelEdit?.();
                }
              }}
              rows={Math.min(
                8,
                Math.max(2, (editingText ?? "").split("\n").length),
              )}
              className="w-full bg-transparent text-xs text-text-primary placeholder:text-text-muted focus:outline-none resize-none leading-relaxed"
            />
            <div className="flex items-center justify-between gap-2">
              <Tooltip content="Truncates the transcript to this point and re-runs from here">
                <span className="text-meta text-text-muted">
                  Forks the conversation from this turn
                </span>
              </Tooltip>
              <div className="flex items-center gap-1.5">
                <Tooltip content="Cancel (Esc)">
                  <button
                    type="button"
                    onClick={onCancelEdit}
                    className="text-ui px-2 py-0.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                  >
                    Cancel
                  </button>
                </Tooltip>
                <Tooltip content="Send (Ctrl+Enter)">
                  <button
                    type="button"
                    onClick={onSubmitEdit}
                    disabled={!(editingText ?? "").trim()}
                    className="text-ui px-2 py-0.5 rounded bg-accent-green/20 hover:bg-accent-green/30 text-accent-green font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Resend
                  </button>
                </Tooltip>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-end">
        <div className="group flex w-full justify-end">
          <div
            className={`max-w-[85%] px-3 py-1.5 rounded text-xs text-text-primary relative ${
              message.queued
                ? "bg-accent-amber/10"
                : "bg-accent-blue/15"
            }`}
          >
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
            {message.queued && (
              <span className="text-meta text-accent-amber ml-1">
                (queued)
              </span>
            )}
            {!message.queued && (onStartEdit || onRestoreFrom) && (
              <div className="absolute -left-6 top-1/2 flex -translate-y-1/2 flex-col gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                {onStartEdit && (
                  <Tooltip content="Edit & resend — forks the conversation from this turn">
                    <button
                      type="button"
                      onClick={onStartEdit}
                      className="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
                    >
                      <Pencil size={11} />
                    </button>
                  </Tooltip>
                )}
                {onRestoreFrom && (
                  <Tooltip content="Restore — rewind to this turn and re-run it">
                    <button
                      type="button"
                      onClick={() => setConfirmingRestore(true)}
                      className="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
                    >
                      <RotateCcw size={11} />
                    </button>
                  </Tooltip>
                )}
              </div>
            )}
          </div>
        </div>
        {confirmingRestore && (
          <div className="mt-1 flex items-center gap-2 rounded bg-accent-amber/10 px-2 py-1">
            <span className="text-meta text-accent-amber">
              Restore from here? Later messages are discarded and this turn
              re-runs.
            </span>
            <button
              type="button"
              onClick={() => {
                setConfirmingRestore(false);
                onRestoreFrom?.();
              }}
              className="text-ui px-1.5 py-0.5 rounded bg-accent-amber/20 hover:bg-accent-amber/30 text-accent-amber font-medium transition-colors"
            >
              Restore
            </button>
            <button
              type="button"
              onClick={() => setConfirmingRestore(false)}
              className="text-ui px-1.5 py-0.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  }

  // assistant
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-1.5">
        {verbosity !== "summary" &&
          message.thinking &&
          message.thinking.length > 0 && (
            <ThinkingBlock
              text={message.thinking}
              streaming={message.isStreaming}
            />
          )}

        {message.toolCalls && message.toolCalls.length > 0 && (
          <ExplorationRollupCard
            toolCalls={message.toolCalls}
            isStreaming={message.isStreaming}
          />
        )}

        {message.toolCalls && message.toolCalls.length > 0 && (
          <ToolCallRenderer
            toolCalls={message.toolCalls}
            conversationId={conversation.id}
            projectPath={conversation.projectPath}
          />
        )}

        {message.content && (
          <div className="px-3 py-2 bg-bg-secondary rounded text-xs">
            <MarkdownRenderer
              content={message.content}
              className="text-xs leading-relaxed"
            />
            {message.isStreaming && (
              <span className="inline-block w-1.5 h-3.5 bg-accent-green/70 rounded-sm animate-pulse ml-1 align-text-bottom" />
            )}
          </div>
        )}

        {message.isStreaming && !message.content && (
          <div className="flex items-center gap-1.5 px-3 py-2 bg-bg-secondary rounded text-ui text-text-muted">
            <Spinner size={10} className="text-accent-green" label="Responding" />
            Responding...
          </div>
        )}

        <div className="flex items-center gap-2">
          <AssistantTokenPill message={message} />
          {isLastAssistant && !message.isStreaming && onRetry && (
            <Tooltip content="Retry this turn">
              <button
                type="button"
                onClick={onRetry}
                className="text-text-muted hover:text-text-primary text-meta p-0.5 rounded transition-colors"
              >
                <RotateCw size={11} />
              </button>
            </Tooltip>
          )}
          {!message.isStreaming && message.content && conversation.projectPath && (
            <Tooltip content={captured ? "Saved to memory" : "Add this turn to project memory"}>
              <button
                type="button"
                disabled={captured}
                onClick={() => {
                  captureManually(buildTranscriptMemoryInput(message, conversation));
                  setCaptured(true);
                }}
                className="text-text-muted hover:text-accent-green text-meta p-0.5 rounded transition-colors disabled:text-accent-green"
              >
                <BookmarkPlus size={11} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

// Per-turn token count. This used to reveal the turn's USD cost on hover; that
// went with the rest of the cost reporting surface on 2026-07-31. The token
// count stays — it is the measurement the prompt-caching work needs, and it
// costs nothing (the numbers are already on the message).
function AssistantTokenPill({ message }: { message: AgentMessage }) {
  const { inputTokens, outputTokens } = message;
  if (inputTokens == null || outputTokens == null) return null;
  return <div className="text-meta text-text-muted font-mono">{inputTokens + outputTokens} tok</div>;
}

