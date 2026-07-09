/**
 * Tile program (P5-S1): the one-release redirect shim for the retired "agents"
 * CoreView. A persisted activeView='agents' cold start (or a stale deep link)
 * must resolve selectedConversationId through the materializing deep-link path
 * and NEVER render blank Agents chrome.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

const focusConversationDeepLink = vi.fn();
const setActiveView = vi.fn();
const state = { selectedConversationId: null as string | null };

vi.mock("@/stores/sessionGlue", () => ({
  focusConversationDeepLink: (...args: unknown[]) => focusConversationDeepLink(...args),
}));
vi.mock("@/stores/appStore", () => ({
  useAppStore: { getState: () => ({ setActiveView }) },
}));
vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: { getState: () => ({ selectedConversationId: state.selectedConversationId }) },
}));

import { AgentsRedirect } from "@/components/views/AgentsRedirect";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.selectedConversationId = null;
});

describe("AgentsRedirect (shim)", () => {
  it("deep-links a persisted selection onto its materialized workspace tile", () => {
    state.selectedConversationId = "conv-42";
    const { container } = render(<AgentsRedirect />);
    expect(focusConversationDeepLink).toHaveBeenCalledWith("conv-42");
    // Renders nothing — no blank Agents chrome flashes.
    expect(container.firstChild).toBeNull();
  });

  it("falls through to the Workspace surface with no selection (never blank)", () => {
    state.selectedConversationId = null;
    render(<AgentsRedirect />);
    expect(focusConversationDeepLink).not.toHaveBeenCalled();
    expect(setActiveView).toHaveBeenCalledWith("workspace");
  });
});
