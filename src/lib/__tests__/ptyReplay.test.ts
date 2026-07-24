import { describe, expect, it } from "vitest";
import { bufferedPtyRemainder, parsePtyOutputPayload } from "@/lib/ptyReplay";

describe("PTY transcript replay", () => {
  it("uses sequence boundaries when terminal text repeats", () => {
    expect(
      bufferedPtyRemainder("repeat", 2, [
        { data: "repeat", sequence: 2 },
        { data: "repeat and continue", sequence: 3 },
      ]),
    ).toBe("repeat and continue");
  });

  it("parses sequenced and legacy output payloads", () => {
    expect(parsePtyOutputPayload({ data: "new", sequence: 4 })).toEqual({
      data: "new",
      sequence: 4,
    });
    expect(parsePtyOutputPayload("legacy")).toEqual({ data: "legacy", sequence: null });
  });
});
