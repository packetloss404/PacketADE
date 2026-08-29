import { describe, expect, it } from "vitest";
import {
  memoryProjectLabel,
  memoryProjectLabelText,
  parseMemoryProjectKey,
} from "@/lib/memoryProjectLabel";
import { remoteMemoryProjectKey, workspaceMemoryProjectKey } from "@/stores/memoryStore";

const lookups = {
  serverName: (id: string) => (id === "srv-1" ? "build-box" : undefined),
  workspaceName: (id: string) => (id === "ws-1" ? "Deploy box" : undefined),
};

describe("parseMemoryProjectKey", () => {
  it("splits a remote key on the first separator only, so paths may contain colons", () => {
    expect(parseMemoryProjectKey("ssh:srv-1:/srv/app")).toEqual({
      kind: "ssh",
      serverId: "srv-1",
      remotePath: "/srv/app",
    });
    expect(parseMemoryProjectKey("ssh:srv-1:c:/srv/app")).toEqual({
      kind: "ssh",
      serverId: "srv-1",
      remotePath: "c:/srv/app",
    });
  });

  it("round-trips what remoteMemoryProjectKey produces", () => {
    const parsed = parseMemoryProjectKey(remoteMemoryProjectKey("srv-9", "/srv/App/"));
    expect(parsed).toEqual({ kind: "ssh", serverId: "srv-9", remotePath: "/srv/app" });
  });

  it("recognises workspace keys and plain paths", () => {
    expect(parseMemoryProjectKey(workspaceMemoryProjectKey("ws-1"))).toEqual({
      kind: "workspace",
      workspaceId: "ws-1",
    });
    expect(parseMemoryProjectKey("D:/projects/app")).toEqual({
      kind: "path",
      path: "D:/projects/app",
    });
  });

  it("degrades a malformed remote key to a path rather than throwing", () => {
    expect(parseMemoryProjectKey("ssh:broken")).toEqual({ kind: "path", path: "ssh:broken" });
  });
});

describe("memoryProjectLabel", () => {
  it("renders a remote scope as 'server · basename', never the raw key", () => {
    const label = memoryProjectLabel("ssh:srv-1:/srv/app", lookups);
    expect(label.label).toBe("build-box · app");
    expect(label.label).not.toContain("ssh:");
    expect(label.label).not.toContain("srv-1");
    expect(label.title).toContain("/srv/app");
    expect(label.unresolvedServer).toBe(false);
  });

  it("falls back to the server id when the connection is gone (e.g. an import)", () => {
    const label = memoryProjectLabel("ssh:srv-unknown:/srv/app", lookups);
    expect(label.label).toBe("srv-unknown · app");
    expect(label.unresolvedServer).toBe(true);
    expect(label.title).toContain("unknown server");
  });

  it("names a workspace key, and degrades to a short id when the workspace is gone", () => {
    expect(memoryProjectLabelText("workspace:ws-1", lookups)).toBe("Deploy box");
    expect(memoryProjectLabelText("workspace:ws-abcdef123456", lookups)).toBe(
      "Workspace 123456",
    );
  });

  it("still renders a plain local path as its basename", () => {
    expect(memoryProjectLabelText("D:/projects/PacketBench", lookups)).toBe("PacketBench");
    expect(memoryProjectLabelText("D:\\projects\\PacketBench\\", lookups)).toBe("PacketBench");
  });
});
