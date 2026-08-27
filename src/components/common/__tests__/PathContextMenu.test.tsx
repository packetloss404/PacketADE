/**
 * D5 / P1-7 — "Open in editor" is a real production caller now.
 *
 * It used to shell out to the OS default application, which is why
 * `editorStore.openFile` had no caller and the whole editor shell was
 * unreachable. D3's remote gating must survive the rewiring.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shellOpen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-shell", () => ({ open: shellOpen }));

import { PathContextMenu } from "@/components/common/PathContextMenu";
import { useAppStore } from "@/stores/appStore";
import { useEditorStore } from "@/stores/editorStore";
import { useRightDockStore } from "@/stores/rightDockStore";

function renderMenu(props: Partial<React.ComponentProps<typeof PathContextMenu>> = {}) {
  return render(
    <PathContextMenu
      x={10}
      y={10}
      path="src/App.tsx"
      projectPath="/home/ian/proj"
      onClose={() => {}}
      onAttach={() => {}}
      {...props}
    />,
  );
}

describe("PathContextMenu — Open in editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useRightDockStore.getState().reset();
    useEditorStore.setState({ openFiles: [], activeFileId: null });
    useAppStore.setState({ activeView: "agents" });
  });

  it("opens the path in the in-app editor and reveals the dock panel", () => {
    const onClose = vi.fn();
    renderMenu({ onClose });

    fireEvent.click(screen.getByRole("button", { name: /open in editor/i }));

    expect(useEditorStore.getState().openFiles).toHaveLength(1);
    expect(useEditorStore.getState().openFiles[0]).toMatchObject({
      path: "/home/ian/proj/src/App.tsx",
      workspace: "/home/ian/proj",
    });
    expect(useRightDockStore.getState().surfaces.agents.activePanel).toBe("editor");
    // No OS handoff — the file stays inside PacketBench.
    expect(shellOpen).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("opens a .md path in the editor, which renders it as Markdown", () => {
    renderMenu({ path: "docs/PLAN.md" });
    fireEvent.click(screen.getByRole("button", { name: /open in editor/i }));

    const file = useEditorStore.getState().openFiles[0];
    expect(file.path).toBe("/home/ian/proj/docs/PLAN.md");
    // Markdown buffers open rendered (D5 amendment).
    expect(file.view).toBe("preview");
  });

  it("stays disabled for SSH-backed conversations (D3 / P0-4)", () => {
    renderMenu({ remote: true });

    const button = screen.getByRole("button", { name: /open in editor/i });
    expect(button).toBeDisabled();
    expect(button.getAttribute("title")).toMatch(/not yet available for ssh workspaces/i);

    fireEvent.click(button);
    expect(useEditorStore.getState().openFiles).toHaveLength(0);
    expect(shellOpen).not.toHaveBeenCalled();
  });

  it("still uses the OS for Show in Explorer, resolved against the project root", async () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: /show in explorer/i }));
    expect(shellOpen).toHaveBeenCalledWith("/home/ian/proj/src");
  });
});
