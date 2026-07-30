/**
 * D5 — the reconnected Editor dock panel.
 *
 * Covers the amendment (Markdown renders, with a raw/preview toggle) and the
 * dirty-buffer protection the audit called for: switching tabs/panels is
 * lossless because the buffer lives in `editorStore`, and the one discarding
 * action left — closing a buffer — goes through the codebase's inline styled
 * confirm strip, never `window.confirm`.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "@/stores/editorStore";

const files = vi.hoisted(() => new Map<string, string>());

vi.mock("@/lib/tauri", () => ({
  readFileContents: vi.fn(async (path: string) => files.get(path) ?? ""),
  writeFileContents: vi.fn(async (path: string, _ws: string, content: string) => {
    files.set(path, content);
  }),
}));

import { readFileContents, writeFileContents } from "@/lib/tauri";
import { EditorDockPanel } from "@/components/editor/EditorDockPanel";

describe("EditorDockPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    files.clear();
    useEditorStore.setState({ openFiles: [], activeFileId: null });
  });

  it("shows the discoverable empty state when nothing is open", () => {
    render(<EditorDockPanel />);
    expect(screen.getByText("No file open.")).toBeInTheDocument();
  });

  it("renders a .md buffer as Markdown and toggles to raw (D5 amendment)", async () => {
    files.set("/p/README.md", "# Hello dock\n\nSome body text.");
    act(() => {
      useEditorStore.getState().openFile("/p/README.md", "/p");
    });
    render(<EditorDockPanel />);

    // Rendered, not raw: the heading becomes a real <h1>, and there is no
    // textarea while preview is active.
    const heading = await screen.findByRole("heading", { name: "Hello dock" });
    expect(heading.tagName).toBe("H1");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /raw/i }));
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("# Hello dock\n\nSome body text.");
    expect(screen.queryByRole("heading", { name: "Hello dock" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /preview/i }));
    expect(await screen.findByRole("heading", { name: "Hello dock" })).toBeInTheDocument();
  });

  it("opens a non-markdown buffer raw with no view toggle", async () => {
    files.set("/p/src/App.tsx", "export const x = 1;");
    act(() => {
      useEditorStore.getState().openFile("/p/src/App.tsx", "/p");
    });
    render(<EditorDockPanel />);

    await waitFor(() => {
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "export const x = 1;",
      );
    });
    expect(screen.queryByRole("radio", { name: /^raw$/i })).not.toBeInTheDocument();
    expect(readFileContents).toHaveBeenCalledWith("/p/src/App.tsx", "/p");
  });

  it("confirms before discarding a dirty buffer — styled strip, not window.confirm", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm");
    files.set("/p/a.ts", "original");
    act(() => {
      useEditorStore.getState().openFile("/p/a.ts", "/p");
    });
    render(<EditorDockPanel />);
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("original"),
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "edited" } });
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close a.ts" }));

    // Nothing discarded yet, and no native dialog was used.
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(useEditorStore.getState().openFiles).toHaveLength(1);
    expect(screen.getByText(/has\s+unsaved changes\. Closing discards them\./i)).toBeInTheDocument();

    // "Keep editing" backs out without losing the buffer.
    fireEvent.click(screen.getByRole("button", { name: /keep editing/i }));
    expect(useEditorStore.getState().openFiles[0].content).toBe("edited");

    // Explicit confirmation is what finally closes it.
    fireEvent.click(screen.getByRole("button", { name: "Close a.ts" }));
    fireEvent.click(screen.getByRole("button", { name: /discard changes/i }));
    expect(useEditorStore.getState().openFiles).toHaveLength(0);
  });

  it("closes a clean buffer immediately without a confirm", async () => {
    files.set("/p/a.ts", "original");
    act(() => {
      useEditorStore.getState().openFile("/p/a.ts", "/p");
    });
    render(<EditorDockPanel />);
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("original"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Close a.ts" }));
    expect(useEditorStore.getState().openFiles).toHaveLength(0);
  });

  it("preserves an unsaved buffer across file-tab switches (no silent discard)", async () => {
    files.set("/p/a.ts", "A body");
    files.set("/p/b.ts", "B body");
    act(() => {
      useEditorStore.getState().openFile("/p/a.ts", "/p");
      useEditorStore.getState().openFile("/p/b.ts", "/p");
    });
    const { rerender } = render(<EditorDockPanel />);
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("B body"),
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "B edited" } });

    // Switch to the other tab and back.
    fireEvent.click(screen.getByRole("tab", { name: /a\.ts/ }));
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("A body"),
    );
    fireEvent.click(screen.getByRole("tab", { name: /b\.ts/ }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("B edited");

    // Unmounting the whole panel (dock panel switch / workspace change) is
    // equally lossless — the buffer lives in the store.
    rerender(<div />);
    expect(useEditorStore.getState().openFiles.find((f) => f.path === "/p/b.ts")?.content).toBe(
      "B edited",
    );
  });

  it("saves through writeFileContents and clears the dirty marker", async () => {
    files.set("/p/a.ts", "original");
    act(() => {
      useEditorStore.getState().openFile("/p/a.ts", "/p");
    });
    render(<EditorDockPanel />);
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("original"),
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "saved body" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(writeFileContents).toHaveBeenCalledWith("/p/a.ts", "/p", "saved body"),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument(),
    );
    // A clean buffer closes without a confirm.
    fireEvent.click(screen.getByRole("button", { name: "Close a.ts" }));
    expect(useEditorStore.getState().openFiles).toHaveLength(0);
  });
});
