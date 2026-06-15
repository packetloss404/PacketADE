import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IssueList } from "@/components/views/github/IssueList";
import type { GitHubIssue } from "@/types/github";

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 1,
    title: "Sample issue",
    body: null,
    state: "open",
    labels: [],
    user: { login: "octocat" },
    html_url: "https://example.com/issues/1",
    created_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

interface RenderOpts {
  issues?: GitHubIssue[];
  stateFilter?: "open" | "closed" | "all";
  hasMore?: boolean;
  isLoadingMore?: boolean;
  selectedNum?: number | null;
  searchQuery?: string;
  totalIssues?: number;
  totalLoaded?: number;
  untriagedCount?: number;
  isLoading?: boolean;
  onSelect?: (n: number) => void;
  onSearchChange?: (q: string) => void;
  onStateFilterChange?: (s: "open" | "closed" | "all") => void;
  onLoadMore?: () => void;
  onOpenTriage?: () => void;
}

function renderList(opts: RenderOpts = {}) {
  const props = {
    issues: opts.issues ?? [makeIssue()],
    totalIssues: opts.totalIssues ?? (opts.issues?.length ?? 1),
    isLoading: opts.isLoading ?? false,
    selectedNum: opts.selectedNum ?? null,
    onSelect: opts.onSelect ?? vi.fn(),
    searchQuery: opts.searchQuery ?? "",
    onSearchChange: opts.onSearchChange ?? vi.fn(),
    stateFilter: opts.stateFilter ?? ("open" as const),
    onStateFilterChange: opts.onStateFilterChange ?? vi.fn(),
    hasMore: opts.hasMore ?? false,
    isLoadingMore: opts.isLoadingMore ?? false,
    onLoadMore: opts.onLoadMore ?? vi.fn(),
    totalLoaded: opts.totalLoaded ?? (opts.issues?.length ?? 1),
    onOpenTriage: opts.onOpenTriage ?? vi.fn(),
    untriagedCount: opts.untriagedCount ?? 0,
  };
  return { props, ...render(<IssueList {...props} />) };
}

describe("IssueList", () => {
  it("renders each issue with title, number, and author", () => {
    renderList({
      issues: [
        makeIssue({ number: 12, title: "Crash on launch", user: { login: "alice" } }),
        makeIssue({ number: 13, title: "Slow query", user: { login: "bob" } }),
      ],
    });

    expect(screen.getByText("Crash on launch")).toBeInTheDocument();
    expect(screen.getByText("Slow query")).toBeInTheDocument();
    expect(screen.getByText("#12")).toBeInTheDocument();
    expect(screen.getByText("#13")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  it("fires onStateFilterChange when a chip is clicked", () => {
    const onStateFilterChange = vi.fn();
    renderList({ onStateFilterChange, stateFilter: "open" });

    fireEvent.click(screen.getByRole("button", { name: "Closed" }));
    expect(onStateFilterChange).toHaveBeenCalledWith("closed");

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(onStateFilterChange).toHaveBeenCalledWith("all");
  });

  it("fires onSearchChange as the user types in the filter box", () => {
    const onSearchChange = vi.fn();
    renderList({ onSearchChange });

    fireEvent.change(screen.getByPlaceholderText("filter issues..."), {
      target: { value: "crash" },
    });
    expect(onSearchChange).toHaveBeenCalledWith("crash");
  });

  it("fires onSelect with the issue number when a row is clicked", () => {
    const onSelect = vi.fn();
    renderList({
      onSelect,
      issues: [
        makeIssue({ number: 42, title: "Pick me" }),
        makeIssue({ number: 99, title: "Not me" }),
      ],
    });

    fireEvent.click(screen.getByText("Pick me"));
    expect(onSelect).toHaveBeenCalledWith(42);
  });

  it("renders the Load more button only when hasMore and disables it while loading", () => {
    const onLoadMore = vi.fn();
    const { rerender, props } = renderList({
      hasMore: true,
      isLoadingMore: false,
      onLoadMore,
      issues: [makeIssue()],
      totalLoaded: 30,
    });

    const loadBtn = screen.getByRole("button", { name: /Load more/i });
    expect(loadBtn).not.toBeDisabled();
    fireEvent.click(loadBtn);
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    // Flip to loading — button disables.
    rerender(<IssueList {...props} isLoadingMore={true} />);
    expect(screen.getByRole("button", { name: /Load more/i })).toBeDisabled();

    // Flip hasMore off — button disappears.
    rerender(<IssueList {...props} hasMore={false} isLoadingMore={false} />);
    expect(screen.queryByRole("button", { name: /Load more/i })).toBeNull();
  });

  it("shows the empty state when there are zero issues and not loading", () => {
    renderList({ issues: [], stateFilter: "closed", totalIssues: 0, totalLoaded: 0 });
    expect(screen.getByText(/No closed issues found/i)).toBeInTheDocument();
  });
});
