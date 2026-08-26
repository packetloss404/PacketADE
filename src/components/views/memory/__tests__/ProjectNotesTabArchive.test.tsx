/**
 * The archive confirm used to be `window.confirm("Archive this project-memory
 * note?")` — an unstyled OS dialog for a REVERSIBLE action. It now uses the
 * shared styled confirm, correctly drops the "cannot be undone" line, and
 * still refuses to mutate anything until the user says so.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { ProjectNotesTab } from "@/components/views/memory/ProjectNotesTab";
import { useProjectMemoryStore } from "@/stores/projectMemoryStore";
import type { ProjectMemoryNote } from "@/types/project-memory";

const NOTE: ProjectMemoryNote = {
  metadata: {
    schemaVersion: 1,
    id: "n1",
    title: "Deploy runbook",
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    tags: [],
    provenanceIds: [],
  },
  body: "steps",
  revision: "rev-1",
  relativePath: "deploy-runbook.md",
  outboundIds: [],
  backlinkIds: [],
  brokenLinks: [],
  orphaned: false,
};

const archiveNote = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  useProjectMemoryStore.setState({
    snapshot: {
      schemaVersion: 1,
      directory: ".packetbench/memory",
      notes: [NOTE],
      warnings: [],
      revision: "r",
    },
    loading: false,
    error: null,
    changedExternally: false,
    load: vi.fn().mockResolvedValue(undefined),
    archiveNote,
  });
});

describe("ProjectNotesTab archive confirm", () => {
  it("asks before archiving, and cancelling archives nothing", () => {
    const nativeConfirm = vi.spyOn(window, "confirm");
    render(<ProjectNotesTab projectPath="D:/projects/x" globalEvents={[]} />);

    // Select the note so the detail pane (and its Archive button) renders.
    fireEvent.click(screen.getByText("Deploy runbook"));
    fireEvent.click(screen.getByTitle("Archive note"));

    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(archiveNote).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Archive note?" })).toBeInTheDocument();
    // Reversible action — no irreversibility scare copy.
    expect(screen.queryByText("This cannot be undone.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(archiveNote).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("Archive note"));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(archiveNote).toHaveBeenCalledWith("n1", "rev-1");
    nativeConfirm.mockRestore();
  });
});
