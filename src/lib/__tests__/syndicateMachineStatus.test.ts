import { describe, expect, it } from "vitest";
import {
  syndicateAuthoritySummary,
  syndicateDisableImpact,
  unknownSyndicateScopes,
} from "@/lib/syndicateMachineStatus";
import type { Workspace } from "@/types/workspace";

function workspace(
  id: string,
  status: Workspace["status"],
  sessions: Array<string | undefined>,
  kind: "syndicate" | "local" = "syndicate",
): Workspace {
  return {
    id,
    name: id,
    agents: ["terminal"],
    panes: sessions.map((sessionId, index) => ({
      id: `${id}-pane-${index}`,
      agentId: "terminal",
      sessionId: null,
      syndicateSessionId: sessionId,
    })),
    projectPath: "/srv/project",
    createdAt: 1,
    updatedAt: 1,
    status,
    executionTarget:
      kind === "syndicate"
        ? { kind: "syndicate", machineId: "machine-1", workspaceId: id, serverConfigId: "server-1" }
        : { kind: "local" },
  };
}

describe("Syndicate settings status helpers", () => {
  it("counts active Workspaces and panes while deduplicating saved sessions across archives", () => {
    expect(
      syndicateDisableImpact([
        workspace("active", "active", ["session-1", "session-2"]),
        workspace("archived", "archived", ["session-2", "session-3"]),
        workspace("local", "active", ["local-session"], "local"),
      ]),
    ).toEqual({ activeWorkspaces: 1, activePanes: 2, knownHostSessions: 3 });
  });

  it("does not describe file or conversation panes as paused remote terminals", () => {
    const mixed = workspace("mixed", "active", ["terminal-session", undefined, undefined]);
    mixed.panes[1].kind = "file";
    mixed.panes[2].kind = "conversation";

    expect(syndicateDisableImpact([mixed])).toEqual({
      activeWorkspaces: 1,
      activePanes: 1,
      knownHostSessions: 1,
    });
  });

  it("classifies only exact authority presets", () => {
    expect(
      syndicateAuthoritySummary("active", ["machine.read", "workspace.read", "terminal.view"]),
    ).toBe("View only");
    expect(
      syndicateAuthoritySummary("active", [
        "machine.read",
        "workspace.read",
        "terminal.view",
        "workspace.create",
        "session.start",
        "terminal.input",
        "terminal.resize",
        "terminal.stop",
      ]),
    ).toBe("Full coding control");
    expect(syndicateAuthoritySummary("active", ["terminal.input"])).toBe("Custom authority");
    expect(syndicateAuthoritySummary("pending", ["terminal.input"])).toBe("Approval pending");
  });

  it("retains unknown future authority for honest display", () => {
    expect(unknownSyndicateScopes(["machine.read", "future.control", "future.control"])).toEqual([
      "future.control",
    ]);
  });
});
