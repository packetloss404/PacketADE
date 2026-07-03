import { listen } from "@tauri-apps/api/event";
import {
  apiAgentChunkEvent,
  apiAgentToolStartEvent,
  apiAgentToolResultEvent,
  apiAgentDoneEvent,
  apiAgentErrorEvent,
  apiAgentThinkingEvent,
  apiAgentThinkingStopEvent,
  apiAgentPermissionRequestEvent,
  apiAgentPendingEditEvent,
  apiAgentEditBaselineEvent,
  apiAgentPlanBlockEvent,
  apiAgentToolOutputExtendedEvent,
  apiAgentTurnSummaryEvent,
} from "@/lib/events";
import { generateId } from "@/lib/storage";
import { toProjectRelativePath } from "@/lib/parseToolInput";
import { classifyToolTier, decideApprovalGate } from "@/lib/approvalTiers";
// Pure util module (no React) — deriveMode is P0-4's one bijection over the
// conversation's permission flags and stays the single source of truth for
// what posture a session is in.
import { deriveMode } from "@/components/agents/agentModeChipUtils";
import { createStreamCoalescer } from "@/lib/streamCoalescer";
import { sendApiAgentMessage } from "@/lib/tauri";
import { estimateTurnCostUsd } from "@/lib/conversationCost";
import { looksLikeRateLimit, pickFailoverModel } from "@/lib/autoFailover";
import {
  notifySessionComplete,
  notifySessionError,
  notifyApprovalNeeded,
} from "@/lib/notifications";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useEditBaselineStore } from "@/stores/editBaselineStore";
import { useAgentPlanStore } from "@/stores/agentPlanStore";
import { useAgentStreamingStore } from "@/stores/agentStreamingStore";
import {
  useAgentTaskStore,
  requestConversationSave,
  failoverGuard,
  failTurn,
} from "@/stores/agentTaskStore";
import type {
  AgentConversation,
  AgentMessage,
  AgentPlanItem,
  AgentToolCall,
  PendingPermission,
  PendingEdit,
} from "@/types/agent-conversation";

function sendPromotedQueuedMessage(
  conversationId: string,
  content: string,
  afterMessageId: string,
): void {
  const setState = useAgentTaskStore.setState;
  const getState = useAgentTaskStore.getState;
  if (!getState().conversations.some((c) => c.id === conversationId)) return;

  failoverGuard.delete(conversationId);

  const assistantMsg: AgentMessage = {
    id: generateId("msg"),
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    isStreaming: true,
  };

  let updated = false;
  setState((s) => ({
    conversations: s.conversations.map((c) => {
      if (c.id !== conversationId) return c;
      let inserted = false;
      const messages: AgentMessage[] = [];
      for (const message of c.messages) {
        messages.push(message);
        if (!inserted && message.id === afterMessageId) {
          messages.push(assistantMsg);
          inserted = true;
        }
      }
      if (!inserted) messages.push(assistantMsg);
      updated = true;
      return {
        ...c,
        messages,
        status: "active",
        updatedAt: Date.now(),
      };
    }),
  }));
  if (updated) requestConversationSave(conversationId);

  void sendApiAgentMessage(conversationId, content, undefined).catch((err) => {
    // failTurn also clears the streaming placeholder we just inserted —
    // previously this only flipped status to "failed", leaving the assistant
    // bubble spinning forever.
    failTurn(conversationId, assistantMsg.id, err);
  });
}

/**
 * Install the full set of `api-agent:*` event listeners for a session.
 * Returns an unlisten function that detaches every listener registered here.
 *
 * The cleanup map (`apiConversationCleanup`) and its semantics live in
 * `agentTaskStore` — this module is purely the listener wiring. Idempotency
 * is enforced by the caller, which only invokes this once per conversation
 * and stores the returned unlisten fn in that map.
 *
 * Both backends (in-process `LlmProvider` + Node sidecar) emit the same
 * `api-agent:{kind}:{sessionId}` events, so this single handler set covers
 * every provider.
 */
export async function installApiAgentListeners(conversationId: string): Promise<() => void> {
  const id = conversationId;
  const setState = useAgentTaskStore.setState;
  const getState = useAgentTaskStore.getState;

  // rAF-coalesced application of streaming deltas. Token/thinking events can
  // arrive dozens of times per second, and writing the store per event
  // rebuilt the conversations array (and re-ran every subscribed selector)
  // once per token. Buffer the deltas and land at most one store write + one
  // save request per frame, replacing only this conversation's entry instead
  // of remapping the whole array. done/error/thinking-stop call `flushNow()`
  // first so a settling turn never loses or reorders tail chunks.
  const coalescer = createStreamCoalescer(({ content, thinking }) => {
    if (thinking) {
      useAgentStreamingStore.getState().appendThinking(id, thinking);
    }
    const conversations = getState().conversations;
    const index = conversations.findIndex((c) => c.id === id);
    if (index === -1) return;
    const conv = conversations[index];
    let touched = false;
    const messages = conv.messages.map((m) => {
      if (m.isStreaming && m.role === "assistant") {
        touched = true;
        return {
          ...m,
          content: content ? m.content + content : m.content,
          thinking: thinking ? (m.thinking ?? "") + thinking : m.thinking,
        };
      }
      return m;
    });
    if (!touched) return;
    const next = [...conversations];
    next[index] = { ...conv, messages, updatedAt: Date.now() };
    setState({ conversations: next });
    requestConversationSave(id);
  });

  const chunkUnlisten = await listen<string>(apiAgentChunkEvent(id), (event) => {
    coalescer.pushContent(event.payload);
  });

  // `input` (raw tool-input JSON) arrives with tool_start on the sidecar
  // path (Claude Code / Codex forward it at tool_use time) and with
  // tool_result on the in-process path. Stash whichever arrives so the
  // transcript edit layer can parse Write/Edit/apply_patch calls.
  const toolStartUnlisten = await listen<{
    id: string;
    name: string;
    input?: string | null;
  }>(
    apiAgentToolStartEvent(id),
    (event) => {
      let touched = false;
      setState((s) => ({
        conversations: s.conversations.map((c) => {
          if (c.id !== id) return c;
          const messages = c.messages.map((m) => {
            if (m.isStreaming && m.role === "assistant") {
              const toolCalls: AgentToolCall[] = [
                ...(m.toolCalls ?? []),
                {
                  id: event.payload.id,
                  name: event.payload.name,
                  status: "running" as const,
                  input: event.payload.input ?? undefined,
                },
              ];
              return { ...m, toolCalls };
            }
            return m;
          });
          touched = true;
          return { ...c, messages, updatedAt: Date.now() };
        }),
      }));
      if (touched) requestConversationSave(id);
    },
  );

  const toolResultUnlisten = await listen<{
    id: string;
    name: string;
    content: string;
    is_error: boolean;
    input: string;
  }>(apiAgentToolResultEvent(id), (event) => {
    let touched = false;
    setState((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const messages = c.messages.map((m) => {
          if (m.isStreaming && m.role === "assistant" && m.toolCalls) {
            const toolCalls = m.toolCalls.map((tc) =>
              tc.id === event.payload.id
                ? {
                    ...tc,
                    status: (event.payload.is_error ? "error" : "done") as AgentToolCall["status"],
                    summary: event.payload.content.slice(0, 200),
                    fullContent: event.payload.content,
                    // Sidecar results don't echo the input; keep the copy
                    // captured at tool_start instead of clobbering it with "".
                    input: event.payload.input || tc.input,
                  }
                : tc,
            );
            return { ...m, toolCalls };
          }
          return m;
        });
        touched = true;
        return { ...c, messages, updatedAt: Date.now() };
      }),
    }));
    if (touched) requestConversationSave(id);
  });

  const doneUnlisten = await listen<{
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    resume_token?: string | null;
  }>(apiAgentDoneEvent(id), (event) => {
    // Land any buffered stream deltas before flipping isStreaming off —
    // otherwise the pending frame would find no streaming message and the
    // turn's tail chunks would be lost.
    coalescer.flushNow();
    let updated: AgentConversation | undefined;
    let nextQueued: string | undefined;
    let promotedQueuedMessageId: string | undefined;
    setState((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const messages = c.messages.map((m) =>
          m.isStreaming
            ? {
                ...m,
                isStreaming: false,
                inputTokens: event.payload.input_tokens,
                outputTokens: event.payload.output_tokens,
                cacheReadTokens: event.payload.cache_read_input_tokens,
                cacheWriteTokens: event.payload.cache_creation_input_tokens,
                // Stamp the estimated USD cost at receipt time so render
                // surfaces never need per-message IPC (undefined when the
                // model has no pricing entry). Reasoning tokens landed on
                // the message via earlier turn-summary events.
                costUsd:
                  estimateTurnCostUsd(c.model, {
                    inputTokens: event.payload.input_tokens,
                    outputTokens: event.payload.output_tokens,
                    cacheReadTokens: event.payload.cache_read_input_tokens,
                    reasoningTokens: m.reasoningTokens,
                  }) ?? undefined,
              }
            : m,
        );
        const queued = c.queuedMessages ?? [];
        let remainingQueued = queued;
        const shouldDrainQueued = queued.length > 0;
        if (queued.length > 0) {
          nextQueued = queued[0];
          remainingQueued = queued.slice(1);
        }
        let promotedDrainingBubble = false;
        const visibleMessages = shouldDrainQueued
          ? messages.map((m) => {
              if (!promotedDrainingBubble && m.queued) {
                promotedDrainingBubble = true;
                promotedQueuedMessageId = m.id;
                return { ...m, queued: undefined };
              }
              return m;
            })
          : messages;
        const newResume = event.payload.resume_token ?? c.resumeToken;
        const next: AgentConversation = {
          ...c,
          messages: visibleMessages,
          status: "idle",
          updatedAt: Date.now(),
          queuedMessages: remainingQueued,
          resumeToken: newResume ?? undefined,
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) requestConversationSave(id);
    // Turn done — reset transient streaming state. Reasoning text already
    // landed on the assistant message; the live delta buffer is now stale.
    useAgentStreamingStore.getState().clearThinking(id);
    if (nextQueued !== undefined) {
      const drained = nextQueued;
      const afterMessageId = promotedQueuedMessageId;
      setTimeout(() => {
        if (afterMessageId) {
          sendPromotedQueuedMessage(id, drained, afterMessageId);
        } else {
          getState().sendMessage(id, drained);
        }
      }, 0);
    }
    if (updated && getState().selectedConversationId !== id) {
      // Route through the pref-gated helper so desktop notifications honor the
      // user's notificationStore settings (enabled / onlyWhenUnfocused /
      // onSessionComplete / per-session debounce) instead of bypassing them.
      void notifySessionComplete(id, updated.title);
    }
  });

  const errorUnlisten = await listen<{ message: string }>(apiAgentErrorEvent(id), (event) => {
    // Same as `done`: buffered deltas must land while the message is still
    // streaming, and before any failover retry forks the transcript.
    coalescer.flushNow();
    const conv = getState().conversations.find((c) => c.id === id);
    if (
      conv &&
      conv.mode === "api" &&
      conv.model &&
      useAgentSettingsStore.getState().autoFailoverEnabled &&
      !failoverGuard.has(id) &&
      looksLikeRateLimit(event.payload.message)
    ) {
      const fallback = pickFailoverModel(conv.model);
      if (fallback && fallback !== conv.model) {
        failoverGuard.add(id);
        const noticeMsg: AgentMessage = {
          id: generateId("msg"),
          role: "system",
          content: `(auto-failover: ${conv.model} hit "${event.payload.message.slice(0, 80)}" — retrying on ${fallback})`,
          timestamp: Date.now(),
        };
        setState((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id
              ? {
                  ...c,
                  messages: [...c.messages, noticeMsg],
                  updatedAt: Date.now(),
                }
              : c,
          ),
        }));
        void getState().retryLastTurn(id, fallback);
        return;
      }
    }

    let updated: AgentConversation | undefined;
    setState((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const messages = c.messages.map((m) =>
          m.isStreaming
            ? {
                ...m,
                isStreaming: false,
                content: m.content + `\n\nError: ${event.payload.message}`,
              }
            : m,
        );
        const next = {
          ...c,
          messages,
          status: "failed" as const,
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) requestConversationSave(id);
    if (updated) {
      // Pref-gated error notification (honors onSessionError + debounce).
      void notifySessionError(id, updated.title);
    }
  });

  const thinkingUnlisten = await listen<{ text: string }>(apiAgentThinkingEvent(id), (event) => {
    // Reasoning deltas accumulate in agentStreamingStore (ephemeral) and
    // mirror onto the streaming assistant message's `thinking` field so the
    // persisted transcript keeps the full chain of thought — both applied
    // per-frame by the coalescer above.
    coalescer.pushThinking(event.payload.text);
  });

  const thinkingStopUnlisten = await listen<unknown>(apiAgentThinkingStopEvent(id), () => {
    // Flush so the final buffered reasoning deltas land on the message (and
    // in the live store) before the live buffer is cleared.
    coalescer.flushNow();
    useAgentStreamingStore.getState().clearThinking(id);
  });

  const permissionReqUnlisten = await listen<PendingPermission>(
    apiAgentPermissionRequestEvent(id),
    (event) => {
      // Gate on conversation existence: if the conversation was deleted
      // mid-flight, dropping the prompt and skipping the task wake-up is
      // the right behavior. agentApprovalStore.addPendingPermission also
      // fires the orchestrator `approval_needed` flip internally.
      const conv = getState().conversations.find((c) => c.id === id);
      if (!conv) return;
      // P1-9 tiered gating: read/search tools never prompt; in-project
      // edits auto-apply into the post-hoc review bar (baselines from
      // P1-7, surface from P1-8). Only shell/network/out-of-project
      // requests fall through to a blocking prompt. The mode chip rules:
      // tiering applies under Default/yolo, reads-only under manual, and
      // plan / deny-risky postures keep every prompt.
      const tier = classifyToolTier(
        event.payload.name,
        event.payload.arguments,
        conv.projectPath,
      );
      if (decideApprovalGate(deriveMode(conv), tier) === "auto_allow") {
        void useAgentApprovalStore
          .getState()
          .autoAllowPermission(id, event.payload.id);
        return;
      }
      useAgentApprovalStore.getState().addPendingPermission(id, event.payload);
      // Long autonomous runs pause here for approval — ping the user (pref-gated
      // + per-session debounced) so they know an unattended run needs them.
      void notifyApprovalNeeded(id, conv.title);
    },
  );

  const pendingEditUnlisten = await listen<PendingEdit>(apiAgentPendingEditEvent(id), (event) => {
    const conv = getState().conversations.find((c) => c.id === id);
    if (!conv) return;
    // Gated writes carry their pre-edit baseline on `before` — record it so
    // review surfaces diff against the true "before" after the edit applies.
    // Both the baseline key AND the stored pending edit are keyed project-
    // relative: the runtimes emit raw tool paths (absolute for Claude Code /
    // Codex), while the transcript edit layer keys descriptors project-
    // relative — the review surface dedupes, deep-links and displays pending
    // edits against those keys, so a raw absolute path would render the same
    // file twice and double-count it.
    const relativePath = toProjectRelativePath(
      event.payload.path,
      conv.projectPath,
    );
    useEditBaselineStore
      .getState()
      .recordBaseline(
        id,
        relativePath,
        event.payload.before ?? null,
        event.payload.id,
      );
    useAgentApprovalStore
      .getState()
      .addPendingEdit(id, { ...event.payload, path: relativePath });
    void notifyApprovalNeeded(id, conv.title);
  });

  // P1-7: non-blocking baseline capture for auto-applied writes (approve-
  // writes off). Every edit-bearing tool call stores the pre-edit file
  // content; `before` is null/absent when the file did not exist. Keys are
  // project-relative to match the canonical edit descriptors.
  const editBaselineUnlisten = await listen<{
    id: string;
    path: string;
    before?: string | null;
  }>(apiAgentEditBaselineEvent(id), (event) => {
    const conv = getState().conversations.find((c) => c.id === id);
    if (!conv) return;
    useEditBaselineStore
      .getState()
      .recordBaseline(
        id,
        toProjectRelativePath(event.payload.path, conv.projectPath),
        event.payload.before ?? null,
        event.payload.id,
      );
  });

  const planBlockUnlisten = await listen<{ items: AgentPlanItem[] }>(
    apiAgentPlanBlockEvent(id),
    (event) => {
      // setPlan now requests its own conversation save (snapshotForPersist
      // reads the plan back out of agentPlanStore), so no extra save here.
      useAgentPlanStore.getState().setPlan(id, event.payload.items);
    },
  );

  // F6: live token totals between turns. Update the streaming assistant
  // message's tokens so SessionMetaLine / cost pills reflect mid-stream
  // usage instead of waiting for the final `done` payload. A2: also
  // forward `reasoning_tokens` (Codex 0.125+) so CostDashboard accounts
  // for GPT-5.5's reasoning slice. A3: when `address` is set (Codex
  // MultiAgentV2 sub-agent), accumulate into a per-address bucket on
  // the conversation INSTEAD of mutating the streaming message — the
  // root thread's tokens belong to the user-visible turn; sub-agent
  // tokens are an additive cost we surface only via aggregateConversationCost.
  const turnSummaryUnlisten = await listen<{
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    reasoning_tokens?: number | null;
    address?: string | null;
  }>(apiAgentTurnSummaryEvent(id), (event) => {
    const address = event.payload.address ?? "";
    if (address.length > 0) {
      // Sub-agent: replace the bucket in agentStreamingStore (Codex emits
      // cumulative totals). conversationCost.ts reads from the store.
      useAgentStreamingStore.getState().setSubAgentBucket(id, address, {
        inputTokens: event.payload.input_tokens,
        outputTokens: event.payload.output_tokens,
        reasoningTokens: event.payload.reasoning_tokens ?? 0,
        cacheReadTokens: event.payload.cache_read_input_tokens,
      });
      return;
    }
    // Root thread: mutate the streaming message as before.
    let touched = false;
    setState((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const messages = c.messages.map((m) =>
          m.isStreaming && m.role === "assistant"
            ? {
                ...m,
                inputTokens: event.payload.input_tokens,
                outputTokens: event.payload.output_tokens,
                cacheReadTokens: event.payload.cache_read_input_tokens,
                cacheWriteTokens: event.payload.cache_creation_input_tokens,
                reasoningTokens: event.payload.reasoning_tokens ?? m.reasoningTokens,
                costUsd:
                  estimateTurnCostUsd(c.model, {
                    inputTokens: event.payload.input_tokens,
                    outputTokens: event.payload.output_tokens,
                    cacheReadTokens: event.payload.cache_read_input_tokens,
                    reasoningTokens:
                      event.payload.reasoning_tokens ?? m.reasoningTokens,
                  }) ?? undefined,
              }
            : m,
        );
        touched = true;
        return { ...c, messages, updatedAt: Date.now() };
      }),
    }));
    if (touched) requestConversationSave(id);
  });

  // F5: structured tool metadata — exit code / modified paths / stdout /
  // stderr — arrives after the matching tool_result. Merge into the
  // already-rendered tool call so the chat surface can show exit code etc.
  const toolOutputExtendedUnlisten = await listen<{
    id: string;
    exit_code?: number | null;
    modified_paths?: string[] | null;
    stdout?: string | null;
    stderr?: string | null;
  }>(apiAgentToolOutputExtendedEvent(id), (event) => {
    let touched = false;
    setState((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const messages = c.messages.map((m) => {
          if (!m.toolCalls) return m;
          let mutated = false;
          const toolCalls = m.toolCalls.map((tc) => {
            if (tc.id !== event.payload.id) return tc;
            mutated = true;
            return {
              ...tc,
              exitCode: event.payload.exit_code ?? tc.exitCode,
              modifiedPaths: event.payload.modified_paths ?? tc.modifiedPaths,
              stdout: event.payload.stdout ?? tc.stdout,
              stderr: event.payload.stderr ?? tc.stderr,
            };
          });
          return mutated ? { ...m, toolCalls } : m;
        });
        touched = true;
        return { ...c, messages, updatedAt: Date.now() };
      }),
    }));
    if (touched) requestConversationSave(id);
  });

  return () => {
    coalescer.dispose();
    chunkUnlisten();
    toolStartUnlisten();
    toolResultUnlisten();
    doneUnlisten();
    errorUnlisten();
    thinkingUnlisten();
    thinkingStopUnlisten();
    permissionReqUnlisten();
    pendingEditUnlisten();
    editBaselineUnlisten();
    planBlockUnlisten();
    toolOutputExtendedUnlisten();
    turnSummaryUnlisten();
  };
}
