import { describe, it, expect, beforeEach } from "vitest";
import { useIssueStore, type IssueStatus } from "../issueStore";

/** Helper to get current store state outside of React */
const store = () => useIssueStore.getState();

/** Minimal input for creating an issue */
function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    title: "Test issue",
    description: "A test issue description",
    status: "todo" as IssueStatus,
    priority: "medium" as const,
    labels: [],
    epic: null,
    acceptanceCriteria: [],
    blockedBy: [],
    blocks: [],
    ...overrides,
  };
}

describe("issueStore", () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset the Zustand store to default state
    useIssueStore.setState({
      issues: [],
      nextTicketNum: 1,
      ticketPrefix: "PKT",
      epics: [],
      labels: [
        "bug",
        "feature",
        "enhancement",
        "refactor",
        "docs",
        "api",
        "frontend",
        "working",
        "devops",
      ],
    });
  });

  // ---------------------------------------------------------------------------
  // addIssue / createIssue
  // ---------------------------------------------------------------------------
  describe("addIssue", () => {
    it("creates an issue with correct defaults and generated fields", () => {
      const created = store().addIssue(makeIssue());
      expect(created.id).toMatch(/^issue_/);
      expect(created.ticketId).toBe("PKT-001");
      expect(created.title).toBe("Test issue");
      expect(created.status).toBe("todo");
      expect(created.priority).toBe("medium");
      expect(created.flightId).toBeNull();
      expect(created.createdAt).toBeTypeOf("number");
      expect(created.updatedAt).toBeTypeOf("number");
      expect(store().issues).toHaveLength(1);
    });

    it("increments ticket number on successive creates", () => {
      store().addIssue(makeIssue({ title: "First" }));
      store().addIssue(makeIssue({ title: "Second" }));
      const third = store().addIssue(makeIssue({ title: "Third" }));
      expect(third.ticketId).toBe("PKT-003");
      expect(store().nextTicketNum).toBe(4);
    });

    it("uses custom ticket prefix", () => {
      store().setTicketPrefix("APP");
      const issue = store().addIssue(makeIssue());
      expect(issue.ticketId).toBe("APP-001");
    });

    it("accepts an explicit flightId", () => {
      const issue = store().addIssue(makeIssue({ flightId: "flight_123" }));
      expect(issue.flightId).toBe("flight_123");
    });

    it("persists to localStorage", () => {
      store().addIssue(makeIssue());
      const raw = localStorage.getItem("packetade:issues");
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed.issues).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // deleteIssue
  // ---------------------------------------------------------------------------
  describe("deleteIssue", () => {
    it("removes the issue from the store", () => {
      const issue = store().addIssue(makeIssue());
      expect(store().issues).toHaveLength(1);
      store().deleteIssue(issue.id);
      expect(store().issues).toHaveLength(0);
    });

    it("does not crash when deleting a nonexistent issue", () => {
      store().addIssue(makeIssue());
      expect(() => store().deleteIssue("nonexistent_id")).not.toThrow();
      expect(store().issues).toHaveLength(1);
    });

    it("cleans up dependency references in other issues", () => {
      const a = store().addIssue(makeIssue({ title: "A" }));
      const b = store().addIssue(makeIssue({ title: "B" }));
      store().addBlockedBy(b.id, a.id); // B is blocked by A
      // Verify linkage exists
      expect(store().issues.find((i) => i.id === b.id)!.blockedBy).toContain(a.id);
      // Delete A — B's blockedBy should be cleaned
      store().deleteIssue(a.id);
      const bAfter = store().issues.find((i) => i.id === b.id)!;
      expect(bAfter.blockedBy).not.toContain(a.id);
    });
  });

  // ---------------------------------------------------------------------------
  // moveIssue
  // ---------------------------------------------------------------------------
  describe("moveIssue", () => {
    it("changes the status of an issue", () => {
      const issue = store().addIssue(makeIssue({ status: "todo" }));
      store().moveIssue(issue.id, "in_progress");
      expect(store().issues[0].status).toBe("in_progress");
    });

    it("updates the updatedAt timestamp", () => {
      const issue = store().addIssue(makeIssue());
      const before = issue.updatedAt;
      // Small delay to ensure timestamp differs
      store().moveIssue(issue.id, "done");
      expect(store().issues[0].updatedAt).toBeGreaterThanOrEqual(before);
    });

    it("does not crash when moving a nonexistent issue", () => {
      expect(() => store().moveIssue("nonexistent_id", "done")).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // updateIssue
  // ---------------------------------------------------------------------------
  describe("updateIssue", () => {
    it("updates arbitrary fields", () => {
      const issue = store().addIssue(makeIssue());
      store().updateIssue(issue.id, { title: "Updated title", priority: "critical" });
      const updated = store().issues[0];
      expect(updated.title).toBe("Updated title");
      expect(updated.priority).toBe("critical");
    });

    it("does not crash for nonexistent issue", () => {
      expect(() => store().updateIssue("nonexistent", { title: "nope" })).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // assignToFlight / unassign
  // ---------------------------------------------------------------------------
  describe("assignToFlight", () => {
    it("sets flightId on an issue", () => {
      const issue = store().addIssue(makeIssue());
      store().assignToFlight(issue.id, "flight_abc");
      expect(store().issues[0].flightId).toBe("flight_abc");
    });

    it("clears flightId when passed null", () => {
      const issue = store().addIssue(makeIssue({ flightId: "flight_abc" }));
      store().assignToFlight(issue.id, null);
      expect(store().issues[0].flightId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getIssuesByStatus
  // ---------------------------------------------------------------------------
  describe("getIssuesByStatus", () => {
    it("filters issues by status", () => {
      store().addIssue(makeIssue({ title: "A", status: "todo" }));
      store().addIssue(makeIssue({ title: "B", status: "in_progress" }));
      store().addIssue(makeIssue({ title: "C", status: "todo" }));
      const todos = store().getIssuesByStatus("todo");
      expect(todos).toHaveLength(2);
      expect(todos.map((i) => i.title)).toEqual(["A", "C"]);
    });

    it("returns empty array when no issues match", () => {
      store().addIssue(makeIssue({ status: "todo" }));
      expect(store().getIssuesByStatus("done")).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getColumns
  // ---------------------------------------------------------------------------
  describe("getColumns", () => {
    it("returns the status column definitions", () => {
      const cols = store().getColumns();
      // v0.8.5: the column set was extended additively with `backlog`,
      // `up_next`, and `in_review` to back the new five-column Kanban.
      expect(cols).toHaveLength(9);
      expect(cols.map((c) => c.key)).toEqual([
        "backlog",
        "up_next",
        "todo",
        "in_progress",
        "in_review",
        "qa",
        "done",
        "blocked",
        "needs_human",
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Epics and Labels
  // ---------------------------------------------------------------------------
  describe("addEpic / addLabel", () => {
    it("adds a new epic", () => {
      store().addEpic("Authentication");
      expect(store().epics).toContain("Authentication");
    });

    it("does not duplicate an existing epic", () => {
      store().addEpic("Authentication");
      store().addEpic("Authentication");
      expect(store().epics.filter((e) => e === "Authentication")).toHaveLength(1);
    });

    it("adds a new label", () => {
      store().addLabel("security");
      expect(store().labels).toContain("security");
    });

    it("does not duplicate an existing label", () => {
      store().addLabel("bug");
      // "bug" is in defaults, should still only appear once
      expect(store().labels.filter((l) => l === "bug")).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Acceptance criteria
  // ---------------------------------------------------------------------------
  describe("acceptance criteria", () => {
    it("adds a criterion to an issue", () => {
      const issue = store().addIssue(makeIssue());
      store().addCriterion(issue.id, "Must handle edge case");
      const updated = store().issues[0];
      expect(updated.acceptanceCriteria).toHaveLength(1);
      expect(updated.acceptanceCriteria[0].text).toBe("Must handle edge case");
      expect(updated.acceptanceCriteria[0].checked).toBe(false);
    });

    it("toggles a criterion", () => {
      const issue = store().addIssue(makeIssue());
      store().addCriterion(issue.id, "Criterion 1");
      const criterionId = store().issues[0].acceptanceCriteria[0].id;
      store().toggleCriterion(issue.id, criterionId);
      expect(store().issues[0].acceptanceCriteria[0].checked).toBe(true);
      store().toggleCriterion(issue.id, criterionId);
      expect(store().issues[0].acceptanceCriteria[0].checked).toBe(false);
    });

    it("removes a criterion", () => {
      const issue = store().addIssue(makeIssue());
      store().addCriterion(issue.id, "Criterion 1");
      store().addCriterion(issue.id, "Criterion 2");
      const criterionId = store().issues[0].acceptanceCriteria[0].id;
      store().removeCriterion(issue.id, criterionId);
      expect(store().issues[0].acceptanceCriteria).toHaveLength(1);
      expect(store().issues[0].acceptanceCriteria[0].text).toBe("Criterion 2");
    });

    it("no-ops for nonexistent issue", () => {
      expect(() => store().addCriterion("fake", "text")).not.toThrow();
      expect(() => store().toggleCriterion("fake", "fake")).not.toThrow();
      expect(() => store().removeCriterion("fake", "fake")).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Dependencies (blockedBy / blocks)
  // ---------------------------------------------------------------------------
  describe("dependencies", () => {
    it("addBlockedBy creates bidirectional link", () => {
      const a = store().addIssue(makeIssue({ title: "A" }));
      const b = store().addIssue(makeIssue({ title: "B" }));
      store().addBlockedBy(b.id, a.id); // B is blocked by A
      const bState = store().issues.find((i) => i.id === b.id)!;
      const aState = store().issues.find((i) => i.id === a.id)!;
      expect(bState.blockedBy).toContain(a.id);
      expect(aState.blocks).toContain(b.id);
    });

    it("removeBlockedBy clears bidirectional link", () => {
      const a = store().addIssue(makeIssue({ title: "A" }));
      const b = store().addIssue(makeIssue({ title: "B" }));
      store().addBlockedBy(b.id, a.id);
      store().removeBlockedBy(b.id, a.id);
      const bState = store().issues.find((i) => i.id === b.id)!;
      const aState = store().issues.find((i) => i.id === a.id)!;
      expect(bState.blockedBy).not.toContain(a.id);
      expect(aState.blocks).not.toContain(b.id);
    });

    it("addBlocks creates bidirectional link", () => {
      const a = store().addIssue(makeIssue({ title: "A" }));
      const b = store().addIssue(makeIssue({ title: "B" }));
      store().addBlocks(a.id, b.id); // A blocks B
      const aState = store().issues.find((i) => i.id === a.id)!;
      const bState = store().issues.find((i) => i.id === b.id)!;
      expect(aState.blocks).toContain(b.id);
      expect(bState.blockedBy).toContain(a.id);
    });

    it("removeBlocks clears bidirectional link", () => {
      const a = store().addIssue(makeIssue({ title: "A" }));
      const b = store().addIssue(makeIssue({ title: "B" }));
      store().addBlocks(a.id, b.id);
      store().removeBlocks(a.id, b.id);
      const aState = store().issues.find((i) => i.id === a.id)!;
      const bState = store().issues.find((i) => i.id === b.id)!;
      expect(aState.blocks).not.toContain(b.id);
      expect(bState.blockedBy).not.toContain(a.id);
    });

    it("does not duplicate dependency links", () => {
      const a = store().addIssue(makeIssue({ title: "A" }));
      const b = store().addIssue(makeIssue({ title: "B" }));
      store().addBlockedBy(b.id, a.id);
      store().addBlockedBy(b.id, a.id); // duplicate call
      const bState = store().issues.find((i) => i.id === b.id)!;
      expect(bState.blockedBy.filter((id) => id === a.id)).toHaveLength(1);
    });

    it("prevents contradictory direct dependency cycles", () => {
      const a = store().addIssue(makeIssue({ title: "A" }));
      const b = store().addIssue(makeIssue({ title: "B" }));

      store().addBlocks(a.id, b.id);
      store().addBlockedBy(a.id, b.id);

      let aState = store().issues.find((i) => i.id === a.id)!;
      let bState = store().issues.find((i) => i.id === b.id)!;
      expect(aState.blocks).toContain(b.id);
      expect(aState.blockedBy).not.toContain(b.id);
      expect(bState.blockedBy).toContain(a.id);
      expect(bState.blocks).not.toContain(a.id);

      store().removeBlocks(a.id, b.id);
      store().addBlockedBy(a.id, b.id);
      store().addBlocks(a.id, b.id);

      aState = store().issues.find((i) => i.id === a.id)!;
      bState = store().issues.find((i) => i.id === b.id)!;
      expect(aState.blockedBy).toContain(b.id);
      expect(aState.blocks).not.toContain(b.id);
      expect(bState.blocks).toContain(a.id);
      expect(bState.blockedBy).not.toContain(a.id);
    });

    it("no-ops for nonexistent issues", () => {
      expect(() => store().addBlockedBy("fake1", "fake2")).not.toThrow();
      expect(() => store().removeBlockedBy("fake1", "fake2")).not.toThrow();
      expect(() => store().addBlocks("fake1", "fake2")).not.toThrow();
      expect(() => store().removeBlocks("fake1", "fake2")).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // setTicketPrefix
  // ---------------------------------------------------------------------------
  describe("setTicketPrefix", () => {
    it("changes the prefix used for new tickets", () => {
      store().setTicketPrefix("MY");
      const issue = store().addIssue(makeIssue());
      expect(issue.ticketId).toBe("MY-001");
    });

    it("persists the prefix to localStorage", () => {
      store().setTicketPrefix("NEW");
      const raw = JSON.parse(localStorage.getItem("packetade:issues")!);
      expect(raw.ticketPrefix).toBe("NEW");
    });
  });

  // ---------------------------------------------------------------------------
  // v0.8.5: inline comments
  // ---------------------------------------------------------------------------
  describe("addIssueComment / deleteIssueComment", () => {
    it("appends a user comment and bumps updatedAt", async () => {
      const created = store().addIssue(makeIssue());
      const original = created.updatedAt;
      // Give the clock a chance to tick so updatedAt is observably newer.
      await new Promise((r) => setTimeout(r, 2));

      const comment = store().addIssueComment(created.id, "  first thought  ");
      expect(comment).not.toBeNull();
      expect(comment!.author).toBe("user");
      expect(comment!.body).toBe("first thought");

      const after = store().issues[0];
      expect(after.comments).toHaveLength(1);
      expect(after.comments![0].id).toBe(comment!.id);
      expect(after.updatedAt).toBeGreaterThan(original);
    });

    it("supports system and agent authorship", () => {
      const created = store().addIssue(makeIssue());
      store().addIssueComment(created.id, "agent note", "agent");
      store().addIssueComment(created.id, "system note", "system");
      const comments = store().issues[0].comments!;
      expect(comments.map((c) => c.author)).toEqual(["agent", "system"]);
    });

    it("rejects empty / whitespace-only bodies", () => {
      const created = store().addIssue(makeIssue());
      expect(store().addIssueComment(created.id, "   ")).toBeNull();
      expect(store().addIssueComment(created.id, "")).toBeNull();
      expect(store().issues[0].comments).toBeUndefined();
    });

    it("deletes a comment by id", () => {
      const created = store().addIssue(makeIssue());
      const c1 = store().addIssueComment(created.id, "first")!;
      const c2 = store().addIssueComment(created.id, "second")!;
      store().deleteIssueComment(created.id, c1.id);
      const remaining = store().issues[0].comments!;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(c2.id);
    });
  });
});
