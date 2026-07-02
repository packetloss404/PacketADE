import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { PendingApprovalsRollup } from "../PendingApprovalsRollup";
import { PermissionPrompt } from "../PermissionPrompt";
import { CancelPendingButton } from "./CancelPendingButton";
import { useAppStore } from "@/stores/appStore";
import type {
  AgentConversation,
  PendingPermission,
} from "@/types/agent-conversation";
import type { useAgentTaskStore } from "@/stores/agentTaskStore";
import type { useAgentApprovalStore } from "@/stores/agentApprovalStore";

type TaskStore = ReturnType<typeof useAgentTaskStore.getState>;
type ApprovalStore = ReturnType<typeof useAgentApprovalStore.getState>;

/** Collapse the section by default once the queue reaches this size — the
 * pending footer becomes unscrollably tall beyond ~3 stacked prompts. */
const COLLAPSE_THRESHOLD = 3;

/**
 * Blocking permission prompts (shell / network / out-of-project tools) with
 * the Allow/Deny verb pair. P1-8: gated file edits no longer render here —
 * they route into the canonical review surface (ReviewBar/ReviewSurface)
 * with Keep/Undo, so the two verb pairs are never mixed in one surface.
 * Permission prompts outrank edits for the Y/N shortcut; the ReviewBar's
 * edit handler stays passive while any permission is pending.
 */
interface PendingApprovalsSectionProps {
  conversation: AgentConversation;
  conversationId: string;
  pendingPermissions: PendingPermission[];
  respondPermission: ApprovalStore["respondPermission"];
  cancelPendingTools: ApprovalStore["cancelPendingTools"];
  appendAllowedToolPattern: TaskStore["appendAllowedToolPattern"];
}

export function PendingApprovalsSection({
  conversation,
  conversationId,
  pendingPermissions,
  respondPermission,
  cancelPendingTools,
  appendAllowedToolPattern,
}: PendingApprovalsSectionProps) {
  const totalCount = pendingPermissions.length;

  // Default collapsed when the initial render already exceeds the threshold.
  // Re-collapses only when the user explicitly chooses to; auto-expands once
  // the queue drains below the threshold so a single remaining prompt is
  // always visible.
  const [collapsed, setCollapsed] = useState(totalCount >= COLLAPSE_THRESHOLD);
  // Track whether the queue has been continuously >= threshold so we know
  // when to seed the default. Without this, going 4 → 2 → 4 would re-collapse
  // the section after the user manually expanded it.
  const wasAboveThresholdRef = useRef(totalCount >= COLLAPSE_THRESHOLD);

  useEffect(() => {
    if (totalCount < COLLAPSE_THRESHOLD) {
      // Drop below threshold: force-expand and re-arm the auto-collapse.
      if (collapsed) setCollapsed(false);
      wasAboveThresholdRef.current = false;
    } else if (!wasAboveThresholdRef.current) {
      // Crossed up through the threshold this render — apply default collapse.
      wasAboveThresholdRef.current = true;
      setCollapsed(true);
    }
  }, [totalCount, collapsed]);

  // Y/N shortcuts target the top permission prompt.
  const topPermission = pendingPermissions[0];

  const commandPaletteOpen = useAppStore((s) => s.commandPaletteOpen);

  useEffect(() => {
    if (totalCount === 0) return;
    if (collapsed) return;
    if (commandPaletteOpen) return;
    if (!topPermission) return;

    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
      }
      const key = e.key.toLowerCase();
      if (key !== "y" && key !== "n") return;
      e.preventDefault();
      if (key === "y") {
        void respondPermission(conversationId, topPermission.id, "allow_once");
      } else {
        void respondPermission(conversationId, topPermission.id, "deny");
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [
    totalCount,
    collapsed,
    commandPaletteOpen,
    topPermission,
    conversationId,
    respondPermission,
  ]);

  if (pendingPermissions.length === 0) {
    return null;
  }

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

  if (collapsed) {
    return (
      <div
        role="region"
        aria-label="Pending approvals"
        aria-live="polite"
        className="shrink-0 px-3 py-2 border-t border-bg-border bg-bg-primary"
      >
        <div className="flex items-center gap-2 rounded border border-accent-amber/40 bg-bg-secondary px-2 py-1.5">
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="flex items-center gap-1.5 flex-1 text-left text-[11px] text-text-primary hover:text-accent-amber transition-colors"
            title="Expand to review each prompt"
          >
            <ChevronRight size={12} className="text-text-secondary shrink-0" />
            <span className="font-medium">
              {totalCount} pending approval{totalCount === 1 ? "" : "s"}
            </span>
            <span className="text-text-muted">
              · press Y/N when expanded
            </span>
          </button>
          <CancelPendingButton
            pendingCount={totalCount}
            onCancel={() => void cancelPendingTools(conversationId)}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="Pending approvals"
      aria-live="polite"
      className="shrink-0 px-3 py-2 flex flex-col gap-2 border-t border-bg-border bg-bg-primary"
    >
      {totalCount >= COLLAPSE_THRESHOLD && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="flex items-center gap-1.5 flex-1 text-left text-[11px] text-text-secondary hover:text-text-primary transition-colors"
            title="Collapse approvals"
          >
            <ChevronDown size={12} className="text-text-secondary shrink-0" />
            <span>
              {totalCount} pending approval{totalCount === 1 ? "" : "s"}
            </span>
          </button>
        </div>
      )}
      <PendingApprovalsRollup
        pendingPermissions={pendingPermissions}
        onAllowAllPermissions={allowAllPermissions}
        onDenyAllPermissions={denyAllPermissions}
        onCancelAllPending={() => void cancelPendingTools(conversationId)}
      />
      {pendingPermissions.map((item, idx) => (
        <PermissionPrompt
          key={item.id}
          item={item}
          conversationAllowedTools={conversation.allowedTools}
          // Hints attach to the first permission only — that's the Y/N target.
          showKeyboardHints={idx === 0}
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
