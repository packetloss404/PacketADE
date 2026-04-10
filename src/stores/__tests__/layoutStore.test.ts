import { describe, it, expect, beforeEach } from "vitest";
import { useLayoutStore } from "../layoutStore";

const store = () => useLayoutStore.getState();

describe("layoutStore", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      panes: [],
      activePaneId: "",
      projectPath: "",
      explorerOpen: false,
    });
  });

  describe("projectPath and explorer", () => {
    it("sets the project path", () => {
      store().setProjectPath("/tmp/foo");
      expect(store().projectPath).toBe("/tmp/foo");
    });

    it("sets and toggles explorer open state", () => {
      store().setExplorerOpen(true);
      expect(store().explorerOpen).toBe(true);
      store().toggleExplorer();
      expect(store().explorerOpen).toBe(false);
      store().toggleExplorer();
      expect(store().explorerOpen).toBe(true);
    });
  });

  describe("addPane", () => {
    it("adds a pane with defaults and makes it active", () => {
      const id = store().addPane();
      expect(id).toMatch(/^pane_/);
      expect(store().panes).toHaveLength(1);
      expect(store().panes[0].cliCommand).toBe("claude");
      expect(store().panes[0].sessionId).toBeNull();
      expect(store().activePaneId).toBe(id);
    });

    it("adds a pane with custom cli options", () => {
      const id = store().addPane({ cliCommand: "codex", cliArgs: ["-v"], initialPrompt: "hi" });
      const pane = store().panes.find((p) => p.id === id)!;
      expect(pane.cliCommand).toBe("codex");
      expect(pane.cliArgs).toEqual(["-v"]);
      expect(pane.initialPrompt).toBe("hi");
    });

    it("generates unique pane ids on successive calls", () => {
      const a = store().addPane();
      const b = store().addPane();
      expect(a).not.toBe(b);
      expect(store().panes).toHaveLength(2);
    });
  });

  describe("removePane", () => {
    it("removes a pane by id", () => {
      const a = store().addPane();
      const b = store().addPane();
      store().removePane(a);
      expect(store().panes).toHaveLength(1);
      expect(store().panes[0].id).toBe(b);
    });

    it("updates activePaneId to last remaining pane when removing the active one", () => {
      const a = store().addPane();
      const b = store().addPane();
      expect(store().activePaneId).toBe(b);
      store().removePane(b);
      expect(store().activePaneId).toBe(a);
    });

    it("sets activePaneId to empty string when last pane removed", () => {
      const a = store().addPane();
      store().removePane(a);
      expect(store().panes).toHaveLength(0);
      expect(store().activePaneId).toBe("");
    });

    it("does not change activePaneId when removing an inactive pane", () => {
      const a = store().addPane();
      const b = store().addPane();
      store().removePane(a);
      expect(store().activePaneId).toBe(b);
    });

    it("is a no-op for unknown pane id", () => {
      const a = store().addPane();
      expect(() => store().removePane("nope")).not.toThrow();
      expect(store().panes).toHaveLength(1);
      expect(store().activePaneId).toBe(a);
    });
  });

  describe("setPaneSession", () => {
    it("attaches and clears a session on a pane", () => {
      const id = store().addPane();
      store().setPaneSession(id, "sess_1");
      expect(store().panes[0].sessionId).toBe("sess_1");
      store().setPaneSession(id, null);
      expect(store().panes[0].sessionId).toBeNull();
    });
  });

  describe("getActivePane", () => {
    it("returns the active pane", () => {
      const id = store().addPane();
      expect(store().getActivePane()?.id).toBe(id);
    });

    it("returns undefined when no active pane exists", () => {
      expect(store().getActivePane()).toBeUndefined();
    });
  });
});
