import type { MosaicNode, MosaicLayoutPreset } from "@/types/mosaic";
import type { MosaicSplitNode } from "react-mosaic-component";

/**
 * Local type-guard replicating react-mosaic-component's `isSplitNode` without
 * pulling the library's runtime into the entry chunk. A split node is an object
 * with a `direction` field; leaves are strings and tabs nodes lack `direction`.
 */
function isSplitNode(node: MosaicNode<string> | null): node is MosaicSplitNode<string> {
  return node != null && typeof node === "object" && "direction" in node;
}

/**
 * Tiles-per-row for each preset. Preset names are RxC, so the column count is
 * the second digit — that is the only number the layout actually needs, since
 * the row count falls out of how many panes there are.
 */
const PRESET_COLUMNS: Record<MosaicLayoutPreset, number> = {
  "1x1": 1,
  "1x2": 2,
  "2x1": 1,
  "2x2": 2,
  "2x3": 3,
  "3x2": 2,
};

/**
 * Build a mosaic n-ary tree for a given layout preset and ordered pane IDs.
 *
 * The leaves are ALWAYS exactly the given ids, once each. The previous version
 * addressed fixed slots through `paneIds[Math.min(i, len - 1)]`, so a pane
 * count the preset did not divide evenly repeated the last id (n=3 and n=5
 * rendered one pane TWICE — two `WorkspacePane` mounts, two PTYs auto-started
 * for one pane) and any count past the preset's capacity silently dropped
 * panes (n=7+ had tiles for only the first six). Rows are now chunked from the
 * real id list, so a short last row is short and a long list grows more rows.
 *
 * The root is always a split, even for a single pane. Appending a pane must
 * never change a surviving leaf's DEPTH — `MosaicRoot` flattens each split
 * into a keyed Fragment, so a re-nested leaf remounts and its PTY is killed
 * and restarted. Keeping a split at the root means {@link appendPane} can push
 * onto `children` without disturbing anything already there.
 */
export function buildPresetTree(preset: MosaicLayoutPreset, paneIds: string[]): MosaicNode<string> {
  if (paneIds.length === 0) throw new Error("Need at least one pane ID");

  const columns = PRESET_COLUMNS[preset] ?? 2;
  const rows: MosaicNode<string>[] = [];
  for (let i = 0; i < paneIds.length; i += columns) {
    const rowIds = paneIds.slice(i, i + columns);
    // A one-pane row is the bare leaf: a split wrapping a single child renders
    // identically (no splitter, full bounds) but adds a pointless level.
    rows.push(rowIds.length === 1 ? rowIds[0] : split("row", rowIds));
  }

  // One row of one pane still gets a root split, per the depth invariant above.
  if (rows.length === 1) {
    return typeof rows[0] === "string" ? split("row", [rows[0]]) : rows[0];
  }
  return split("column", rows);
}

/** Shorthand to create a split node with equal percentages. */
function split(direction: "row" | "column", children: MosaicNode<string>[]): MosaicNode<string> {
  return {
    type: "split" as const,
    direction,
    children,
  };
}

/**
 * Walk a mosaic tree depth-first, left-to-right, top-to-bottom.
 * Returns ordered leaf IDs — used for Ctrl+1/2/3/4 pane switching.
 */
export function getLeafOrder(tree: MosaicNode<string> | null): string[] {
  if (tree === null) return [];
  if (typeof tree === "string") return [tree];
  if (isSplitNode(tree)) {
    return tree.children.flatMap((child) => getLeafOrder(child));
  }
  // TabsNode — return all tabs
  if ("tabs" in tree) {
    return tree.tabs as string[];
  }
  return [];
}

/**
 * Append a new pane to the tree without moving anything already in it.
 *
 * Replaces the old `addToTree`, which converted the last leaf into a nested
 * split. That pushed the surviving leaf down one level, and because
 * `MosaicRoot` renders each split as a Fragment keyed by path, the survivor
 * landed under a differently-keyed Fragment and React REMOUNTED it — running
 * `useTerminalSession`'s cleanup (`killPty`) and then auto-starting a fresh
 * PTY. Adding a terminal beside a working agent therefore restarted that
 * agent mid-task. It also degraded widths to 50/25/12.5/12.5, since every
 * addition nested one level deeper and always split as a row.
 *
 * Pushing onto the ROOT split's children instead leaves every existing leaf at
 * its exact depth and index. `splitPercentages` is dropped so `MosaicRoot`
 * falls back to even distribution across the new child count — a stale array
 * sized for the old count would misplace every boundary.
 */
export function appendPane(tree: MosaicNode<string>, newId: string): MosaicNode<string> {
  if (isSplitNode(tree)) {
    // Rebuilt field-by-field rather than spread, so `splitPercentages` is left
    // behind: a percentage array sized for the old child count would misplace
    // every boundary. Omitting it makes MosaicRoot distribute evenly.
    return { type: "split", direction: tree.direction, children: [...tree.children, newId] };
  }
  // A bare leaf or tabs node at the root: wrap it. This is the one case that
  // changes an existing leaf's depth, and `buildPresetTree` keeps a split at
  // the root precisely so the app never reaches it.
  return split("row", [tree, newId]);
}

/**
 * Remove a leaf from the tree. Returns null once the tree is empty.
 *
 * A split left with ONE child is deliberately kept rather than collapsed to
 * that bare child. Collapsing lifted the survivor a level, which — by the same
 * Fragment-keying described on {@link appendPane} — remounted it and restarted
 * its agent: closing the middle of three panes restarted the right-hand one.
 * A single-child split renders identically anyway (`MosaicRoot` emits no
 * splitter for the last child and gives it the full bounding box).
 */
export function removeFromTree(tree: MosaicNode<string>, id: string): MosaicNode<string> | null {
  if (typeof tree === "string") {
    return tree === id ? null : tree;
  }

  if (!isSplitNode(tree)) return tree;

  const newChildren = tree.children
    .map((child) => removeFromTree(child, id))
    .filter((child): child is MosaicNode<string> => child !== null);

  if (newChildren.length === 0) return null;

  // Percentages sized for the old child count would misplace the remaining
  // boundaries; omitting them lets MosaicRoot distribute evenly.
  return { type: "split", direction: tree.direction, children: newChildren };
}

/**
 * Given an agent count, pick the best default preset.
 */
export function presetForCount(count: number): MosaicLayoutPreset {
  if (count <= 1) return "1x1";
  if (count === 2) return "1x2";
  if (count <= 4) return "2x2";
  if (count <= 6) return "3x2";
  return "3x2";
}
