/**
 * Mosaic tree construction.
 *
 * There was no test file here at all, which is why two live defects survived:
 * `buildPresetTree` addressed fixed slots through `paneIds[Math.min(i, len-1)]`
 * (repeating the last id at n=3/n=5, dropping ids past n=6), and the add/remove
 * helpers re-nested surviving leaves (remounting them, which kills and
 * restarts their PTY).
 *
 * The load-bearing property is: **the leaves of any tree this module produces
 * are exactly the pane ids, once each.** A duplicate leaf mounts a pane twice
 * and auto-starts two PTYs for it; a missing leaf renders no tile for a pane
 * that exists and is billed for.
 */
import { describe, expect, it } from "vitest";
import type { MosaicNode } from "@/types/mosaic";
import {
  appendPane,
  buildPresetTree,
  getLeafOrder,
  presetForCount,
  removeFromTree,
} from "@/lib/mosaicPresets";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `pane-${i}`);

/** Depth of each leaf, keyed by id — the quantity that decides remounting. */
function leafDepths(tree: MosaicNode<string> | null, depth = 0): Record<string, number> {
  if (tree === null) return {};
  if (typeof tree === "string") return { [tree]: depth };
  if (typeof tree === "object" && "children" in tree) {
    return Object.assign({}, ...tree.children.map((child) => leafDepths(child, depth + 1)));
  }
  return {};
}

describe("buildPresetTree", () => {
  it("emits every pane id exactly once, at every count", () => {
    for (let n = 1; n <= 12; n++) {
      const input = ids(n);
      const leaves = getLeafOrder(buildPresetTree(presetForCount(n), input));
      expect([...leaves].sort(), `n=${n}`).toEqual([...input].sort());
    }
  });

  it("preserves pane order left-to-right, top-to-bottom", () => {
    for (let n = 1; n <= 12; n++) {
      const input = ids(n);
      expect(getLeafOrder(buildPresetTree(presetForCount(n), input)), `n=${n}`).toEqual(input);
    }
  });

  it("never duplicates a leaf at the counts that used to (n=3, n=5)", () => {
    for (const n of [3, 5]) {
      const leaves = getLeafOrder(buildPresetTree(presetForCount(n), ids(n)));
      expect(new Set(leaves).size, `n=${n}`).toBe(n);
    }
  });

  it("gives panes past the preset's capacity a tile (n=7, n=8)", () => {
    for (const n of [7, 8]) {
      const leaves = getLeafOrder(buildPresetTree(presetForCount(n), ids(n)));
      expect(leaves, `n=${n}`).toContain(`pane-${n - 1}`);
    }
  });

  it("keeps a split at the root even for one pane, so growth is a plain append", () => {
    const tree = buildPresetTree(presetForCount(1), ids(1));
    expect(typeof tree).toBe("object");
    expect(getLeafOrder(tree)).toEqual(["pane-0"]);
  });

  it("rejects an empty pane list rather than inventing a tree", () => {
    expect(() => buildPresetTree("2x2", [])).toThrow();
  });
});

describe("appendPane", () => {
  it("adds the pane and leaves every existing leaf at its original depth", () => {
    let tree = buildPresetTree(presetForCount(1), ids(1));
    let before = leafDepths(tree);

    for (let n = 2; n <= 8; n++) {
      tree = appendPane(tree, `pane-${n - 1}`);
      const after = leafDepths(tree);

      // The regression: nesting the last leaf to make room moved a running
      // pane, remounting it and restarting its agent mid-task.
      for (const [id, depth] of Object.entries(before)) {
        expect(after[id], `pane ${id} moved when growing to n=${n}`).toBe(depth);
      }
      expect(getLeafOrder(tree)).toEqual(ids(n));
      before = after;
    }
  });

  it("drops stale split percentages so the new child count divides evenly", () => {
    const tree = appendPane(
      { type: "split", direction: "row", children: ["a", "b"], splitPercentages: [70, 30] },
      "c",
    );
    expect(tree).not.toHaveProperty("splitPercentages");
  });
});

describe("removeFromTree", () => {
  it("removes only the named pane and never moves a survivor", () => {
    const tree = buildPresetTree(presetForCount(3), ids(3));
    const before = leafDepths(tree);

    const pruned = removeFromTree(tree, "pane-1");

    expect(getLeafOrder(pruned)).toEqual(["pane-0", "pane-2"]);
    const after = leafDepths(pruned);
    // Collapsing a now-single-child split used to lift the survivor a level,
    // restarting the right-hand pane when the middle one was closed.
    expect(after["pane-2"]).toBe(before["pane-2"]);
    expect(after["pane-0"]).toBe(before["pane-0"]);
  });

  it("returns null once the last pane is gone", () => {
    const tree = buildPresetTree(presetForCount(1), ids(1));
    expect(removeFromTree(tree, "pane-0")).toBeNull();
  });

  it("leaves an unrelated id untouched", () => {
    const tree = buildPresetTree(presetForCount(4), ids(4));
    expect(getLeafOrder(removeFromTree(tree, "pane-99"))).toEqual(ids(4));
  });

  it("survives an add/remove churn cycle with the leaves still exact", () => {
    let tree: MosaicNode<string> | null = buildPresetTree(presetForCount(4), ids(4));
    tree = removeFromTree(tree!, "pane-1");
    tree = appendPane(tree!, "pane-4");
    tree = removeFromTree(tree!, "pane-0");
    tree = appendPane(tree!, "pane-5");

    const leaves = getLeafOrder(tree);
    expect([...leaves].sort()).toEqual(["pane-2", "pane-3", "pane-4", "pane-5"]);
    expect(new Set(leaves).size).toBe(4);
  });
});
