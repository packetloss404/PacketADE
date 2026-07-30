/** WA1 Ctrl+Shift+<n> navigation map. */
import { describe, expect, it } from "vitest";
import { VIEW_HOTKEY_MAP } from "@/lib/viewHotkeys";

describe("VIEW_HOTKEY_MAP", () => {
  it("opens Agents with Shift+1 ('!')", () => {
    expect(VIEW_HOTKEY_MAP["!"]).toBe("agents");
  });

  it("leaves the other number chords intact", () => {
    expect(VIEW_HOTKEY_MAP["@"]).toBe("flights");
    expect(VIEW_HOTKEY_MAP["#"]).toBe("issues");
    expect(VIEW_HOTKEY_MAP["$"]).toBe("history");
    expect(VIEW_HOTKEY_MAP["%"]).toBe("tools");
  });

  it("contains one Agents destination", () => {
    expect(Object.values(VIEW_HOTKEY_MAP).filter((view) => view === "agents")).toHaveLength(1);
  });
});
