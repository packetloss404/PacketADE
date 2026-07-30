import { describe, expect, it } from "vitest";
import {
  SETTINGS_GROUPS,
  normalizeSettingsTarget,
  searchSettings,
  settingsGroupForSection,
} from "@/lib/settingsNavigation";

describe("Settings navigation", () => {
  it("exposes exactly six root groups without losing any legacy section", () => {
    expect(SETTINGS_GROUPS).toHaveLength(6);
    expect(
      SETTINGS_GROUPS.flatMap((group) => group.sections.map((section) => section.key)),
    ).toEqual([
      "general",
      "workspace",
      "cli-clients",
      "servers",
      "project-rules",
      "agents",
      "providers",
      "flights",
      "routing",
      "packet-agent",
      "github",
      "mcp",
      "issues",
      "memory",
      "dictation",
      "modules",
      "advanced",
    ]);
  });

  it("routes CLI recovery into Workspaces & Terminal", () => {
    expect(normalizeSettingsTarget({ section: "agents", cliId: "packetcode" })).toBe("cli-clients");
    expect(settingsGroupForSection("cli-clients").key).toBe("workspaces-terminal");
  });

  it("finds settings through user-facing synonyms", () => {
    expect(searchSettings("forgejo").map(({ section }) => section.key)).toEqual(["github"]);
    expect(searchSettings("microphone").map(({ section }) => section.key)).toEqual(["dictation"]);
    expect(searchSettings("packetcode").map(({ section }) => section.key)).toEqual(["cli-clients"]);
  });
});
