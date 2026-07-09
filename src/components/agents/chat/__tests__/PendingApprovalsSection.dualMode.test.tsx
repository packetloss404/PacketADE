/**
 * PendingApprovalsSection — P3-S1 dual-mode Y/N focus gate.
 *
 * The blocking Allow/Deny permission prompts carry a PROTECTED document-level
 * Y/N shortcut for the top prompt. P3-S1 adds ONLY an arming condition:
 *
 *   - no pane context (keyboardScopeActive undefined)  → armed exactly as
 *     today (standalone AgentsView byte-identical);
 *   - pane context (keyboardScopeActive defined)       → armed iff true, so
 *     only the focused conversation tile answers a keypress.
 *
 * The prompts themselves still render regardless of the gate — only the
 * keyboard shortcut is scoped. Child presentational components are mocked so
 * the test isolates the keydown wiring.
 */
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentConversation,
  PendingPermission,
} from "@/types/agent-conversation";

vi.mock("@/stores/appStore", () => ({
  useAppStore: (selector: (s: { commandPaletteOpen: boolean }) => unknown) =>
    selector({ commandPaletteOpen: false }),
}));

// Presentational children — irrelevant to the keyboard gate under test.
vi.mock("../../PendingApprovalsRollup", () => ({
  PendingApprovalsRollup: () => <div data-testid="rollup" />,
}));
vi.mock("../../PermissionPrompt", () => ({
  PermissionPrompt: () => <div data-testid="prompt" />,
}));
vi.mock("../CancelPendingButton", () => ({
  CancelPendingButton: () => <button type="button">cancel</button>,
}));

import { PendingApprovalsSection } from "@/components/agents/chat/PendingApprovalsSection";

const respondPermission = vi.fn().mockResolvedValue(undefined);
const cancelPendingTools = vi.fn();
const appendAllowedToolPattern = vi.fn();

function makePermission(id: string, name = "bash"): PendingPermission {
  return { id, name, arguments: "{}" };
}

const conversation = { id: "conv-1", allowedTools: undefined } as AgentConversation;

function renderSection({
  pendingPermissions,
  keyboardScopeActive,
  conversationId = "conv-1",
}: {
  pendingPermissions: PendingPermission[];
  keyboardScopeActive?: boolean;
  conversationId?: string;
}) {
  return render(
    <PendingApprovalsSection
      conversation={{ ...conversation, id: conversationId }}
      conversationId={conversationId}
      pendingPermissions={pendingPermissions}
      respondPermission={respondPermission}
      cancelPendingTools={cancelPendingTools}
      appendAllowedToolPattern={appendAllowedToolPattern}
      keyboardScopeActive={keyboardScopeActive}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PendingApprovalsSection Y/N focus gate (P3-S1)", () => {
  it("no pane context (prop undefined) allows via Y exactly as today", () => {
    renderSection({ pendingPermissions: [makePermission("perm-1")] });
    fireEvent.keyDown(document.body, { key: "y" });
    expect(respondPermission).toHaveBeenCalledWith("conv-1", "perm-1", "allow_once");
  });

  it("no pane context denies via N exactly as today", () => {
    renderSection({ pendingPermissions: [makePermission("perm-1")] });
    fireEvent.keyDown(document.body, { key: "n" });
    expect(respondPermission).toHaveBeenCalledWith("conv-1", "perm-1", "deny");
  });

  it("pane context armed (prop true) responds to the keypress", () => {
    renderSection({
      pendingPermissions: [makePermission("perm-1")],
      keyboardScopeActive: true,
    });
    fireEvent.keyDown(document.body, { key: "y" });
    expect(respondPermission).toHaveBeenCalledWith("conv-1", "perm-1", "allow_once");
  });

  it("pane context un-armed (prop false) ignores the keypress", () => {
    renderSection({
      pendingPermissions: [makePermission("perm-1")],
      keyboardScopeActive: false,
    });
    fireEvent.keyDown(document.body, { key: "y" });
    fireEvent.keyDown(document.body, { key: "n" });
    expect(respondPermission).not.toHaveBeenCalled();
  });

  it("two mounted sections with distinct scope: one keypress reaches ONLY the armed instance", () => {
    render(
      <>
        <PendingApprovalsSection
          conversation={{ ...conversation, id: "conv-armed" }}
          conversationId="conv-armed"
          pendingPermissions={[makePermission("perm-armed")]}
          respondPermission={respondPermission}
          cancelPendingTools={cancelPendingTools}
          appendAllowedToolPattern={appendAllowedToolPattern}
          keyboardScopeActive={true}
        />
        <PendingApprovalsSection
          conversation={{ ...conversation, id: "conv-inactive" }}
          conversationId="conv-inactive"
          pendingPermissions={[makePermission("perm-inactive")]}
          respondPermission={respondPermission}
          cancelPendingTools={cancelPendingTools}
          appendAllowedToolPattern={appendAllowedToolPattern}
          keyboardScopeActive={false}
        />
      </>,
    );
    fireEvent.keyDown(document.body, { key: "y" });
    expect(respondPermission).toHaveBeenCalledTimes(1);
    expect(respondPermission).toHaveBeenCalledWith(
      "conv-armed",
      "perm-armed",
      "allow_once",
    );
  });
});
