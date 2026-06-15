import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GitHubIssue, GitHubPr } from "@/types/github";

// Stub AICatchUpButton — its real implementation pulls in tauri event
// listeners + the githubStore. We only need to verify visibility.
vi.mock("@/components/views/github/AICatchUpButton", () => ({
  AICatchUpButton: ({ owner, repo }: { owner: string; repo: string }) => (
    <div data-testid="ai-catch-up" data-owner={owner} data-repo={repo} />
  ),
}));

import { ActivityFeed } from "@/components/views/github/ActivityFeed";

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 1,
    title: "Issue",
    body: null,
    state: "open",
    labels: [],
    user: { login: "octocat" },
    html_url: "https://example.com",
    created_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

function makePr(overrides: Partial<GitHubPr> = {}): GitHubPr {
  return {
    number: 1,
    title: "PR",
    user: { login: "octocat" },
    head: { ref: "feat/x" },
    base: { ref: "main" },
    html_url: "https://example.com",
    state: "open",
    created_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

describe("ActivityFeed", () => {
  it("merges PRs and issues into a single chronologically-descending list", () => {
    render(
      <ActivityFeed
        owner="acme"
        repo="widgets"
        issues={[
          makeIssue({
            number: 10,
            title: "Old issue",
            created_at: "2026-04-01T00:00:00Z",
          }),
          makeIssue({
            number: 11,
            title: "Newest issue",
            created_at: "2026-05-10T00:00:00Z",
          }),
        ]}
        prs={[
          makePr({
            number: 20,
            title: "Middle PR",
            created_at: "2026-05-05T00:00:00Z",
          }),
        ]}
      />,
    );

    const oldIssue = screen.getByText("Old issue");
    const middlePr = screen.getByText("Middle PR");
    const newestIssue = screen.getByText("Newest issue");

    expect(oldIssue).toBeInTheDocument();
    expect(middlePr).toBeInTheDocument();
    expect(newestIssue).toBeInTheDocument();

    // documentElement uses `compareDocumentPosition`; PRECEDING = 0x02
    // means `other` precedes the reference. Newest should precede middle,
    // which should precede oldest.
    const PRECEDING = Node.DOCUMENT_POSITION_PRECEDING;
    expect(newestIssue.compareDocumentPosition(middlePr) & PRECEDING).toBe(0);
    expect(middlePr.compareDocumentPosition(oldIssue) & PRECEDING).toBe(0);
  });

  it("renders distinct icon containers per kind (pr vs issue)", () => {
    const { container } = render(
      <ActivityFeed
        owner="acme"
        repo="widgets"
        issues={[makeIssue({ number: 1, title: "An issue" })]}
        prs={[makePr({ number: 2, title: "A pr" })]}
      />,
    );

    // The colored ring around each timeline icon carries the tone class
    // (text-accent-purple for PRs, text-accent-green for issues). Pull
    // the two ring spans and verify they got distinct tones.
    const purpleRing = container.querySelector(".text-accent-purple");
    const greenRing = container.querySelector(".text-accent-green");
    expect(purpleRing).not.toBeNull();
    expect(greenRing).not.toBeNull();
  });

  it("renders AICatchUpButton only when owner and repo are non-empty", () => {
    const { rerender } = render(
      <ActivityFeed owner="acme" repo="widgets" issues={[]} prs={[]} />,
    );
    expect(screen.getByTestId("ai-catch-up")).toBeInTheDocument();
    expect(screen.getByTestId("ai-catch-up").getAttribute("data-owner")).toBe("acme");

    rerender(<ActivityFeed owner="" repo="widgets" issues={[]} prs={[]} />);
    expect(screen.queryByTestId("ai-catch-up")).toBeNull();

    rerender(<ActivityFeed owner="acme" repo="" issues={[]} prs={[]} />);
    expect(screen.queryByTestId("ai-catch-up")).toBeNull();
  });

  it("renders an empty state when there are no activity items", () => {
    render(<ActivityFeed owner="acme" repo="widgets" issues={[]} prs={[]} />);

    expect(screen.getByText(/No recent activity yet/i)).toBeInTheDocument();
    // Sanity: the header is still mounted.
    expect(within(document.body).getByText("Recent activity")).toBeInTheDocument();
  });
});
