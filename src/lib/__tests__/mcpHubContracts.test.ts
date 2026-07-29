import { beforeEach, describe, expect, it } from "vitest";
import { MCP_CATALOG, materializeCatalogCommand, validateMcpCatalog } from "@/lib/mcpCatalog";
import { defaultMcpTrustProfile, useMcpTrustStore } from "@/stores/mcpTrustStore";
import type { McpServerEntry } from "@/types/mcp";

const server: McpServerEntry = {
  name: "demo",
  scope: "project",
  disabled: false,
  config: { command: "node", args: ["server.js"] },
  rawConfig: { command: "node", args: ["server.js"] },
};

describe("MCP Hub contracts", () => {
  beforeEach(() => {
    localStorage.clear();
    useMcpTrustStore.setState({ profiles: {}, capabilities: {} });
  });

  it("ships reviewable catalog manifests without embedded secrets or shell commands", () => {
    expect(validateMcpCatalog(MCP_CATALOG)).toEqual([]);
    const filesystem = MCP_CATALOG.find((entry) => entry.id === "official-filesystem")!;
    expect(filesystem.needsNetwork).toBe(true);
    expect(filesystem.networkUse).toMatch(/npx.*download/i);
    expect(materializeCatalogCommand(filesystem, "D:\\repo", "Win32")).toEqual({
      command: "cmd",
      args: ["/c", "npx", "-y", "@modelcontextprotocol/server-filesystem", "D:\\repo"],
      env: {},
    });
    const github = MCP_CATALOG.find((entry) => entry.id === "official-github")!;
    expect(materializeCatalogCommand(github, "D:\\repo", "Win32").env).toEqual({});
  });

  it("defaults to read-only tools and keeps denial floors non-overridable", () => {
    const profile = defaultMcpTrustProfile(server, "D:\\repo", {
      schemaVersion: 1,
      state: "connected",
      transport: "stdio",
      tools: [
        { name: "read_file", description: "" },
        { name: "delete_file", description: "" },
      ],
      compatibilityVersion: "2024-11-05",
      checkedAt: 1,
      message: "ok",
    });
    expect(profile.allowWrites).toBe(false);
    expect(profile.allowedRoots).toEqual(["D:\\repo"]);
    expect(profile.allowedToolNames).toEqual(["read_file"]);
    expect(profile.denialFloors).toEqual(["credentials", "outside_workspace", "protected_publish"]);
  });

  it("snapshots trust so later profile edits cannot broaden a running session", () => {
    useMcpTrustStore
      .getState()
      .setProfile(server, { allowWrites: false, allowedToolNames: ["read_file"] }, "D:\\repo");
    const frozen = useMcpTrustStore.getState().snapshot([server], null, "D:\\repo");
    useMcpTrustStore
      .getState()
      .setProfile(
        server,
        { allowWrites: true, allowedToolNames: ["read_file", "write_file"] },
        "D:\\repo",
      );
    expect(frozen[0].allowWrites).toBe(false);
    expect(frozen[0].allowedToolNames).toEqual(["read_file"]);
  });
});
