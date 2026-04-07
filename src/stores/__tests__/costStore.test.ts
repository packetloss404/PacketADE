import { describe, it, expect, beforeEach } from "vitest";
import { useCostStore } from "../costStore";

const STORAGE_KEY = "packetcode:cost-entries";
const store = () => useCostStore.getState();

describe("costStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useCostStore.setState({ entries: [] });
  });

  describe("recordCost", () => {
    it("records a cost entry", () => {
      store().recordCost("sess_1", 0.25, "sonnet");
      expect(store().entries).toHaveLength(1);
      expect(store().entries[0]).toMatchObject({ sessionId: "sess_1", cost: 0.25, model: "sonnet" });
    });

    it("persists entries to localStorage", () => {
      store().recordCost("sess_1", 0.1, "sonnet");
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(raw).toHaveLength(1);
    });

    it("ignores non-positive cost", () => {
      store().recordCost("sess_1", 0, "sonnet");
      store().recordCost("sess_1", -1, "sonnet");
      expect(store().entries).toHaveLength(0);
    });

    it("deduplicates same cost for same session", () => {
      store().recordCost("sess_1", 0.25, "sonnet");
      store().recordCost("sess_1", 0.25, "sonnet");
      expect(store().entries).toHaveLength(1);
    });

    it("records increased cost for the same session", () => {
      store().recordCost("sess_1", 0.25, "sonnet");
      store().recordCost("sess_1", 0.5, "sonnet");
      expect(store().entries).toHaveLength(2);
    });

    it("trims to the most recent 1000 entries", () => {
      const bulk: Array<{ sessionId: string; timestamp: number; cost: number; model: string }> = [];
      for (let i = 0; i < 1000; i++) {
        bulk.push({ sessionId: `s_${i}`, timestamp: i, cost: 0.01 * (i + 1), model: "sonnet" });
      }
      useCostStore.setState({ entries: bulk });
      store().recordCost("s_new", 0.99, "sonnet");
      expect(store().entries).toHaveLength(1000);
      expect(store().entries[store().entries.length - 1].sessionId).toBe("s_new");
    });
  });

  describe("clearEntries", () => {
    it("removes all entries and persists", () => {
      store().recordCost("sess_1", 0.25, "sonnet");
      store().clearEntries();
      expect(store().entries).toHaveLength(0);
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual([]);
    });
  });

  describe("getSummary", () => {
    it("returns zeros for empty store", () => {
      const s = store().getSummary();
      expect(s.totalCost).toBe(0);
      expect(s.sessionCount).toBe(0);
      expect(s.costByDay).toEqual({});
      expect(s.costByModel).toEqual({});
    });

    it("computes total using max cost per session", () => {
      store().recordCost("sess_1", 0.2, "sonnet");
      store().recordCost("sess_1", 0.5, "sonnet"); // cost grew
      store().recordCost("sess_2", 0.3, "opus");
      const s = store().getSummary();
      // max per session: sess_1=0.5, sess_2=0.3 → total 0.8
      expect(s.totalCost).toBeCloseTo(0.8, 5);
      expect(s.sessionCount).toBe(2);
    });

    it("aggregates costs by model using raw entries", () => {
      store().recordCost("sess_1", 0.2, "sonnet");
      store().recordCost("sess_2", 0.5, "opus");
      store().recordCost("sess_3", 0.1, "sonnet");
      const s = store().getSummary();
      expect(s.costByModel.sonnet).toBeCloseTo(0.3, 5);
      expect(s.costByModel.opus).toBeCloseTo(0.5, 5);
    });

    it("groups costs by ISO day", () => {
      const day1 = new Date("2025-01-01T10:00:00Z").getTime();
      const day2 = new Date("2025-01-02T10:00:00Z").getTime();
      useCostStore.setState({
        entries: [
          { sessionId: "a", timestamp: day1, cost: 0.1, model: "sonnet" },
          { sessionId: "b", timestamp: day1, cost: 0.2, model: "sonnet" },
          { sessionId: "c", timestamp: day2, cost: 0.5, model: "opus" },
        ],
      });
      const s = store().getSummary();
      expect(s.costByDay["2025-01-01"]).toBeCloseTo(0.3, 5);
      expect(s.costByDay["2025-01-02"]).toBeCloseTo(0.5, 5);
    });
  });
});
