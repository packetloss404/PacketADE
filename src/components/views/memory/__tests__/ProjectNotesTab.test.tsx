import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectNotesTab } from "../ProjectNotesTab";
import { useProjectMemoryStore } from "@/stores/projectMemoryStore";

vi.mock("@/components/common/MarkdownRenderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

describe("ProjectNotesTab", () => {
  beforeEach(() => {
    useProjectMemoryStore.setState({
      projectPath: "D:\\repo",
      snapshot: {
        schemaVersion: 1,
        directory: ".agents/memory",
        revision: "snapshot",
        warnings: [],
        notes: [
          {
            metadata: {
              schemaVersion: 1,
              id: "note-1",
              title: "Architecture",
              createdAt: 1,
              updatedAt: 1,
              archived: false,
              tags: ["design"],
              provenanceIds: ["prov-1"],
            },
            body: "Keep the boundary explicit.",
            revision: "abcdef123456",
            relativePath: "architecture.md",
            outboundIds: [],
            backlinkIds: [],
            brokenLinks: ["Missing note"],
            orphaned: true,
          },
        ],
      },
      loading: false,
      error: null,
      changedExternally: true,
      ownWriteUntil: 0,
      load: vi.fn().mockResolvedValue(undefined),
      createNote: vi.fn(),
      updateNote: vi.fn(),
      archiveNote: vi.fn(),
      clearError: vi.fn(),
      acknowledgeExternalChange: vi.fn(),
    });
  });

  it("surfaces external changes, graph health, provenance, and an accessible editor", () => {
    render(<ProjectNotesTab projectPath="D:\\repo" globalEvents={[]} />);

    expect(screen.getByText(/Files changed outside PacketBench/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Architecture/ }));
    expect(screen.getByText("Keep the boundary explicit.")).toBeInTheDocument();
    expect(screen.getByText(/prov-1/)).toBeInTheDocument();
    expect(screen.getByText(/Broken: Missing note/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Project note title")).toHaveValue("Architecture");
    expect(screen.getByLabelText("Project note Markdown")).toHaveValue(
      "Keep the boundary explicit.",
    );
  });

  it("does not offer project memory without a project", () => {
    render(<ProjectNotesTab projectPath={null} globalEvents={[]} />);
    // "local" was dropped from this copy: it read as the remote-workspace
    // explanation, which now has its own state below.
    expect(
      screen.getByText("Open a project to use project memory."),
    ).toBeInTheDocument();
  });

  it("explains that notes are local-only on a remote workspace", () => {
    render(
      <ProjectNotesTab
        projectPath={null}
        globalEvents={[]}
        remote={{ serverName: "build-box", remotePath: "/srv/app" }}
      />,
    );
    expect(screen.getByText("Project notes are local-only")).toBeInTheDocument();
    expect(screen.getByText("build-box")).toBeInTheDocument();
  });
});
