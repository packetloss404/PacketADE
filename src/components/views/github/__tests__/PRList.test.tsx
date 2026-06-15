import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GitHubPr } from "@/types/github";

// Stub PrCheckPill so we can assert that PRList passes each PR through
// without dragging in the pill's githubStore fetch logic. The mock
// records the `pr.number` it receives via a data attribute so the test
// can verify the prop wiring.
vi.mock("@/components/views/github/PrCheckPill", () => ({
  PrCheckPill: ({ pr }: { pr: GitHubPr }) => (
    <span data-testid="pr-check-pill" data-pr-number={pr.number} />
  ),
}));

import { PRList } from "@/components/views/github/PRList";

function makePr(overrides: Partial<GitHubPr> = {}): GitHubPr {
  return {
    number: 1,
    title: "Sample PR",
    user: { login: "octocat" },
    head: { ref: "feature/x" },
    base: { ref: "main" },
    html_url: "https://example.com/pulls/1",
    state: "open",
    created_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

interface RenderOpts {
  prs?: GitHubPr[];
  stateFilter?: "open" | "closed" | "all";
  hasMore?: boolean;
  isLoadingMore?: boolean;
  selectedNum?: number | null;
  isLoading?: boolean;
  onSelect?: (n: number) => void;
  onStateFilterChange?: (s: "open" | "closed" | "all") => void;
  onLoadMore?: () => void;
}

function renderList(opts: RenderOpts = {}) {
  const props = {
    prs: opts.prs ?? [makePr()],
    isLoading: opts.isLoading ?? false,
    selectedNum: opts.selectedNum ?? null,
    onSelect: opts.onSelect ?? vi.fn(),
    stateFilter: opts.stateFilter ?? ("open" as const),
    onStateFilterChange: opts.onStateFilterChange ?? vi.fn(),
    hasMore: opts.hasMore ?? false,
    isLoadingMore: opts.isLoadingMore ?? false,
    onLoadMore: opts.onLoadMore ?? vi.fn(),
  };
  return { props, ...render(<PRList {...props} />) };
}

describe("PRList", () => {
  it("renders each PR with title, head/base refs, and author", () => {
    renderList({
      prs: [
        makePr({
          number: 100,
          title: "Add foo",
          user: { login: "alice" },
          head: { ref: "feat/foo" },
          base: { ref: "develop" },
        }),
        makePr({
          number: 101,
          title: "Fix bar",
          user: { login: "bob" },
          head: { ref: "fix/bar" },
          base: { ref: "main" },
        }),
      ],
    });

    expect(screen.getByText("Add foo")).toBeInTheDocument();
    expect(screen.getByText("Fix bar")).toBeInTheDocument();
    expect(screen.getByText("#100")).toBeInTheDocument();
    expect(screen.getByText("#101")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
    expect(screen.getByText("feat/foo")).toBeInTheDocument();
    expect(screen.getByText("develop")).toBeInTheDocument();
    expect(screen.getByText("fix/bar")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
  });

  it("renders the draft badge only for draft PRs", () => {
    renderList({
      prs: [
        makePr({ number: 1, title: "Ready PR", draft: false }),
        makePr({ number: 2, title: "Draft PR", draft: true }),
      ],
    });

    const drafts = screen.getAllByText("draft");
    expect(drafts).toHaveLength(1);
  });

  it("fires onStateFilterChange when a chip is clicked", () => {
    const onStateFilterChange = vi.fn();
    renderList({ onStateFilterChange, stateFilter: "open" });

    fireEvent.click(screen.getByRole("button", { name: "Closed" }));
    expect(onStateFilterChange).toHaveBeenCalledWith("closed");
  });

  it("fires onSelect when a row is clicked", () => {
    const onSelect = vi.fn();
    renderList({
      onSelect,
      prs: [
        makePr({ number: 7, title: "Click me" }),
        makePr({ number: 8, title: "Not clicked" }),
      ],
    });

    fireEvent.click(screen.getByText("Click me"));
    expect(onSelect).toHaveBeenCalledWith(7);
  });

  it("renders a PrCheckPill for each PR, wired to the correct pr.number", () => {
    renderList({
      prs: [makePr({ number: 11 }), makePr({ number: 22 }), makePr({ number: 33 })],
    });

    const pills = screen.getAllByTestId("pr-check-pill");
    expect(pills).toHaveLength(3);
    const numbers = pills.map((p) => p.getAttribute("data-pr-number"));
    expect(numbers).toEqual(["11", "22", "33"]);
  });
});
