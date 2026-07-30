/** WA1 Ctrl+Shift+<n> navigation map, now derived from the D4 route registry. */
import { describe, expect, it } from "vitest";
import { VIEW_HOTKEY_MAP, resolveViewHotkey } from "@/lib/viewHotkeys";

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

  it("holds only the number-row chords; letter chords resolve via the registry", () => {
    expect(Object.keys(VIEW_HOTKEY_MAP).sort()).toEqual(["!", "#", "$", "%", "@"]);
    expect(resolveViewHotkey({ ctrlKey: true, shiftKey: true, code: "KeyW", key: "W" })).toBe(
      "workspace",
    );
    expect(resolveViewHotkey({ ctrlKey: true, shiftKey: true, code: "KeyD", key: "D" })).toBe(
      "dictation",
    );
  });
});
