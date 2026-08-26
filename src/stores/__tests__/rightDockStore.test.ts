/**
 * D2 / P0-2 — the right dock's width contract and ownership rules.
 *
 * The audit's core arithmetic: at PacketBench's supported 800px minimum window
 * the old fixed panels (480px Editor + 280px Git, or a 280–720px Inspector)
 * plus the 44px rail and the ~240px surface sidebar left the centre canvas
 * with nothing. These tests pin the replacement rule.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  LEFT_RAIL_WIDTH,
  MIN_CENTER_WIDTH,
  SURFACE_SIDEBAR_WIDTH,
  dockWidthContract,
  isPanelVisible,
  loadPersisted,
  useRightDockStore,
} from "@/stores/rightDockStore";

const STORAGE_KEY = "packetbench:right-dock-v1";

describe("dockWidthContract", () => {
  it("never lets total chrome exceed the viewport at the 800px minimum window", () => {
    for (const surface of ["workspace", "agents"] as const) {
      const contract = dockWidthContract(surface, 800, 480);
      const inlineTotal =
        LEFT_RAIL_WIDTH + SURFACE_SIDEBAR_WIDTH[surface] + MIN_CENTER_WIDTH + contract.width;
      // 800px cannot host an inline dock at all — it must float instead of
      // starving the canvas, which is exactly the P0-2 failure mode.
      expect(contract.overlay).toBe(true);
      expect(inlineTotal).toBeGreaterThan(800);
      // …and even floating it always leaves a sliver of canvas visible.
      expect(
        LEFT_RAIL_WIDTH + SURFACE_SIDEBAR_WIDTH[surface] + contract.width,
      ).toBeLessThan(800);
    }
  });

  it("docks inline once the viewport can afford it, keeping the centre canvas whole", () => {
    const contract = dockWidthContract("workspace", 1440, 420);
    expect(contract.overlay).toBe(false);
    expect(contract.width).toBe(420);
    expect(
      LEFT_RAIL_WIDTH + SURFACE_SIDEBAR_WIDTH.workspace + MIN_CENTER_WIDTH + contract.width,
    ).toBeLessThanOrEqual(1440);
  });

  it("clamps a request to the available width rather than the raw maximum", () => {
    // 1024 agents: 1024 − 44 − 252 − 320 = 408 available.
    const contract = dockWidthContract("agents", 1024, 720);
    expect(contract.overlay).toBe(false);
    expect(contract.width).toBe(408);
  });

  it("clamps to [DOCK_MIN_WIDTH, DOCK_MAX_WIDTH] on a wide viewport", () => {
    expect(dockWidthContract("workspace", 3440, 5000).width).toBe(DOCK_MAX_WIDTH);
    expect(dockWidthContract("workspace", 3440, 10).width).toBe(DOCK_MIN_WIDTH);
    expect(dockWidthContract("workspace", 3440, Number.NaN).width).toBe(420);
  });
});

describe("useRightDockStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useRightDockStore.getState().reset();
  });

  it("ships BOTH docks collapsed, and only Workspace paints a rail up front", () => {
    const { surfaces } = useRightDockStore.getState();
    // Workspace had no default right panel before D2 — the CLI workroom keeps
    // its full width until the user asks for a panel. Its icon rail is the
    // dock's only permanent entry point, so it counts as already opened.
    expect(surfaces.workspace).toMatchObject({
      expanded: false,
      activePanel: null,
      everOpened: true,
    });
    // B4: the Agents surface used to ship expanded on Inspector, which made
    // the view a three-column IDE by default. It is now two panes — nothing
    // active, nothing expanded, and no rail chrome until the dock is opened.
    expect(surfaces.agents).toMatchObject({
      expanded: false,
      activePanel: null,
      everOpened: false,
    });
  });

  it("latches everOpened on the first open and never clears it", () => {
    const dock = useRightDockStore.getState();
    expect(useRightDockStore.getState().surfaces.agents.everOpened).toBe(false);

    dock.openPanel("agents", "diff");
    expect(useRightDockStore.getState().surfaces.agents.everOpened).toBe(true);

    // Collapsing hides the body, not the way back to it.
    dock.closePanel("agents");
    expect(useRightDockStore.getState().surfaces.agents).toMatchObject({
      expanded: false,
      everOpened: true,
    });

    dock.reset();
    expect(useRightDockStore.getState().surfaces.agents.everOpened).toBe(false);
    // An explicit expand is just as much an "open" as picking a panel.
    useRightDockStore.getState().setExpanded("agents", true);
    expect(useRightDockStore.getState().surfaces.agents.everOpened).toBe(true);
  });

  it("treats a pre-everOpened record that was left expanded as already opened", () => {
    // Upgrade path: records written before `everOpened` existed carry no such
    // key. A dock the user left expanded had obviously been opened, so the
    // upgrade must not read as "the dock vanished".
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ agents: { expanded: true, activePanel: "inspector", width: 340 } }),
    );
    expect(loadPersisted().agents).toMatchObject({
      expanded: true,
      everOpened: true,
    });

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ agents: { expanded: false, activePanel: null, width: 340 } }),
    );
    expect(loadPersisted().agents).toMatchObject({
      expanded: false,
      everOpened: false,
    });
  });

  it("keeps exactly one panel visible per surface", () => {
    const dock = useRightDockStore.getState();
    dock.openPanel("workspace", "editor");
    expect(useRightDockStore.getState().surfaces.workspace.activePanel).toBe("editor");
    expect(isPanelVisible(useRightDockStore.getState().surfaces, "workspace", "editor")).toBe(true);
    expect(isPanelVisible(useRightDockStore.getState().surfaces, "workspace", "git")).toBe(false);

    dock.openPanel("workspace", "git");
    expect(isPanelVisible(useRightDockStore.getState().surfaces, "workspace", "editor")).toBe(false);
    expect(isPanelVisible(useRightDockStore.getState().surfaces, "workspace", "git")).toBe(true);
  });

  it("scopes panels per surface — opening in Agents does not move Workspace", () => {
    const dock = useRightDockStore.getState();
    dock.openPanel("workspace", "git");
    dock.openPanel("agents", "preview");
    const { surfaces } = useRightDockStore.getState();
    expect(surfaces.workspace.activePanel).toBe("git");
    expect(surfaces.agents.activePanel).toBe("preview");
  });

  it("toggles a visible panel closed and re-opens it", () => {
    const dock = useRightDockStore.getState();
    dock.togglePanel("workspace", "git");
    expect(isPanelVisible(useRightDockStore.getState().surfaces, "workspace", "git")).toBe(true);
    dock.togglePanel("workspace", "git");
    expect(useRightDockStore.getState().surfaces.workspace.expanded).toBe(false);
    dock.togglePanel("workspace", "git");
    expect(isPanelVisible(useRightDockStore.getState().surfaces, "workspace", "git")).toBe(true);
  });

  it("ignores a close aimed at a panel that is no longer the visible one", () => {
    const dock = useRightDockStore.getState();
    dock.openPanel("agents", "diff");
    dock.closePanel("agents", "preview");
    // A stale "close preview" must not collapse a dock showing Diff.
    expect(useRightDockStore.getState().surfaces.agents.expanded).toBe(true);
    dock.closePanel("agents", "diff");
    expect(useRightDockStore.getState().surfaces.agents.expanded).toBe(false);
  });

  it("persists width/expansion/panel per surface and re-clamps on read", () => {
    const dock = useRightDockStore.getState();
    dock.setWidth("workspace", 5000);
    dock.setWidth("agents", 10);
    dock.openPanel("agents", "files");

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(saved.workspace.width).toBe(DOCK_MAX_WIDTH);
    expect(saved.agents.width).toBe(DOCK_MIN_WIDTH);
    expect(saved.agents.activePanel).toBe("files");
    expect(saved.agents.expanded).toBe(true);
  });
});
