/**
 * P1-5 / D5 amendment — the Files tab's advertised open path is wired.
 *
 * `AgentFilePane` has always called an optional `onSelectFile`, but
 * `AgentInspectorPane` never provided one, so a file click only copied a path
 * while Preview told the user to "open a Markdown file from the file pane".
 * Rows now open the buffer in the dock Editor, which renders `.md` through
 * MarkdownRenderer.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation } from "@/types/agent-conversation";

const agentStore = vi.hoisted(() => ({ state: { conversations: [] as AgentConversation[] } }));

vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: (selector: (state: typeof agentStore.state) => unknown) =>
    selector(agentStore.state),
}));

vi.mock("@/lib/tauri", () => ({
  readFileForDiff: vi.fn().mockResolvedValue(""),
  readFileContents: vi.fn().mockResolvedValue("# Docs heading\n\nbody"),
  writeFileContents: vi.fn().mockResolvedValue(undefined),
  listDirectory: vi.fn().mockResolvedValue([
    {
      name: "NOTES.md",
      path: "/proj/NOTES.md",
      is_dir: false,
      size: 12,
      extension: "md",
    },
  ]),
}));

import { AgentInspectorPane } from "@/components/agents/AgentInspectorPane";
import { useEditorStore } from "@/stores/editorStore";
import { useRightDockStore } from "@/stores/rightDockStore";

function makeConversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  const now = Date.now();
  return {
    id: "conv-1",
    title: "Files → editor",
    agent: "api-openai",
    projectPath: "/proj",
    status: "idle",
    messages: [],
    sessionId: "conv-1",
    rawOutput: "",
    createdAt: now,
    updatedAt: now,
    mode: "api",
    provider: "openai",
    model: "gpt-5",
    ...overrides,
  };
}

describe("Inspector Files → Editor", () => {
  beforeEach(() => {
    localStorage.clear();
    useRightDockStore.getState().reset();
    useEditorStore.setState({ openFiles: [], activeFileId: null });
    agentStore.state.conversations = [makeConversation()];
  });

  it("opens a clicked file in the dock Editor and renders Markdown", async () => {
    render(<AgentInspectorPane conversationId="conv-1" />);

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    const row = await screen.findByTitle("/proj/NOTES.md");
    fireEvent.click(row);

    // The click produced a real editor buffer scoped to the project root…
    expect(useEditorStore.getState().openFiles[0]).toMatchObject({
      path: "/proj/NOTES.md",
      workspace: "/proj",
      view: "preview",
    });
    // …and the dock swapped to the Editor panel.
    expect(useRightDockStore.getState().surfaces.agents.activePanel).toBe("editor");

    // …which renders the Markdown rather than raw text.
    const heading = await screen.findByRole("heading", { name: "Docs heading" });
    expect(heading.tagName).toBe("H1");
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
  });
});
