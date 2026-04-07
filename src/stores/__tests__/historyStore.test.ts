import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useHistoryStore, type HistoryEntry } from "../historyStore";

const store = () => useHistoryStore.getState();

const sample: HistoryEntry[] = [
  { display: "Hello world", timestamp: 100, project: "/a", sessionId: "s1" },
  { display: "Build feature X", timestamp: 300, project: "/b", sessionId: "s2" },
  { display: "fix bug", timestamp: 200, project: "/a", sessionId: "s3" },
];

describe("historyStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useHistoryStore.setState({
      entries: [],
      loading: false,
      error: null,
      searchQuery: "",
      projectFilter: null,
    });
  });

  describe("load", () => {
    it("parses backend JSON and sorts by timestamp descending", async () => {
      invokeMock.mockResolvedValueOnce(JSON.stringify(sample));
      await store().load();
      expect(store().loading).toBe(false);
      expect(store().error).toBeNull();
      expect(store().entries.map((e) => e.sessionId)).toEqual(["s2", "s3", "s1"]);
    });

    it("sets error on invoke failure", async () => {
      invokeMock.mockRejectedValueOnce(new Error("boom"));
      await store().load();
      expect(store().loading).toBe(false);
      expect(store().error).toBe("boom");
      expect(store().entries).toEqual([]);
    });

    it("sets error on invalid JSON", async () => {
      invokeMock.mockResolvedValueOnce("not json");
      await store().load();
      expect(store().loading).toBe(false);
      expect(store().error).toBeTruthy();
    });
  });

  describe("filteredEntries", () => {
    beforeEach(() => {
      useHistoryStore.setState({ entries: [...sample].sort((a, b) => b.timestamp - a.timestamp) });
    });

    it("returns all entries when no filter is applied", () => {
      expect(store().filteredEntries()).toHaveLength(3);
    });

    it("filters by project", () => {
      store().setProjectFilter("/a");
      const res = store().filteredEntries();
      expect(res.map((e) => e.sessionId).sort()).toEqual(["s1", "s3"]);
    });

    it("filters by search query, case-insensitively", () => {
      store().setSearchQuery("BUILD");
      const res = store().filteredEntries();
      expect(res).toHaveLength(1);
      expect(res[0].sessionId).toBe("s2");
    });

    it("combines project and search filters", () => {
      store().setProjectFilter("/a");
      store().setSearchQuery("hello");
      const res = store().filteredEntries();
      expect(res).toHaveLength(1);
      expect(res[0].sessionId).toBe("s1");
    });

    it("ignores whitespace-only search queries", () => {
      store().setSearchQuery("   ");
      expect(store().filteredEntries()).toHaveLength(3);
    });
  });

  describe("uniqueProjects", () => {
    it("returns sorted unique project paths", () => {
      useHistoryStore.setState({ entries: sample });
      expect(store().uniqueProjects()).toEqual(["/a", "/b"]);
    });

    it("excludes empty project strings", () => {
      useHistoryStore.setState({
        entries: [
          { display: "a", timestamp: 1, project: "", sessionId: "x" },
          { display: "b", timestamp: 2, project: "/x", sessionId: "y" },
        ],
      });
      expect(store().uniqueProjects()).toEqual(["/x"]);
    });
  });
});
