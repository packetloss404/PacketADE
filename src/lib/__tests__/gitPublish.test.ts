import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gitPushBranch: vi.fn(),
  githubCreatePr: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  gitPushBranch: mocks.gitPushBranch,
  githubCreatePr: mocks.githubCreatePr,
}));

import { publishBranchAsPr } from "@/lib/gitPublish";

const baseInput = {
  worktreePath: "/repo/.pkt-worktrees/conv-1",
  branch: "pkt/conv-1",
  baseBranch: "main",
  owner: "acme",
  repo: "widget",
  title: "Land conv-1",
  body: "body",
};

describe("gitPublish.publishBranchAsPr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gitPushBranch.mockResolvedValue(undefined);
    mocks.githubCreatePr.mockResolvedValue(JSON.stringify({ number: 42 }));
  });

  it("pushes the branch then opens a draft PR and records the PR number", async () => {
    const result = await publishBranchAsPr(baseInput);

    expect(mocks.gitPushBranch).toHaveBeenCalledWith("/repo/.pkt-worktrees/conv-1", "pkt/conv-1", false);
    // draft defaults to true.
    expect(mocks.githubCreatePr).toHaveBeenCalledWith(
      "acme",
      "widget",
      "Land conv-1",
      "body",
      "pkt/conv-1",
      "main",
      true,
    );
    expect(result).toEqual({ ok: true, prNumber: 42 });
  });

  it("passes draft:false through to githubCreatePr", async () => {
    await publishBranchAsPr({ ...baseInput, draft: false });
    expect(mocks.githubCreatePr).toHaveBeenCalledWith(
      "acme",
      "widget",
      "Land conv-1",
      "body",
      "pkt/conv-1",
      "main",
      false,
    );
  });

  it("does not open a PR when the push fails, classified as stage 'push'", async () => {
    mocks.gitPushBranch.mockRejectedValue("remote rejected");
    const result = await publishBranchAsPr(baseInput);
    expect(result).toEqual({ ok: false, stage: "push", message: "remote rejected" });
    expect(mocks.githubCreatePr).not.toHaveBeenCalled();
  });

  it("classifies a create_pr failure as stage 'create_pr'", async () => {
    mocks.githubCreatePr.mockRejectedValue(new Error("422 Unprocessable"));
    const result = await publishBranchAsPr(baseInput);
    expect(result).toEqual({ ok: false, stage: "create_pr", message: "422 Unprocessable" });
  });

  it("returns prNumber null when GitHub succeeds without a number", async () => {
    mocks.githubCreatePr.mockResolvedValue(JSON.stringify({ html_url: "x" }));
    const result = await publishBranchAsPr(baseInput);
    expect(result).toEqual({ ok: true, prNumber: null });
  });
});
