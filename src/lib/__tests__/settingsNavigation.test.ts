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
      "time",
      "workspace",
      "cli-clients",
      "cli-accounts",
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
    // "packetcode" is genuinely two settings, and a search that returned only
    // one of them would strand whichever user wanted the other. CLI Clients
    // configures the PTY `packetcode` binary; Providers & Models configures
    // the ACP engine binary the `api-packetcode` conversation row drives.
    // These are separate paths with separate overrides — pinning one does not
    // move the other.
    expect(searchSettings("packetcode").map(({ section }) => section.key)).toEqual([
      "cli-clients",
      "providers",
    ]);
  });

  /**
   * FAULT: controls that landed after the search index was written were
   * unreachable through it — the only discovery affordance in a 19-section
   * Settings pane. Each query below is the word a user would actually type.
   */
  it("finds the controls added after the search index was written", () => {
    expect(searchSettings("bypass").map(({ section }) => section.key)).toContain("workspace");
    expect(searchSettings("transcript").map(({ section }) => section.key)).toContain("agents");
    expect(searchSettings("density").map(({ section }) => section.key)).toContain("agents");
    expect(searchSettings("cleanup").map(({ section }) => section.key)).toContain("agents");
    expect(searchSettings("auxiliary").map(({ section }) => section.key)).toContain("routing");
    expect(searchSettings("time zone").map(({ section }) => section.key)).toContain("time");
  });

  it("does not route a search onto a control that was retired", () => {
    // "Start right rail collapsed" was removed from AgentSettingsCard, but
    // "rail" stayed in the index and landed the user on a section that has no
    // such control. See PlaceboSettingsControls.test.tsx.
    const agents = SETTINGS_GROUPS.flatMap((group) => group.sections).find(
      (section) => section.key === "agents",
    );
    expect(agents?.keywords).not.toContain("rail");
  });

  /**
   * FAULT: Issues was badged "Project", but the ticket prefix, epics, and
   * labels live in one global slice (`issueStore` → a single localStorage key
   * and `storage.rs::save_issues`), keyed by nothing. Switching projects
   * changes none of them, so the badge promised isolation that does not exist.
   */
  it("badges every section with a scope it can actually honour", () => {
    const sections = SETTINGS_GROUPS.flatMap((group) => group.sections);
    for (const section of sections) {
      expect(section.scopes.length).toBeGreaterThan(0);
    }
    expect(sections.find((section) => section.key === "issues")?.scopes).toEqual(["App"]);
  });
});
