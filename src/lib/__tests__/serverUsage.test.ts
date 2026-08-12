/**
 * The honesty layer behind the remote-host delete confirm.
 *
 * Deleting a `ServerConfig` used to be a no-question 10px trash icon. These
 * pin the four places a host can still be load-bearing — an open connection,
 * remote conversations, live flight attempts, bound workspaces — so the
 * confirm can NAME them instead of letting the user find out afterwards.
 */
import { describe, expect, it } from "vitest";
import { serverUsageWarnings, summarizeServerUsage } from "@/lib/serverUsage";
import type { AgentConversation } from "@/types/agent-conversation";
import type { Attempt, Flight } from "@/types/flight";
import type { Workspace } from "@/types/workspace";

function conversation(over: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "c1",
    title: "Remote refactor",
    agent: "api-claude",
    projectPath: "/srv/app",
    status: "idle",
    messages: [],
    sessionId: null,
    rawOutput: "",
    createdAt: 0,
    updatedAt: 0,
    mode: "api",
    sshTarget: { id: "srv-1", name: "prod", host: "h", user: "u", remotePath: "/srv/app" },
    ...over,
  } as AgentConversation;
}

function attempt(over: Partial<Attempt> = {}): Attempt {
  return {
    id: "a1",
    flightId: "f1",
    target: { kind: "ssh", serverId: "srv-1", basePath: "/srv/app", worktreePath: "/srv/wt" },
    agentConfigId: "claude",
    model: "m",
    provider: "anthropic",
    branch: "pkt/a1",
    baseBranch: "main",
    sessionId: "s1",
    status: "running",
    cost: 0,
    tokens: 0,
    ...over,
  } as Attempt;
}

function flight(attempts: Attempt[]): Flight {
  return { id: "f1", title: "F", attempts } as Flight;
}

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: "w1",
    name: "prod app",
    agents: [],
    panes: [],
    projectPath: "/srv/app",
    createdAt: 0,
    updatedAt: 0,
    status: "active",
    serverId: "srv-1",
    ...over,
  } as Workspace;
}

const EMPTY = { connectionStates: {}, conversations: [], flights: [], workspaces: [] };

describe("summarizeServerUsage", () => {
  it("reports nothing for an unused host", () => {
    const usage = summarizeServerUsage("srv-1", EMPTY);
    expect(usage).toEqual({
      connection: null,
      conversationTitles: [],
      activeConversationCount: 0,
      liveAttemptCount: 0,
      workspaceNames: [],
    });
    expect(serverUsageWarnings(usage)).toEqual([]);
  });

  it("counts only work that belongs to THIS host", () => {
    const usage = summarizeServerUsage("srv-1", {
      connectionStates: { "srv-2": { status: "connected", steps: [] } },
      conversations: [
        conversation(),
        conversation({
          id: "c2",
          sshTarget: { id: "srv-2", name: "o", host: "h", user: "u", remotePath: "/x" },
        }),
        conversation({ id: "c3", sshTarget: undefined }),
      ],
      flights: [flight([attempt(), attempt({ id: "a2", target: { kind: "local", basePath: "/l", worktreePath: "/l/wt" } })])],
      workspaces: [workspace(), workspace({ id: "w2", name: "other", serverId: "srv-2" })],
    });

    expect(usage.conversationTitles).toEqual(["Remote refactor"]);
    expect(usage.liveAttemptCount).toBe(1);
    expect(usage.workspaceNames).toEqual(["prod app"]);
    expect(usage.connection).toBeNull();
  });

  it("counts Syndicate targets that depend on the SSH server config", () => {
    const usage = summarizeServerUsage("srv-1", {
      ...EMPTY,
      workspaces: [
        workspace({
          serverId: undefined,
          executionTarget: {
            kind: "syndicate",
            machineId: "machine-1",
            workspaceId: "host-workspace-1",
            serverConfigId: "srv-1",
          },
        }),
      ],
    });
    expect(usage.workspaceNames).toEqual(["prod app"]);
  });

  it("ignores archived conversations, archived workspaces, and finished attempts", () => {
    const usage = summarizeServerUsage("srv-1", {
      ...EMPTY,
      conversations: [conversation({ archived: true })],
      workspaces: [workspace({ status: "archived" })],
      flights: [
        flight([
          attempt({ status: "completed" }),
          attempt({ id: "a2", status: "failed" }),
          attempt({ id: "a3", status: "cancelled" }),
        ]),
      ],
    });
    expect(usage.conversationTitles).toEqual([]);
    expect(usage.workspaceNames).toEqual([]);
    expect(usage.liveAttemptCount).toBe(0);
  });

  it("treats queued/provisioning/reviewing attempts as still live", () => {
    const usage = summarizeServerUsage("srv-1", {
      ...EMPTY,
      flights: [
        flight([
          attempt({ status: "queued" }),
          attempt({ id: "a2", status: "provisioning" }),
          attempt({ id: "a3", status: "reviewing" }),
        ]),
      ],
    });
    expect(usage.liveAttemptCount).toBe(3);
  });
});

describe("serverUsageWarnings", () => {
  it("leads with the open connection and flags mid-turn conversations", () => {
    const usage = summarizeServerUsage("srv-1", {
      ...EMPTY,
      connectionStates: { "srv-1": { status: "connected", steps: [] } },
      conversations: [conversation({ status: "active" }), conversation({ id: "c2", title: "Audit" })],
    });
    const lines = serverUsageWarnings(usage);

    expect(lines[0]).toMatch(/Connected right now/);
    expect(lines[1]).toMatch(/2 conversations run on this host \(1 mid-turn\)/);
    expect(lines[1]).toContain("Remote refactor");
    expect(lines[1]).toContain("Audit");
  });

  it("names live attempts and bound workspaces, and truncates long lists", () => {
    const usage = summarizeServerUsage("srv-1", {
      ...EMPTY,
      flights: [flight([attempt(), attempt({ id: "a2" })])],
      workspaces: [
        workspace({ id: "w1", name: "one" }),
        workspace({ id: "w2", name: "two" }),
        workspace({ id: "w3", name: "three" }),
        workspace({ id: "w4", name: "four" }),
      ],
    });
    const lines = serverUsageWarnings(usage);

    expect(lines.some((l) => /2 flight attempts still running/.test(l))).toBe(true);
    const wsLine = lines.find((l) => /workspaces bound to it/.test(l))!;
    expect(wsLine).toContain("one, two, three");
    expect(wsLine).toContain("+1 more");
    expect(wsLine).not.toContain("four");
  });

  it("uses singular wording for a single item", () => {
    const usage = summarizeServerUsage("srv-1", { ...EMPTY, conversations: [conversation()] });
    expect(serverUsageWarnings(usage)[0]).toMatch(/^1 conversation runs on this host/);
  });

  it("surfaces an in-flight connection attempt", () => {
    const usage = summarizeServerUsage("srv-1", {
      ...EMPTY,
      connectionStates: { "srv-1": { status: "connecting", steps: [] } },
    });
    expect(serverUsageWarnings(usage)).toEqual(["A connection attempt is in progress."]);
  });
});
