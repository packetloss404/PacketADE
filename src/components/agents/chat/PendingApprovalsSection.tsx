import { PendingApprovalsRollup } from "../PendingApprovalsRollup";
import { PendingEditPrompt } from "../PendingEditPrompt";
import { PermissionPrompt } from "../PermissionPrompt";
import { TurnDiffSummary } from "../TurnDiffSummary";
import type {
  AgentConversation,
  PendingEdit,
  PendingPermission,
} from "@/types/agent-conversation";
import type { useAgentTaskStore } from "@/stores/agentTaskStore";
import type { useAgentApprovalStore } from "@/stores/agentApprovalStore";

type TaskStore = ReturnType<typeof useAgentTaskStore.getState>;
type ApprovalStore = ReturnType<typeof useAgentApprovalStore.getState>;

interface PendingApprovalsSectionProps {
  conversation: AgentConversation;
  conversationId: string;
  pendingEdits: PendingEdit[];
  pendingPermissions: PendingPermission[];
  respondEdit: ApprovalStore["respondEdit"];
  respondPermission: ApprovalStore["respondPermission"];
  cancelPendingTools: ApprovalStore["cancelPendingTools"];
  appendAllowedToolPattern: TaskStore["appendAllowedToolPattern"];
}

export function PendingApprovalsSection({
  conversation,
  conversationId,
  pendingEdits,
  pendingPermissions,
  respondEdit,
  respondPermission,
  cancelPendingTools,
  appendAllowedToolPattern,
}: PendingApprovalsSectionProps) {
  // `||` (not `??`) — both fields are arrays which are non-nullish even when
  // empty, so `??` would short-circuit. `||` renders the section when EITHER
  // has at least one item.
  if (pendingEdits.length === 0 && pendingPermissions.length === 0) {
    return null;
  }

  const applyAllEdits = () => {
    for (const item of pendingEdits) {
      void respondEdit(conversationId, item.id, "apply");
    }
  };
  const rejectAllEdits = () => {
    for (const item of pendingEdits) {
      void respondEdit(conversationId, item.id, "reject");
    }
  };
  const allowAllPermissions = () => {
    for (const item of pendingPermissions) {
      void respondPermission(conversationId, item.id, "allow_once");
    }
  };
  const denyAllPermissions = () => {
    for (const item of pendingPermissions) {
      void respondPermission(conversationId, item.id, "deny");
    }
  };

  return (
    <div className="shrink-0 px-3 py-2 flex flex-col gap-2 border-t border-bg-border bg-bg-primary">
      <TurnDiffSummary
        conversationId={conversationId}
        pendingEdits={pendingEdits}
        onApplyAll={applyAllEdits}
        onDiscardAll={rejectAllEdits}
      />
      <PendingApprovalsRollup
        pendingEdits={pendingEdits}
        pendingPermissions={pendingPermissions}
        onApplyAllEdits={applyAllEdits}
        onRejectAllEdits={rejectAllEdits}
        onAllowAllPermissions={allowAllPermissions}
        onDenyAllPermissions={denyAllPermissions}
        onCancelAllPending={() => void cancelPendingTools(conversationId)}
      />
      {pendingEdits.map((item) => (
        <PendingEditPrompt
          key={item.id}
          item={item}
          projectPath={conversation.projectPath}
          conversationId={conversationId}
          onApply={(toolId, mergedContent) =>
            void respondEdit(conversationId, toolId, "apply", mergedContent)
          }
          onReject={(toolId) =>
            void respondEdit(conversationId, toolId, "reject")
          }
        />
      ))}
      {pendingPermissions.map((item) => (
        <PermissionPrompt
          key={item.id}
          item={item}
          conversationAllowedTools={conversation.allowedTools}
          onAllowOnce={(toolId) =>
            void respondPermission(conversationId, toolId, "allow_once")
          }
          onAllowAlways={(toolId) =>
            void respondPermission(conversationId, toolId, "allow_always")
          }
          onDeny={(toolId) =>
            void respondPermission(conversationId, toolId, "deny")
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
