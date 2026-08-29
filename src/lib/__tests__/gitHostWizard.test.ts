import { describe, expect, it } from "vitest";
import {
  GIT_HOST_WIZARD_DESCRIPTORS,
  defaultConnectionLabel,
  descriptorById,
  missingRequiredScopes,
  normalizeInstanceUrl,
  verdictFor,
  wizardSteps,
  type GitHostWizardDescriptor,
} from "@/lib/gitHostWizard";
import type { GitHostProbeResult } from "@/lib/gitHostProbe";

function descriptor(id: string): GitHostWizardDescriptor {
  const found = descriptorById(id);
  if (!found) throw new Error(`no descriptor '${id}'`);
  return found;
}

function probe(overrides: Partial<GitHostProbeResult> = {}): GitHostProbeResult {
  return {
    outcome: "ok",
    status: 200,
    login: "octocat",
    avatarUrl: null,
    scopes: ["repo"],
    detail: null,
    endpoint: "https://api.github.com/user",
    ...overrides,
  };
}

describe("git-host wizard descriptors", () => {
  it("exposes github, github enterprise, and gitea out of the box", () => {
    expect(GIT_HOST_WIZARD_DESCRIPTORS.map((d) => d.id)).toEqual([
      "github",
      "github-enterprise",
      "gitea",
    ]);
  });

  it("marks GitHub Enterprise unsupported instead of offering a dead-end flow", () => {
    // The backend's GitHub connection is a singleton pinned to api.github.com,
    // so there is nowhere to store an Enterprise origin.
    expect(descriptor("github-enterprise").unsupported).toBeTruthy();
    expect(descriptor("github-enterprise").kind).toBeNull();
  });

  it("gives every supported descriptor everything the wizard needs", () => {
    for (const d of GIT_HOST_WIZARD_DESCRIPTORS.filter((x) => !x.unsupported)) {
      expect(d.scopes.length, `${d.id} scopes`).toBeGreaterThan(0);
      expect(d.scopes.every((s) => s.reason.length > 0), `${d.id} scope reasons`).toBe(true);
      expect(d.probe.identityPath.startsWith("/"), `${d.id} identity path`).toBe(true);
      expect(d.probe.loginFields.length, `${d.id} login fields`).toBeGreaterThan(0);
      expect(typeof d.save, `${d.id} save`).toBe("function");
      if (d.needsInstanceUrl) {
        expect(d.instanceUrlPlaceholder, `${d.id} placeholder`).toBeTruthy();
      } else {
        expect(d.fixedBaseUrl, `${d.id} fixed base url`).toBeTruthy();
      }
    }
  });
});

describe("descriptor-driven step flow", () => {
  it("shows only the host step until a host is chosen", () => {
    expect(wizardSteps(null).map((s) => s.id)).toEqual(["host"]);
  });

  it("skips the instance step for a cloud host", () => {
    expect(wizardSteps(descriptor("github")).map((s) => s.id)).toEqual([
      "host",
      "token",
      "verify",
      "done",
    ]);
  });

  it("inserts the instance step for a self-hosted host", () => {
    expect(wizardSteps(descriptor("gitea")).map((s) => s.id)).toEqual([
      "host",
      "instance",
      "token",
      "verify",
      "done",
    ]);
  });

  it("derives the flow from the descriptor alone, so a new host slots in", () => {
    // Stand-in for the GitLab descriptor another host would add: no code in the
    // wizard changes, only this object.
    const gitlabish = {
      ...descriptor("gitea"),
      id: "gitlab",
      needsInstanceUrl: true,
    } as GitHostWizardDescriptor;
    expect(wizardSteps(gitlabish).map((s) => s.id)).toEqual([
      "host",
      "instance",
      "token",
      "verify",
      "done",
    ]);
    expect(wizardSteps({ ...gitlabish, needsInstanceUrl: false }).map((s) => s.id)).toEqual([
      "host",
      "token",
      "verify",
      "done",
    ]);
  });
});

describe("instance URL normalisation", () => {
  const gitea = descriptor("gitea");

  it("rejects an empty URL", () => {
    expect(normalizeInstanceUrl("   ", gitea)).toEqual({
      ok: false,
      error: "Instance URL is required.",
    });
  });

  it("adds a scheme when the user pastes a bare host, and says so", () => {
    const result = normalizeInstanceUrl("git.example.com", gitea);
    expect(result.ok && result.value).toBe("https://git.example.com");
    expect(result.ok && result.notes.join(" ")).toContain("Added https://");
  });

  it("strips a trailing slash", () => {
    const result = normalizeInstanceUrl("https://git.example.com/", gitea);
    expect(result.ok && result.value).toBe("https://git.example.com");
  });

  it("strips a pasted /api/v1 root and explains why", () => {
    const result = normalizeInstanceUrl("https://git.example.com/api/v1/", gitea);
    expect(result.ok && result.value).toBe("https://git.example.com");
    expect(result.ok && result.notes.join(" ")).toContain("/api/v1");
  });

  it("keeps a sub-path install intact", () => {
    const result = normalizeInstanceUrl("https://example.com/gitea/api/v1", gitea);
    expect(result.ok && result.value).toBe("https://example.com/gitea");
  });

  it("drops a leftover query string and reports it", () => {
    const result = normalizeInstanceUrl("https://git.example.com/?tab=repos", gitea);
    expect(result.ok && result.value).toBe("https://git.example.com");
    expect(result.ok && result.notes.join(" ")).toContain("query string");
  });

  it("keeps an explicit port", () => {
    const result = normalizeInstanceUrl("git.example.com:3000", gitea);
    // No scheme + a port is still parsed as an address, not a scheme.
    expect(result.ok && result.value).toBe("https://git.example.com:3000");
  });

  it("refuses a non-http scheme", () => {
    const result = normalizeInstanceUrl("ftp://git.example.com", gitea);
    expect(result).toEqual({ ok: false, error: "The instance URL must use http:// or https://." });
  });

  it("refuses credentials embedded in the URL rather than silently stripping them", () => {
    const result = normalizeInstanceUrl("https://me:hunter2@git.example.com", gitea);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("Remove the username and password");
    // And the rejection must not repeat the secret back.
    expect(!result.ok && result.error).not.toContain("hunter2");
  });

  it("warns about plaintext http for a remote host but not for localhost", () => {
    const remote = normalizeInstanceUrl("http://git.example.com", gitea);
    expect(remote.ok && remote.warnings.join(" ")).toContain("unencrypted");
    const local = normalizeInstanceUrl("http://localhost:3000", gitea);
    expect(local.ok && local.warnings).toEqual([]);
  });
});

describe("scope sufficiency", () => {
  const gitea = descriptor("gitea");

  it("reports nothing missing when the host does not report grants", () => {
    // `null` is "the host didn't say", which is not evidence of absence.
    expect(missingRequiredScopes(gitea, null)).toEqual([]);
  });

  it("lists required scopes the host says were not granted", () => {
    expect(missingRequiredScopes(gitea, ["read:repository"])).toEqual([
      "write:repository",
      "read:issue",
      "read:user",
    ]);
  });

  it("ignores optional scopes", () => {
    const missing = missingRequiredScopes(gitea, [
      "read:repository",
      "write:repository",
      "read:issue",
      "read:user",
    ]);
    expect(missing).toEqual([]);
  });

  it("treats write:x as satisfying read:x", () => {
    expect(
      missingRequiredScopes(gitea, [
        "read:repository",
        "write:repository",
        "write:issue",
        "read:user",
      ]),
    ).toEqual([]);
  });

  it("treats a parent scope as satisfying its children", () => {
    const github = descriptor("github");
    expect(missingRequiredScopes(github, ["repo"])).toEqual([]);
    expect(missingRequiredScopes(github, ["public_repo"])).toEqual(["repo"]);
  });
});

describe("validation verdicts", () => {
  const github = descriptor("github");

  it("distinguishes an unreachable host", () => {
    const v = verdictFor(github, probe({ outcome: "unreachable", detail: "Refused." }));
    expect(v.code).toBe("unreachable");
    expect(v.canSave).toBe(false);
    expect(v.remedy).toMatch(/instance URL|firewall|DNS/i);
  });

  it("distinguishes a TLS failure from a dead host", () => {
    const v = verdictFor(github, probe({ outcome: "tls_error" }));
    expect(v.code).toBe("tls_error");
    expect(v.remedy).toMatch(/CA certificate/i);
  });

  it("distinguishes a wrong address that answered from a bad token", () => {
    const notHost = verdictFor(github, probe({ outcome: "not_a_host" }));
    const badToken = verdictFor(github, probe({ outcome: "invalid_token" }));
    expect(notHost.code).toBe("not_a_host");
    expect(badToken.code).toBe("invalid_token");
    expect(notHost.title).not.toBe(badToken.title);
  });

  it("distinguishes forbidden (SSO / allow-list) from rejected", () => {
    const v = verdictFor(github, probe({ outcome: "forbidden" }));
    expect(v.code).toBe("forbidden");
    expect(v.remedy).toMatch(/SSO|allow-list/i);
  });

  it("distinguishes rate limiting and server errors", () => {
    expect(verdictFor(github, probe({ outcome: "rate_limited" })).code).toBe("rate_limited");
    expect(verdictFor(github, probe({ outcome: "server_error" })).code).toBe("server_error");
  });

  it("blocks saving a valid token with insufficient scopes and names them", () => {
    const v = verdictFor(github, probe({ scopes: ["read:org"] }));
    expect(v.code).toBe("insufficient_scopes");
    expect(v.canSave).toBe(false);
    expect(v.missingScopes).toEqual(["repo"]);
    expect(v.detail).toContain("octocat");
    expect(v.remedy).toContain("repo");
  });

  it("allows saving but stays honest when the host reports no scope information", () => {
    const v = verdictFor(github, probe({ scopes: null }));
    expect(v.code).toBe("scopes_unknown");
    expect(v.level).toBe("warning");
    expect(v.canSave).toBe(true);
    expect(v.detail).toMatch(/does not report/i);
  });

  it("accepts a fully-scoped token and names the account", () => {
    const v = verdictFor(github, probe({ scopes: ["repo", "read:org"] }));
    expect(v.code).toBe("ok");
    expect(v.level).toBe("ok");
    expect(v.canSave).toBe(true);
    expect(v.title).toContain("octocat");
  });

  it("only ever allows saving on ok / scopes_unknown", () => {
    const outcomes = [
      "invalid_token",
      "forbidden",
      "rate_limited",
      "not_a_host",
      "unreachable",
      "tls_error",
      "server_error",
      "unknown",
    ] as const;
    for (const outcome of outcomes) {
      expect(verdictFor(github, probe({ outcome })).canSave, outcome).toBe(false);
    }
  });
});

describe("connection labelling", () => {
  it("uses the host name for a cloud host", () => {
    expect(defaultConnectionLabel(descriptor("github"), "https://api.github.com")).toBe("GitHub");
  });

  it("uses the instance host for a self-hosted host", () => {
    expect(defaultConnectionLabel(descriptor("gitea"), "https://git.example.com:3000")).toBe(
      "git.example.com:3000",
    );
  });
});
