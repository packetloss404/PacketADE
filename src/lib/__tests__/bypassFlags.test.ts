import { describe, expect, it } from "vitest";
import {
  BYPASS_FLAGS,
  bypassCaveat,
  bypassDefaultCaveat,
  bypassStatusLabel,
  supportsBypassFlag,
  unsupportedBypassAgents,
} from "@/lib/bypassFlags";

/**
 * FAULT under test: "Bypass perms: on" was shown for every workspace, but
 * `BYPASS_FLAGS` only covers claude-code and codex — OpenCode and PacketCode
 * launch with no flag at all. The control claimed an effect the spawn path
 * never applied, and the creation modal's caveat named OpenCode only, so a
 * PacketCode session got no warning whatsoever.
 */
describe("bypass flags", () => {
  it("only claude-code and codex have a real bypass flag", () => {
    expect(supportsBypassFlag("claude-code")).toBe(true);
    expect(supportsBypassFlag("codex")).toBe(true);
    // Passing a flag to OpenCode makes it print --help and exit, so the table
    // must stay empty for it rather than gaining a plausible-looking guess.
    expect(supportsBypassFlag("opencode")).toBe(false);
    expect(supportsBypassFlag("packetcode")).toBe(false);
    expect(BYPASS_FLAGS.opencode).toBeUndefined();
    expect(BYPASS_FLAGS.packetcode).toBeUndefined();
  });

  it("names every CLI the toggle cannot reach — PacketCode included", () => {
    expect(unsupportedBypassAgents(["claude-code", "opencode", "packetcode"])).toEqual([
      "OpenCode",
      "PacketCode",
    ]);
    // The regression that motivated this: a PacketCode-only workspace used to
    // produce no caveat because the check was hard-coded to OpenCode.
    expect(unsupportedBypassAgents(["packetcode"])).toEqual(["PacketCode"]);
  });

  it("says nothing when every selected CLI honours the toggle", () => {
    expect(unsupportedBypassAgents(["claude-code", "codex"])).toEqual([]);
    expect(bypassCaveat(["claude-code", "codex"])).toBeNull();
    expect(bypassCaveat([])).toBeNull();
  });

  it("ignores plain terminal slots, which have no prompts to bypass", () => {
    expect(unsupportedBypassAgents(["terminal"])).toEqual([]);
    expect(bypassCaveat(["claude-code", "terminal"])).toBeNull();
  });

  it("de-duplicates repeated panes of the same CLI", () => {
    expect(unsupportedBypassAgents(["opencode", "opencode"])).toEqual(["OpenCode"]);
  });

  it("downgrades the header claim from 'on' to 'partial' when a CLI is out of reach", () => {
    expect(bypassStatusLabel(true, ["claude-code", "codex"])).toBe("on");
    expect(bypassStatusLabel(true, ["claude-code", "opencode"])).toBe("partial");
    expect(bypassStatusLabel(true, ["packetcode"])).toBe("partial");
    expect(bypassStatusLabel(false, ["opencode"])).toBe("off");
    // An empty workspace has nothing to overstate.
    expect(bypassStatusLabel(true, [])).toBe("on");
  });

  it("spells out the caveat naming the affected CLIs", () => {
    const caveat = bypassCaveat(["codex", "opencode", "packetcode"]);
    expect(caveat).toContain("OpenCode and PacketCode");
    expect(caveat).toContain("no equivalent CLI flag");
  });

  /**
   * FAULT: Settings → Workspace defaults set the app-wide default for this
   * toggle with no caveat at all, while the creation modal and the workspace
   * header both carried one. The default has no pane list to inspect, so it
   * must speak for every CLI the PTY allowlist can launch.
   */
  it("gives the app-wide default the same caveat, over every launchable CLI", () => {
    const caveat = bypassDefaultCaveat();
    expect(caveat).toContain("OpenCode and PacketCode");
    expect(caveat).toContain("no equivalent CLI flag");
    // It must never name a CLI that DOES honour the flag.
    expect(caveat).not.toContain("Claude Code");
    expect(caveat).not.toContain("Codex CLI");
  });
});
