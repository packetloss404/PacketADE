import { describe, expect, it } from "vitest";
import { choosePreferredWorkspaceCli } from "@/lib/workspaceCliDefaults";

describe("choosePreferredWorkspaceCli", () => {
  it("prefers PacketCode when detected", () => {
    expect(
      choosePreferredWorkspaceCli(
        new Set(["claude-code", "codex", "packetcode"]),
      ),
    ).toBe("packetcode");
  });

  it("falls through the supported CLI order", () => {
    expect(choosePreferredWorkspaceCli(new Set(["codex", "opencode"]))).toBe(
      "codex",
    );
  });

  it("always has a plain-terminal fallback", () => {
    expect(choosePreferredWorkspaceCli(new Set())).toBe("terminal");
  });
});
