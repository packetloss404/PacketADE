import { describe, expect, it } from "vitest";
import { GIT_HOSTS, normalizeGiteaBaseUrl, capabilitiesFor } from "@/lib/git-hosts";

describe("git-host capabilities (G10)", () => {
  it("gives GitHub the GitHub-only surfaces and gates them off for Gitea", () => {
    const gh = capabilitiesFor("github");
    const gt = capabilitiesFor("gitea");
    expect(gh.activityFeed).toBe(true);
    expect(gh.checkRuns).toBe(true);
    expect(gh.draftPrToggle).toBe(true);
    // Gitea has no Events feed, no check-runs, no GraphQL draft toggle...
    expect(gt.activityFeed).toBe(false);
    expect(gt.checkRuns).toBe(false);
    expect(gt.draftPrToggle).toBe(false);
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
