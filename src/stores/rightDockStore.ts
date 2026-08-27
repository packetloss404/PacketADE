/**
 * D2 — the single right-dock controller (audit finding P0-2, helps P0-3).
 *
 * Before this store the right side of the shell had no owner: Workspace could
 * render a 480px Editor *and* a 280px Git panel at the same time, while the
 * Agents surface added a 280–720px inspector. Combined with the 44px primary
 * rail and the ~240px surface sidebar those fixed widths blow past PacketBench's
 * supported 800px minimum window before the centre canvas gets any room.
 *
 * This module owns, per surface:
 *   - which single panel is visible (mutual exclusion — one panel at a time),
 *   - the dock width (clamped against the live viewport, persisted per surface),
 *   - whether the dock is expanded or collapsed to its icon rail.
 *
 * The width contract is pure (`dockWidthContract`) so it is unit-testable
 * without a DOM: `railWidth + sidebarWidth + MIN_CENTER_WIDTH + dockWidth`
 * never exceeds the viewport. When there is not enough room for the dock's
 * minimum width, the dock reports `overlay: true` and the `RightDock`
 * component collapses to its icon rail instead of squeezing the canvas — an
 * explicit expand then floats the panel over the canvas.
 */
import { create } from "zustand";
import { storageKey } from "@/lib/brand";
import { logSwallowed } from "@/lib/logSwallowed";

/** The two shell surfaces that own a right dock. */
export type DockSurface = "workspace" | "agents";

/** Panels the Workspace surface can dock. */
export type WorkspacePanelId = "editor" | "git";
/**
 * Panels the Agents surface can dock.
 *
 * `inspector`, `plan` and `files` are no longer REGISTERED by
 * `AgentInspectorPane` — the inspector folded into the Diff panel's header,
 * the file browser into the Editor, and the plan lives inline in the
 * conversation (it used to render twice). They stay in the union because
 * `loadPersisted` can still read them out of a returning user's localStorage;
 * the dock re-points `activePanel` at a registered panel on mount.
 */
export type AgentsPanelId =
  | "inspector"
  | "plan"
  | "preview"
  | "diff"
  | "files"
  | "editor";
export type DockPanelId = WorkspacePanelId | AgentsPanelId;

/** Narrowest useful dock width. Below this the dock collapses instead. */
export const DOCK_MIN_WIDTH = 260;
/** Widest the dock may ever grow, regardless of viewport. */
export const DOCK_MAX_WIDTH = 720;
/** The centre canvas (terminal mosaic / transcript) never goes below this. */
export const MIN_CENTER_WIDTH = 320;
/** `LeftRail` is a fixed 44px on every surface. */
export const LEFT_RAIL_WIDTH = 44;
/** Slice of the canvas left uncovered when the dock has to float. */
export const OVERLAY_PEEK_WIDTH = 48;

/** Fixed surface sidebar widths (FleetSidebar 240px, AgentSidebar 252px). */
export const SURFACE_SIDEBAR_WIDTH: Record<DockSurface, number> = {
  workspace: 240,
  agents: 252,
};

export const DEFAULT_DOCK_WIDTH: Record<DockSurface, number> = {
  workspace: 420,
  agents: 340,
};

export interface DockWidthContract {
  /** Width the dock should render at, already clamped. */
  width: number;
  /** True when the dock cannot fit inline and must float over the canvas. */
  overlay: boolean;
  /** Largest inline width available before the centre canvas is starved. */
  available: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Resolve the width the dock may occupy on `surface` for a given viewport.
 *
 * Pure and DOM-free so the arbitration rule itself can be unit-tested at the
 * 800px minimum window and above.
 */
export function dockWidthContract(
  surface: DockSurface,
  viewportWidth: number,
  requestedWidth: number,
): DockWidthContract {
  const chrome = LEFT_RAIL_WIDTH + SURFACE_SIDEBAR_WIDTH[surface];
  const available = Math.max(0, viewportWidth - chrome - MIN_CENTER_WIDTH);
  const desired = clamp(
    Number.isFinite(requestedWidth) ? requestedWidth : DEFAULT_DOCK_WIDTH[surface],
    DOCK_MIN_WIDTH,
    DOCK_MAX_WIDTH,
  );

  if (available >= DOCK_MIN_WIDTH) {
    return { width: Math.min(desired, available), overlay: false, available };
  }

  // Not enough room to dock inline without starving the canvas. The panel can
  // still be opened, but it floats and always leaves a sliver of canvas.
  const overlayCap = Math.max(
    DOCK_MIN_WIDTH,
    viewportWidth - chrome - OVERLAY_PEEK_WIDTH,
  );
  return { width: Math.min(desired, overlayCap), overlay: true, available };
}

export interface DockSurfaceState {
  /** The ONE visible panel for this surface. `null` = nothing chosen yet. */
  activePanel: DockPanelId | null;
  /** User-requested width. Always re-clamped through `dockWidthContract`. */
  width: number;
  /** User intent. The dock may still render collapsed if it cannot fit. */
  expanded: boolean;
  /**
   * True once this surface's dock has ever been opened. The permanent 30px
   * icon rail is gated on it, so a surface that ships two-pane (Agents) paints
   * NO dock chrome until something actually asks for a panel — the shell reads
   * as two panes, not as a three-column IDE with an empty third column.
   */
  everOpened: boolean;
}

interface RightDockState {
  surfaces: Record<DockSurface, DockSurfaceState>;
  /** Show `panel` on `surface` and expand the dock. */
  openPanel: (surface: DockSurface, panel: DockPanelId) => void;
  /**
   * The ONE hide verb. Collapses the dock. When `panel` is supplied it is a
   * no-op unless that panel is the visible one, so a stale "close preview"
   * cannot collapse a dock that has since moved on to another panel.
   */
  closePanel: (surface: DockSurface, panel?: DockPanelId) => void;
  /** Open `panel`, or collapse if it is already the visible panel. */
  togglePanel: (surface: DockSurface, panel: DockPanelId) => void;
  /** Swap the visible panel without changing expansion. */
  setActivePanel: (surface: DockSurface, panel: DockPanelId | null) => void;
  setExpanded: (surface: DockSurface, expanded: boolean) => void;
  setWidth: (surface: DockSurface, width: number) => void;
  /** Test/bootstrap helper — restores defaults. */
  reset: () => void;
}

const STORAGE_KEY = storageKey("right-dock-v1");

type PersistedDock = Partial<Record<DockSurface, Partial<DockSurfaceState>>>;

function defaults(): Record<DockSurface, DockSurfaceState> {
  return {
    workspace: {
      // Workspace had no default right panel before D2 — keep the CLI
      // workroom full-width and let the icon rail advertise the dock.
      activePanel: null,
      width: DEFAULT_DOCK_WIDTH.workspace,
      expanded: false,
      // The rail IS the Workspace dock's discovery surface (its Editor has no
      // other permanent entry point), so it is "already opened" from the start.
      everOpened: true,
    },
    agents: {
      // B4 — the Agents view ships TWO panes. The dock is opt-in: nothing is
      // chosen, nothing is expanded, and no rail paints until a deep link
      // (preview target, plan block, open-in-editor) or the user asks.
      activePanel: null,
      width: DEFAULT_DOCK_WIDTH.agents,
      expanded: false,
      everOpened: false,
    },
  };
}

/**
 * Read the persisted dock state, filling in defaults for anything missing.
 * Exported so the localStorage UPGRADE rules (notably the `everOpened`
 * back-fill) can be tested without reloading the module singleton.
 */
export function loadPersisted(): Record<DockSurface, DockSurfaceState> {
  const base = defaults();
  try {
    if (typeof localStorage === "undefined") return base;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as PersistedDock;
    for (const surface of ["workspace", "agents"] as DockSurface[]) {
      const saved = parsed?.[surface];
      if (!saved) continue;
      if (typeof saved.width === "number" && Number.isFinite(saved.width)) {
        base[surface].width = clamp(saved.width, DOCK_MIN_WIDTH, DOCK_MAX_WIDTH);
      }
      if (typeof saved.expanded === "boolean") {
        base[surface].expanded = saved.expanded;
      }
      if (typeof saved.everOpened === "boolean") {
        base[surface].everOpened = saved.everOpened;
      } else if (saved.expanded === true) {
        // Records written before `everOpened` existed: a dock that was left
        // expanded had obviously been opened, so keep its rail rather than
        // making an upgrade look like the dock vanished.
        base[surface].everOpened = true;
      }
      if (typeof saved.activePanel === "string" || saved.activePanel === null) {
        base[surface].activePanel = (saved.activePanel ?? null) as DockPanelId | null;
      }
    }
  } catch (err) {
    logSwallowed("rightDockStore.loadPersisted")(err);
  }
  return base;
}

function persist(surfaces: Record<DockSurface, DockSurfaceState>) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(surfaces));
  } catch (err) {
    logSwallowed("rightDockStore.persist")(err);
  }
}

function update(
  state: RightDockState,
  surface: DockSurface,
  patch: Partial<DockSurfaceState>,
): Pick<RightDockState, "surfaces"> {
  const next = {
    ...state.surfaces,
    [surface]: { ...state.surfaces[surface], ...patch },
  } as Record<DockSurface, DockSurfaceState>;
  persist(next);
  return { surfaces: next };
}

export const useRightDockStore = create<RightDockState>((set) => ({
  surfaces: loadPersisted(),

  // `expanded: true` is load-bearing, not a convenience: the auto-reveal deep
  // links (AgentInspectorPane's preview + plan effects, `openInEditor`) call
  // ONLY this verb, and the dock body renders on `expanded`. Setting just
  // `activePanel` would make every one of them a silent no-op now that the
  // Agents dock ships collapsed.
  openPanel: (surface, panel) =>
    set((state) =>
      update(state, surface, { activePanel: panel, expanded: true, everOpened: true }),
    ),

  closePanel: (surface, panel) =>
    set((state) => {
      if (panel && state.surfaces[surface].activePanel !== panel) {
        return { surfaces: state.surfaces };
      }
      return update(state, surface, { expanded: false });
    }),

  togglePanel: (surface, panel) =>
    set((state) => {
      const current = state.surfaces[surface];
      const visible = current.expanded && current.activePanel === panel;
      return visible
        ? update(state, surface, { expanded: false })
        : update(state, surface, { activePanel: panel, expanded: true, everOpened: true });
    }),

  setActivePanel: (surface, panel) =>
    set((state) => update(state, surface, { activePanel: panel })),

  setExpanded: (surface, expanded) =>
    set((state) =>
      update(state, surface, expanded ? { expanded, everOpened: true } : { expanded }),
    ),

  setWidth: (surface, width) =>
    set((state) =>
      update(state, surface, {
        width: clamp(Math.round(width), DOCK_MIN_WIDTH, DOCK_MAX_WIDTH),
      }),
    ),

  reset: () => set(() => {
    const base = defaults();
    persist(base);
    return { surfaces: base };
  }),
}));

/** True when `panel` is the visible panel of an expanded dock on `surface`. */
export function isPanelVisible(
  surfaces: Record<DockSurface, DockSurfaceState>,
  surface: DockSurface,
  panel: DockPanelId,
): boolean {
  const state = surfaces[surface];
  return state.expanded && state.activePanel === panel;
}
