import { describe, expect, it } from "vitest";
import {
  GIT_HOSTS,
  normalizeGiteaBaseUrl,
  normalizeInstanceBaseUrl,
  capabilitiesFor,
  hostLabel,
} from "@/lib/git-hosts";

describe("git-host capabilities (G10)", () => {
  it("gives GitHub the GitHub-only surfaces and gates them off for Gitea", () => {
    const gh = capabilitiesFor("github");
    const gt = capabilitiesFor("gitea");
    expect(gh.activityFeed).toBe(true);
    expect(gh.checkRuns).toBe(true);
    expect(gh.draftPrToggle).toBe(true);
    expect(gh.aiAssist).toBe(true);
    expect(gh.inlineReviewComments).toBe(true);
    // Gitea has no Events feed, no check-runs, no GraphQL draft toggle...
    expect(gt.activityFeed).toBe(false);
    expect(gt.checkRuns).toBe(false);
    expect(gt.draftPrToggle).toBe(false);
    expect(gt.aiAssist).toBe(false);
    expect(gt.inlineReviewComments).toBe(false);
    // ...but does support reviews (G11).
    expect(gt.prReviews).toBe(true);
  });
});

describe("GIT_HOSTS catalog (G2)", () => {
  it("marks GitHub as fixed-host and Gitea as needing a base URL", () => {
    expect(GIT_HOSTS.github.needsBaseUrl).toBe(false);
    expect(GIT_HOSTS.gitea.needsBaseUrl).toBe(true);
  });
});

describe("normalizeGiteaBaseUrl (G2)", () => {
  it("accepts a plain origin", () => {
    expect(normalizeGiteaBaseUrl("https://git.example.com")).toEqual({
      value: "https://git.example.com",
    });
  });

  it("strips a trailing slash", () => {
    expect(normalizeGiteaBaseUrl("https://git.example.com/")).toEqual({
      value: "https://git.example.com",
    });
  });

  it("strips a pasted /api/v1 suffix back to the origin", () => {
    expect(normalizeGiteaBaseUrl("https://git.example.com/api/v1")).toEqual({
      value: "https://git.example.com",
    });
  });

  it("requires a scheme", () => {
    expect(normalizeGiteaBaseUrl("git.example.com")).toEqual({
      error: "Base URL must start with http:// or https://",
    });
  });

  it("rejects empty input", () => {
    expect(normalizeGiteaBaseUrl("   ")).toEqual({ error: "Base URL is required" });
  });

  it("accepts http for a LAN instance", () => {
    expect(normalizeGiteaBaseUrl("http://gitea.local:3000")).toEqual({
      value: "http://gitea.local:3000",
    });
  });
});

describe("GitLab in the catalog", () => {
  it("needs a base URL for gitlab.com just as much as for self-hosted", () => {
    // GitLab has no separate API hostname the way GitHub does
    // (api.github.com), so `https://gitlab.com` is an ordinary value for this
    // field rather than something the UI should special-case away.
    expect(GIT_HOSTS.gitlab.needsBaseUrl).toBe(true);
    expect(GIT_HOSTS.gitlab.name).toBe("GitLab");
    expect(hostLabel("gitlab")).toBe("GitLab");
    expect(hostLabel("gitea")).toBe("Gitea");
    expect(hostLabel("github")).toBe("GitHub");
  });

  it("gates off every GitHub-only surface", () => {
    const gl = capabilitiesFor("gitlab");
    expect(gl.aiAssist).toBe(false);
    expect(gl.checkRuns).toBe(false);
    expect(gl.draftPrToggle).toBe(false);
    expect(gl.activityFeed).toBe(false);
    expect(gl.inlineReviewComments).toBe(false);
    // GitLab has no review objects and no notification inbox (it has Todos).
    expect(gl.prReviews).toBe(false);
    expect(gl.notifications).toBe(false);
    // GitLab assigns by numeric id, not username.
    expect(gl.assigneesByLogin).toBe(false);
    expect(gl.requestReviewers).toBe(false);
  });

  it("calls a change request a merge request", () => {
    expect(capabilitiesFor("gitlab").changeRequestNoun).toBe("merge request");
    expect(capabilitiesFor("github").changeRequestNoun).toBe("pull request");
    expect(capabilitiesFor("gitea").changeRequestNoun).toBe("pull request");
  });

  it("does not narrow what Gitea already supported", () => {
    // The capability table gained GitLab; Gitea's row must not have been
    // tightened in passing.
    const gt = capabilitiesFor("gitea");
    expect(gt.prReviews).toBe(true);
    expect(gt.notifications).toBe(true);
    expect(gt.requestReviewers).toBe(true);
    expect(gt.assigneesByLogin).toBe(true);
  });
});

describe("normalizeInstanceBaseUrl", () => {
  it("strips the kind-appropriate API suffix", () => {
    expect(normalizeInstanceBaseUrl("gitlab", "https://gitlab.com/api/v4")).toEqual({
      value: "https://gitlab.com",
    });
    expect(normalizeInstanceBaseUrl("gitea", "https://git.example.com/api/v1")).toEqual({
      value: "https://git.example.com",
    });
  });

  it("does not strip the other kind's suffix", () => {
    // A Gitea suffix on a GitLab URL is a user error, not something to silently
    // "fix" into a URL that would 404 on /api/v1/api/v4.
    expect(normalizeInstanceBaseUrl("gitlab", "https://x.example.com/api/v1")).toEqual({
      value: "https://x.example.com/api/v1",
    });
  });

  it("accepts gitlab.com unchanged", () => {
    expect(normalizeInstanceBaseUrl("gitlab", "https://gitlab.com/")).toEqual({
      value: "https://gitlab.com",
    });
  });

  it("accepts a path-prefixed self-hosted instance", () => {
    expect(normalizeInstanceBaseUrl("gitlab", "https://example.com/gitlab")).toEqual({
      value: "https://example.com/gitlab",
    });
  });

  it("applies the same validation as the Gitea alias", () => {
    expect(normalizeInstanceBaseUrl("gitlab", "gitlab.com")).toEqual({
      error: "Base URL must start with http:// or https://",
    });
    expect(normalizeInstanceBaseUrl("gitlab", "  ")).toEqual({ error: "Base URL is required" });
  });
});
