import type { MosaicNode, MosaicLayoutPreset } from "@/types/mosaic";
import type { MosaicSplitNode } from "react-mosaic-component";

/**
 * Local type-guard replicating react-mosaic-component's `isSplitNode` without
 * pulling the library's runtime into the entry chunk. A split node is an object
 * with a `direction` field; leaves are strings and tabs nodes lack `direction`.
 */
function isSplitNode(
  node: MosaicNode<string> | null,
): node is MosaicSplitNode<string> {
  return node != null && typeof node === "object" && "direction" in node;
}

/**
 * Build a mosaic n-ary tree for a given layout preset and ordered pane IDs.
 * Panes beyond what the preset needs are ignored; missing panes use the last ID.
 */
export function buildPresetTree(
  preset: MosaicLayoutPreset,
  paneIds: string[],
): MosaicNode<string> {
  if (paneIds.length === 0) throw new Error("Need at least one pane ID");
  if (paneIds.length === 1 || preset === "1x1") return paneIds[0];

  const p = (i: number) => paneIds[Math.min(i, paneIds.length - 1)];

  switch (preset) {
    case "1x2":
      return split("row", [p(0), p(1)]);
    case "2x1":
      return split("column", [p(0), p(1)]);
    case "2x2":
      return split("column", [
        split("row", [p(0), p(1)]),
        split("row", [p(2), p(3)]),
      ]);
    case "2x3":
      return split("column", [
        split("row", [p(0), p(1)]),
        split("row", [p(2), p(3), p(4)]),
      ]);
    case "3x2":
      return split("column", [
        split("row", [p(0), p(1)]),
        split("row", [p(2), p(3)]),
        split("row", [p(4), p(5)]),
      ]);
    default:
      return paneIds[0];
  }
}

/** Shorthand to create a split node with equal percentages. */
function split(
  direction: "row" | "column",
  children: MosaicNode<string>[],
): MosaicNode<string> {
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
 * Insert a new pane adjacent to an existing one in the tree.
 */
export function addToTree(
  tree: MosaicNode<string>,
  existingId: string,
  newId: string,
  direction: "row" | "column" = "row",
): MosaicNode<string> {
  if (typeof tree === "string") {
    if (tree === existingId) {
      return split(direction, [existingId, newId]);
    }
    return tree;
  }

  if (isSplitNode(tree)) {
    return {
      ...tree,
      children: tree.children.map((child) =>
        addToTree(child, existingId, newId, direction),
      ),
    };
  }

  return tree;
}

/**
 * Remove a leaf from the tree and collapse its parent.
 * Returns null if the tree becomes empty.
 */
export function removeFromTree(
  tree: MosaicNode<string>,
  id: string,
): MosaicNode<string> | null {
  if (typeof tree === "string") {
    return tree === id ? null : tree;
  }

  if (!isSplitNode(tree)) return tree;

  const newChildren = tree.children
    .map((child) => removeFromTree(child, id))
    .filter((child): child is MosaicNode<string> => child !== null);

  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) return newChildren[0];

  return { ...tree, children: newChildren };
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
