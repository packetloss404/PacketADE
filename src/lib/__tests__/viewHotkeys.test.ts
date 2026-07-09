/**
 * Tile program (P5-S1): the Ctrl+Shift+<n> view-switch map. Guards the Shift+1
 * remap — "!" must resolve to the Workspace surface, NOT the retired "agents"
 * CoreView — and that the other number chords are untouched by the retirement.
 */
import { describe, expect, it } from "vitest";
import { VIEW_HOTKEY_MAP } from "@/lib/viewHotkeys";

describe("VIEW_HOTKEY_MAP", () => {
  it("remaps Shift+1 ('!') to workspace, never agents", () => {
    expect(VIEW_HOTKEY_MAP["!"]).toBe("workspace");
    expect(VIEW_HOTKEY_MAP["!"]).not.toBe("agents");
  });

  it("leaves the other number chords intact", () => {
    expect(VIEW_HOTKEY_MAP["@"]).toBe("flights");
    expect(VIEW_HOTKEY_MAP["#"]).toBe("issues");
    expect(VIEW_HOTKEY_MAP["$"]).toBe("history");
    expect(VIEW_HOTKEY_MAP["%"]).toBe("tools");
  });

  it("never maps any chord to the retired agents view", () => {
    expect(Object.values(VIEW_HOTKEY_MAP)).not.toContain("agents");
  });
});
