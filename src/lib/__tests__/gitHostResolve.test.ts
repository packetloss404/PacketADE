import { describe, expect, it } from "vitest";
import {
  remoteHost,
  connectionHost,
  resolveConnectionForRemote,
} from "@/lib/gitHostResolve";
import type { GitHostConnectionInfo } from "@/lib/tauri";

const conn = (over: Partial<GitHostConnectionInfo>): GitHostConnectionInfo => ({
  id: "x",
  kind: "gitea",
  baseUrl: "https://git.example.com",
  label: "x",
  hasToken: true,
  ...over,
});

const github = conn({ id: "github", kind: "github", baseUrl: "https://api.github.com", label: "GitHub" });
const gitea = conn({ id: "gitea-git-example-com", kind: "gitea", baseUrl: "https://git.example.com" });

describe("remoteHost (G3)", () => {
  it("parses HTTPS remotes", () => {
    expect(remoteHost("https://github.com/o/r.git")).toBe("github.com");
    expect(remoteHost("https://git.example.com/o/r")).toBe("git.example.com");
  });
  it("parses scp-like SSH remotes", () => {
    expect(remoteHost("git@github.com:o/r.git")).toBe("github.com");
    expect(remoteHost("git@git.example.com:o/r.git")).toBe("git.example.com");
  });
  it("parses ssh:// remotes", () => {
    expect(remoteHost("ssh://git@git.example.com:2222/o/r.git")).toBe("git.example.com");
  });
  it("returns null for junk", () => {
    expect(remoteHost("")).toBeNull();
    expect(remoteHost("not a url")).toBeNull();
  });
});

describe("connectionHost (G3)", () => {
  it("maps GitHub to github.com (not api.github.com)", () => {
    expect(connectionHost(github)).toBe("github.com");
  });
  it("maps Gitea to its base URL host", () => {
    expect(connectionHost(gitea)).toBe("git.example.com");
  });
});

describe("resolveConnectionForRemote (G3)", () => {
  const conns = [github, gitea];

  it("routes github.com remotes to the GitHub connection", () => {
    expect(resolveConnectionForRemote("git@github.com:o/r.git", conns)).toEqual({
      connectionId: "github",
      ambiguous: false,
    });
  });

  it("routes a matching host to its Gitea connection", () => {
    expect(resolveConnectionForRemote("https://git.example.com/o/r.git", conns)).toEqual({
      connectionId: "gitea-git-example-com",
      ambiguous: false,
    });
  });

  it("returns null when no configured host owns the remote", () => {
    expect(resolveConnectionForRemote("https://gitlab.com/o/r.git", conns)).toEqual({
      connectionId: null,
      ambiguous: false,
    });
  });

  it("flags ambiguity when two connections share a host", () => {
    const dup = conn({ id: "gitea-2", kind: "gitea", baseUrl: "https://git.example.com" });
    const r = resolveConnectionForRemote("https://git.example.com/o/r", [gitea, dup]);
    expect(r.ambiguous).toBe(true);
    expect(r.connectionId).toBe("gitea-git-example-com");
  });

  it("handles a missing origin", () => {
    expect(resolveConnectionForRemote(null, conns)).toEqual({
      connectionId: null,
      ambiguous: false,
    });
  });
});
