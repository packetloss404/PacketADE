import { describe, expect, it } from "vitest";
import { deriveMemoryScope, scopeBasename } from "@/lib/memoryScope";
import { remoteMemoryProjectKey } from "@/stores/memoryStore";
import type { ServerConfig } from "@/types/server";
import type { Workspace } from "@/types/workspace";

const LOCAL_MIRROR = "D:/projects/PacketBench";

const SERVER = { id: "srv-1", name: "build-box" } as ServerConfig;
const lookupServer = (id: string) => (id === SERVER.id ? SERVER : undefined);

function remoteWorkspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-remote",
    name: "Remote",
    projectPath: "/srv/app",
    remoteProjectPath: "/srv/app",
    executionTarget: { kind: "ssh", serverId: "srv-1" },
    ...over,
  } as Workspace;
}

function localWorkspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-local",
    name: "Local",
    projectPath: "D:/projects/other",
    executionTarget: { kind: "local" },
    ...over,
  } as Workspace;
}

describe("deriveMemoryScope", () => {
  it("never leaks the stale local path into a remote scope", () => {
    // The regression guard for the filed defect: layoutStore.projectPath still
    // holds the last local project when a remote workspace is active.
    const scope = deriveMemoryScope({
      workspace: remoteWorkspace(),
      fallbackLocalPath: LOCAL_MIRROR,
      lookupServer,
    });
    expect(scope.kind).toBe("ssh");
    expect(JSON.stringify(scope)).not.toContain("PacketBench");
  });

  it("keys a remote scope with remoteMemoryProjectKey", () => {
    const scope = deriveMemoryScope({
      workspace: remoteWorkspace(),
      fallbackLocalPath: LOCAL_MIRROR,
      lookupServer,
    });
    if (scope.kind !== "ssh") throw new Error("expected ssh scope");
    expect(scope.memoryProjectKey).toBe(remoteMemoryProjectKey("srv-1", "/srv/app"));
    expect(scope.serverName).toBe("build-box");
  });

  it("stays remote when the server id is unknown, falling back to the id as a name", () => {
    const scope = deriveMemoryScope({
      workspace: remoteWorkspace({ executionTarget: { kind: "ssh", serverId: "srv-gone" } }),
      fallbackLocalPath: LOCAL_MIRROR,
      lookupServer,
    });
    expect(scope.kind).toBe("ssh");
    if (scope.kind !== "ssh") return;
    expect(scope.serverName).toBe("srv-gone");
  });

  it("falls back to workspace.projectPath when remoteProjectPath is absent", () => {
    const scope = deriveMemoryScope({
      workspace: remoteWorkspace({ remoteProjectPath: undefined, projectPath: "/opt/thing" }),
      fallbackLocalPath: LOCAL_MIRROR,
      lookupServer,
    });
    if (scope.kind !== "ssh") throw new Error("expected ssh scope");
    expect(scope.remotePath).toBe("/opt/thing");
  });

  it("prefers a local workspace's own path over the layout mirror", () => {
    const scope = deriveMemoryScope({
      workspace: localWorkspace(),
      fallbackLocalPath: LOCAL_MIRROR,
      lookupServer,
    });
    if (scope.kind !== "local") throw new Error("expected local scope");
    expect(scope.projectPath).toBe("D:/projects/other");
    expect(scope.workspaceId).toBe("ws-local");
  });

  it("uses the fallback path when no workspace is active", () => {
    const scope = deriveMemoryScope({
      workspace: undefined,
      fallbackLocalPath: LOCAL_MIRROR,
      lookupServer,
    });
    if (scope.kind !== "local") throw new Error("expected local scope");
    expect(scope.projectPath).toBe(LOCAL_MIRROR);
    expect(scope.workspaceId).toBeNull();
  });

  it("is 'none' with no workspace and no fallback", () => {
    expect(
      deriveMemoryScope({ workspace: undefined, fallbackLocalPath: "", lookupServer }).kind,
    ).toBe("none");
  });
});

describe("scopeBasename", () => {
  it("handles both separators and trailing separators", () => {
    expect(scopeBasename("D:/projects/PacketBench")).toBe("PacketBench");
    expect(scopeBasename("D:\\projects\\PacketBench\\")).toBe("PacketBench");
    expect(scopeBasename("/srv/app/")).toBe("app");
  });
});

describe("project scope matching", () => {
  it("treats separator and trailing-slash spellings as one scope", async () => {
    const { createProjectScopeMatcher } = await import("@/stores/memoryStore");
    const matches = createProjectScopeMatcher(
      { kind: "local", projectPath: "D:/projects/app" },
      { matching: "exact" },
    );
    // All four spell the same directory. Under the old normalizer the last
    // three missed, silently dropping their memory.
    expect(matches("D:/projects/app")).toBe(true);
    expect(matches("D:\\projects\\app")).toBe(true);
    expect(matches("D:/projects/app/")).toBe(true);
    expect(matches("d:/projects//app/")).toBe(true);
    // A genuinely different project still must not match.
    expect(matches("D:/projects/app-two")).toBe(false);
  });
});
