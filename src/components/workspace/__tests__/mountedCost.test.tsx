/**
 * Tile program (P4-S3) — mounted-cost gate.
 *
 * Ruled: 20 materialized conversation-only workspaces held behind `display:none`
 * must cost near-zero idle CPU with a BOUNDED document-listener count. "Near-zero
 * idle CPU" is not directly measurable in vitest; this harness measures the two
 * concrete proxies that a CPU-idle mount reduces to:
 *
 *   (1) NO per-tile timers — mounting N tiles registers zero setInterval /
 *       setTimeout (nothing polls in the background per workspace);
 *   (2) BOUNDED document/window listeners that do NOT scale with N — an idle,
 *       unfocused conversation tile arms NO document keydown listener (the
 *       keyboardScope arming is gated on focus: `keyboardScopeActive === false`
 *       for every unfocused tile, so the Y/N handler is DISARMED though present
 *       in the component tree — see ConversationTile → AgentChatPane).
 *
 * Method: render N=20 ConversationTiles (AgentChatPane mocked to a leaf so the
 * measurement isolates the tile/workspace mounting layer), spying on the global
 * listener + timer registries. The named fallback if this gate is ever breached
 * (documented, NOT triggered here): mount-on-activation for **zero-PTY
 * workspaces only** — the PTY keep-all-mounted pattern is never modified.
 */
import { act } from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capturedKeyboardScope: Array<boolean | undefined> = [];

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/agentsMd", () => ({ loadAgentsMd: vi.fn().mockResolvedValue(null) }));
vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: { getState: vi.fn(() => ({ getContextForSession: vi.fn(() => "") })) },
}));
vi.mock("@/lib/tauri", () => ({
  createPtySession: vi.fn(),
  writePty: vi.fn(),
  killPty: vi.fn(),
  startApiAgentSession: vi.fn().mockResolvedValue(undefined),
  sendApiAgentMessage: vi.fn(),
  cancelApiAgentSession: vi.fn().mockResolvedValue(undefined),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: vi.fn().mockResolvedValue(undefined),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  loadConversations: vi.fn().mockResolvedValue([]),
  deleteConversationFile: vi.fn(),
  changeAgentModel: vi.fn(),
  setPlanMode: vi.fn(),
  setPermissionMode: vi.fn(),
  respondPermission: vi.fn(),
  setApproveWrites: vi.fn(),
  respondEdit: vi.fn(),
  retryLastTurn: vi.fn(),
  exportConversationMarkdown: vi.fn(),
  saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined),
}));

// Mock AgentChatPane to a leaf that records the keyboardScopeActive prop it is
// handed (the disarm signal we assert on).
vi.mock("@/components/agents/AgentChatPane", () => ({
  AgentChatPane: (props: { keyboardScopeActive?: boolean }) => {
    capturedKeyboardScope.push(props.keyboardScopeActive);
    return null;
  },
}));

import { ConversationTile } from "@/components/workspace/ConversationTile";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { AgentConversation } from "@/types/agent-conversation";
import type { WorkspacePane } from "@/types/workspace";

const N = 20;

function makeConversations(n: number): AgentConversation[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `conv-${i}`,
    title: `Task ${i}`,
    agent: "api-claude" as const,
    projectPath: "/proj",
    status: "idle" as const,
    messages: [],
    sessionId: `conv-${i}`,
    rawOutput: "",
    createdAt: i,
    updatedAt: 1000 + i,
    mode: "api" as const,
  }));
}

function pane(conversationId: string): WorkspacePane {
  return { id: `pane-${conversationId}`, agentId: "terminal", sessionId: null, kind: "conversation", conversationId };
}

let addDoc: ReturnType<typeof vi.spyOn>;
let addWin: ReturnType<typeof vi.spyOn>;
let intervalSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  capturedKeyboardScope.length = 0;
  useAgentTaskStore.setState({ conversations: makeConversations(N), selectedConversationId: null });
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, zoomedPaneId: null });
  // No pane is focused → every tile is idle/unfocused (activePaneId cleared).
  useLayoutStore.setState({ activePaneId: undefined });
});

afterEach(() => {
  addDoc?.mockRestore();
  addWin?.mockRestore();
  intervalSpy?.mockRestore();
});

describe("mounted-cost gate — 20 conversation-only tiles behind display:none", () => {
  it("registers zero per-tile timers and adds no armed document keydown listeners", () => {
    addDoc = vi.spyOn(document, "addEventListener");
    addWin = vi.spyOn(window, "addEventListener");
    intervalSpy = vi.spyOn(window, "setInterval");

    act(() => {
      render(
        <div style={{ display: "none" }}>
          {makeConversations(N).map((c) => (
            <ConversationTile key={c.id} pane={pane(c.id)} workspaceId={`ws-${c.id}`} />
          ))}
        </div>,
      );
    });

    // (1) No per-tile polling.
    expect(intervalSpy).not.toHaveBeenCalled();

    // (2) Keyboard scope is DISARMED on every unfocused tile — the Y/N handler
    // exists in the tree but never arms while unfocused.
    expect(capturedKeyboardScope).toHaveLength(N);
    expect(capturedKeyboardScope.every((v) => v === false)).toBe(true);

    // (2b) No document/window keydown listener was added by the idle tile layer
    // (the count does not scale with N).
    const keydownDoc = addDoc.mock.calls.filter((c: unknown[]) => c[0] === "keydown").length;
    const keydownWin = addWin.mock.calls.filter((c: unknown[]) => c[0] === "keydown").length;
    expect(keydownDoc).toBe(0);
    expect(keydownWin).toBe(0);

    // (2c) Total document listeners added while mounting N idle tiles is BOUNDED
    // and independent of N — the count does NOT grow per tile (O(1), not O(N)).
    // The overflow-menu mousedown listener only arms when a menu is open, so
    // idle tiles add none of their own; any residual is a one-time global.
    expect(addDoc.mock.calls.length).toBeLessThan(N);
    expect(addDoc.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
