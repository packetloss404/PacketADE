/**
 * D5 / P1-7 — `editorStore.openFile` finally has production callers.
 *
 * `openInEditor` is the single entry point both of them use (the clickable
 * path context menu and the Inspector Files tab), so its contract is pinned
 * here: relative-path resolution, dock reveal on the right surface, buffer
 * reuse, and the D3 remote refusal.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { activeDockSurface, openInEditor } from "@/lib/openInEditor";
import { useAppStore } from "@/stores/appStore";
import { useEditorStore } from "@/stores/editorStore";
import { useRightDockStore } from "@/stores/rightDockStore";

describe("openInEditor", () => {
  beforeEach(() => {
    localStorage.clear();
    useRightDockStore.getState().reset();
    useEditorStore.setState({ openFiles: [], activeFileId: null });
    useAppStore.setState({ activeView: "agents" });
  });

  it("opens a repo-relative path against the project root and reveals the dock Editor", () => {
    const id = openInEditor("src/App.tsx", { projectPath: "/home/ian/proj" });

    expect(id).not.toBeNull();
    const file = useEditorStore.getState().openFiles[0];
    expect(file.path).toBe("/home/ian/proj/src/App.tsx");
    expect(file.workspace).toBe("/home/ian/proj");
    expect(useEditorStore.getState().activeFileId).toBe(id);
    expect(useRightDockStore.getState().surfaces.agents).toMatchObject({
      activePanel: "editor",
      expanded: true,
    });
  });

  it("keeps an absolute path untouched and follows Windows separators", () => {
    openInEditor("D:\\projects\\PacketADE\\src\\main.tsx", {
      projectPath: "D:\\projects\\PacketADE",
    });
    expect(useEditorStore.getState().openFiles[0].path).toBe(
      "D:\\projects\\PacketADE\\src\\main.tsx",
    );

    openInEditor("src\\lib\\brand.ts", { projectPath: "D:\\projects\\PacketADE" });
    expect(useEditorStore.getState().openFiles[1].path).toBe(
      "D:\\projects\\PacketADE\\src\\lib\\brand.ts",
    );
  });

  it("re-activates an already-open buffer instead of creating a duplicate", () => {
    const first = openInEditor("a.ts", { projectPath: "/p" });
    useEditorStore.getState().setContent(first!, "edited");
    const second = openInEditor("a.ts", { projectPath: "/p" });

    expect(second).toBe(first);
    expect(useEditorStore.getState().openFiles).toHaveLength(1);
    // Unsaved work survives a re-open.
    expect(useEditorStore.getState().openFiles[0].content).toBe("edited");
  });

  it("refuses SSH-backed paths (D3 / P0-4) and opens nothing", () => {
    const id = openInEditor("src/App.tsx", {
      projectPath: "/srv/app",
      remote: true,
    });

    expect(id).toBeNull();
    expect(useEditorStore.getState().openFiles).toHaveLength(0);
    // The Agents dock is untouched. Its default `activePanel` became `null`
    // when B4 made the dock opt-in (it used to seed "inspector"); the
    // assertion is still "nothing moved it".
    expect(useRightDockStore.getState().surfaces.agents.activePanel).toBeNull();
  });

  it("targets the Workspace dock when the Workspace surface is active", () => {
    useAppStore.setState({ activeView: "workspace" });
    expect(activeDockSurface()).toBe("workspace");

    openInEditor("a.ts", { projectPath: "/p" });
    expect(useRightDockStore.getState().surfaces.workspace.activePanel).toBe("editor");
    // Unchanged from the (now `null`) Agents default — see the note above.
    expect(useRightDockStore.getState().surfaces.agents.activePanel).toBeNull();
  });

  it("honours an explicit surface override", () => {
    useAppStore.setState({ activeView: "workspace" });
    openInEditor("a.ts", { projectPath: "/p", surface: "agents" });
    expect(useRightDockStore.getState().surfaces.agents.activePanel).toBe("editor");
  });
});
