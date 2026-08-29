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

describe("GitLab resolution", () => {
  const gitlabCloud = conn({
    id: "gitlab-gitlab-com",
    kind: "gitlab",
    baseUrl: "https://gitlab.com",
    label: "GitLab",
  });
  const gitlabSelf = conn({
    id: "gitlab-gitlab-internal",
    kind: "gitlab",
    baseUrl: "https://gitlab.internal",
    label: "Internal",
  });

  it("maps a GitLab connection to its own origin", () => {
    // Unlike GitHub (api.github.com vs github.com) GitLab serves API and repos
    // from the same origin, so the base URL is already the remote host.
    expect(connectionHost(gitlabCloud)).toBe("gitlab.com");
    expect(connectionHost(gitlabSelf)).toBe("gitlab.internal");
  });

  it("routes gitlab.com remotes once a GitLab connection exists", () => {
    const all = [github, gitea, gitlabCloud];
    expect(resolveConnectionForRemote("git@gitlab.com:group/sub/proj.git", all)).toEqual({
      connectionId: "gitlab-gitlab-com",
      ambiguous: false,
    });
    expect(resolveConnectionForRemote("https://gitlab.com/group/proj.git", all)).toEqual({
      connectionId: "gitlab-gitlab-com",
      ambiguous: false,
    });
  });

  it("keeps self-hosted GitLab distinct from gitlab.com", () => {
    const all = [gitlabCloud, gitlabSelf];
    expect(resolveConnectionForRemote("https://gitlab.internal/g/p.git", all).connectionId).toBe(
      "gitlab-gitlab-internal",
    );
    expect(resolveConnectionForRemote("https://gitlab.com/g/p.git", all).connectionId).toBe(
      "gitlab-gitlab-com",
    );
  });

  it("does NOT route a gitlab.com remote to the GitHub connection", () => {
    // The whole point of resolution: an unmatched remote resolves to nothing,
    // so the pane never fires the GitHub token at a host it was not issued for.
    expect(resolveConnectionForRemote("https://gitlab.com/g/p.git", [github, gitea])).toEqual({
      connectionId: null,
      ambiguous: false,
    });
  });

  it("matches a path-prefixed self-hosted GitLab by hostname", () => {
    const prefixed = conn({
      id: "gitlab-example-com",
      kind: "gitlab",
      baseUrl: "https://example.com/gitlab",
    });
    expect(connectionHost(prefixed)).toBe("example.com");
    expect(resolveConnectionForRemote("https://example.com/gitlab/g/p.git", [prefixed])).toEqual({
      connectionId: "gitlab-example-com",
      ambiguous: false,
    });
  });
});
