import { describe, expect, it } from "vitest";
import { GIT_HOSTS, normalizeGiteaBaseUrl } from "@/lib/git-hosts";

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
