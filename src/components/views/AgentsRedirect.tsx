import { useEffect } from "react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAppStore } from "@/stores/appStore";
import { focusConversationDeepLink } from "@/stores/sessionGlue";

/**
 * Tile program (P5-S1): the one-release redirect shim for the retired
 * `"agents"` CoreView. AgentsView is gone from every user-reachable entry
 * point; this shim is the ONLY remaining render path for `activeView === "agents"`
 * and it exists purely to catch stragglers:
 *
 *   - a persisted `activeView='agents'` cold start, and
 *   - stale notification deep links minted before the cutover.
 *
 * On mount it resolves `agentTaskStore.selectedConversationId` through the same
 * materializing `openSession` path the fleet sidebar uses, landing on a REAL
 * workspace with the conversation's tile focused+flashed — never a blank view.
 * With no selection (or a stale id that no longer resolves), it falls through
 * to the Workspace surface. Deleted a release from now along with the `"agents"`
 * CoreView literal.
 */
export function AgentsRedirect() {
  useEffect(() => {
    const selectedId = useAgentTaskStore.getState().selectedConversationId;
    if (selectedId) {
      focusConversationDeepLink(selectedId);
    } else {
      useAppStore.getState().setActiveView("workspace");
    }
  }, []);

  // The redirect is instantaneous (a mount effect); render nothing meanwhile so
  // no blank Agents chrome ever flashes.
  return null;
}
