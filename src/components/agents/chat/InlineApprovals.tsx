import { PendingApprovalsRollup } from "../PendingApprovalsRollup";
import { PermissionPrompt } from "../PermissionPrompt";
import type { PendingPermission } from "@/types/agent-conversation";
import type { useAgentTaskStore } from "@/stores/agentTaskStore";
import type { useAgentApprovalStore } from "@/stores/agentApprovalStore";

type TaskStore = ReturnType<typeof useAgentTaskStore.getState>;
type ApprovalStore = ReturnType<typeof useAgentApprovalStore.getState>;

/**
 * Everything the transcript needs to render approvals inline. Threaded as ONE
 * prop through `MessageList` so the list's signature does not grow a limb per
 * store action, and so `undefined` is the single, honest expression of "this
 * session cannot approve per tool" (`caps.canApprovePerTool`).
 */
export interface InlineApprovalsBinding {
  /** Every pending permission for the conversation, in queue order. */
  permissions: PendingPermission[];
  respondPermission: ApprovalStore["respondPermission"];
  appendAllowedToolPattern: TaskStore["appendAllowedToolPattern"];
}

interface InlineApprovalsProps {
  conversationId: string;
  /** `conversation.allowedTools` — drives the "always allow <pattern>" scope. */
  conversationAllowedTools?: string[];
  binding: InlineApprovalsBinding;
  /** The slice of the queue that belongs at THIS point in the transcript. */
  permissions: PendingPermission[];
  /**
   * True for the slice that owns the head of the queue. The batch rollup is
   * rendered once, above the first card — it acts on the whole queue, so a
   * copy at every call site would be three "Deny all" buttons that all do the
   * same thing.
   */
  leading: boolean;
  /** Head of the queue — the Y/N keyboard target, wherever it is rendered. */
  topPermissionId?: string;
}

/**
 * B3 — the approval cards, rendered INLINE in the timeline at the call site.
 *
 * They used to live in a footer band below the transcript (the old
 * `PendingApprovalsSection` body), which detached the question from the tool
 * call that raised it: a stacked queue read as a list of anonymous demands with
 * no way to see what each one was for without scrolling elsewhere.
 *
 * This component is PRESENTATION ONLY. The document-level Y/N handler, its
 * typing-context guards and the per-tile `keyboardScopeActive` focus gate all
 * stay in `PendingApprovalsSection` — exactly one of them may be live per tile,
 * so the effect never moves and is never duplicated here.
 */
export function InlineApprovals({
  conversationId,
  conversationAllowedTools,
  binding,
  permissions,
  leading,
  topPermissionId,
}: InlineApprovalsProps) {
  const { respondPermission, appendAllowedToolPattern } = binding;
  if (permissions.length === 0) return null;

  const allowAllPermissions = () => {
    for (const item of binding.permissions) {
      void respondPermission(conversationId, item.id, "allow_once");
    }
  };
  const denyAllPermissions = () => {
    for (const item of binding.permissions) {
      void respondPermission(conversationId, item.id, "deny");
    }
  };

  return (
    <div
      role="group"
      aria-label="Pending approvals"
      aria-live="polite"
      className="flex flex-col gap-2"
    >
      {leading && (
        <PendingApprovalsRollup
          pendingPermissions={binding.permissions}
          onAllowAllPermissions={allowAllPermissions}
          onDenyAllPermissions={denyAllPermissions}
        />
      )}
      {permissions.map((item) => (
        <PermissionPrompt
          key={item.id}
          item={item}
          conversationAllowedTools={conversationAllowedTools}
          // Hints attach to the head of the queue only — that's the Y/N target.
          showKeyboardHints={item.id === topPermissionId}
          onAllowOnce={(toolId) =>
            void respondPermission(conversationId, toolId, "allow_once")
          }
          onAllowAlways={(toolId) =>
            void respondPermission(conversationId, toolId, "allow_always")
          }
          onDeny={(toolId, reason) =>
            void respondPermission(conversationId, toolId, "deny", reason)
          }
          onAllowAlwaysWithPattern={(toolId, pattern) => {
            void respondPermission(conversationId, toolId, "allow_always");
            appendAllowedToolPattern(conversationId, pattern);
          }}
        />
      ))}
    </div>
  );
}
