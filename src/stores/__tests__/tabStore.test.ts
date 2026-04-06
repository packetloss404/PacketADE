import { describe, it, expect, beforeEach } from "vitest";
import { useTabStore, SessionTab, SessionStatus } from "../tabStore";

function makeTab(overrides: Partial<Omit<SessionTab, "statusLabel" | "durationMs">> = {}) {
  return {
    id: overrides.id ?? "tab-1",
    ptySessionId: overrides.ptySessionId ?? "pty-1",
    name: overrides.name ?? "Session 1",
    ticketId: overrides.ticketId ?? null,
    status: overrides.status ?? ("idle" as SessionStatus),
    startedAt: overrides.startedAt ?? Date.now(),
    projectPath: overrides.projectPath ?? "/projects/test",
  };
}

describe("tabStore", () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null });
  });

  // ── addTab ──────────────────────────────────────────────────────────

  describe("addTab", () => {
    it("creates a tab with correct defaults", () => {
      useTabStore.getState().addTab(makeTab());
      const tabs = useTabStore.getState().tabs;

      expect(tabs).toHaveLength(1);
      expect(tabs[0].id).toBe("tab-1");
      expect(tabs[0].ptySessionId).toBe("pty-1");
      expect(tabs[0].name).toBe("Session 1");
      expect(tabs[0].ticketId).toBeNull();
      expect(tabs[0].status).toBe("idle");
      expect(tabs[0].durationMs).toBe(0);
      expect(tabs[0].statusLabel).toBe("Idle");
    });

    it("sets the new tab as active", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-a" }));
      expect(useTabStore.getState().activeTabId).toBe("tab-a");
    });

    it("sets the latest added tab as active", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-a" }));
      useTabStore.getState().addTab(makeTab({ id: "tab-b" }));
      expect(useTabStore.getState().activeTabId).toBe("tab-b");
      expect(useTabStore.getState().tabs).toHaveLength(2);
    });

    it("assigns a statusLabel from the matching status pool", () => {
      useTabStore.getState().addTab(makeTab({ status: "error" }));
      expect(useTabStore.getState().tabs[0].statusLabel).toBe("Error");
    });
  });

  // ── removeTab ───────────────────────────────────────────────────────

  describe("removeTab", () => {
    it("removes the specified tab", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-1" }));
      useTabStore.getState().addTab(makeTab({ id: "tab-2" }));
      useTabStore.getState().removeTab("tab-1");

      const tabs = useTabStore.getState().tabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0].id).toBe("tab-2");
    });

    it("switches active tab to the last remaining tab when the active tab is removed", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-1" }));
      useTabStore.getState().addTab(makeTab({ id: "tab-2" }));
      useTabStore.getState().addTab(makeTab({ id: "tab-3" }));
      // active is tab-3
      useTabStore.getState().setActiveTab("tab-3");
      useTabStore.getState().removeTab("tab-3");

      expect(useTabStore.getState().activeTabId).toBe("tab-2");
    });

    it("sets activeTabId to null when the last tab is removed", () => {
      useTabStore.getState().addTab(makeTab({ id: "only" }));
      useTabStore.getState().removeTab("only");

      expect(useTabStore.getState().tabs).toHaveLength(0);
      expect(useTabStore.getState().activeTabId).toBeNull();
    });

    it("keeps activeTabId unchanged when a non-active tab is removed", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-1" }));
      useTabStore.getState().addTab(makeTab({ id: "tab-2" }));
      useTabStore.getState().setActiveTab("tab-1");
      useTabStore.getState().removeTab("tab-2");

      expect(useTabStore.getState().activeTabId).toBe("tab-1");
    });

    it("does nothing when removing a nonexistent tab", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-1" }));
      useTabStore.getState().removeTab("nonexistent");

      expect(useTabStore.getState().tabs).toHaveLength(1);
      expect(useTabStore.getState().activeTabId).toBe("tab-1");
    });
  });

  // ── setActiveTab ────────────────────────────────────────────────────

  describe("setActiveTab", () => {
    it("sets the active tab id", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-1" }));
      useTabStore.getState().addTab(makeTab({ id: "tab-2" }));
      useTabStore.getState().setActiveTab("tab-1");

      expect(useTabStore.getState().activeTabId).toBe("tab-1");
    });
  });

  // ── updateTabStatus ─────────────────────────────────────────────────

  describe("updateTabStatus", () => {
    it("changes the status and assigns a new statusLabel", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-1", status: "idle" }));
      useTabStore.getState().updateTabStatus("tab-1", "error");

      const tab = useTabStore.getState().getTab("tab-1")!;
      expect(tab.status).toBe("error");
      expect(tab.statusLabel).toBe("Error");
    });

    it("includes duration in the done statusLabel", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-1", status: "running" }));
      useTabStore.getState().updateTabDuration("tab-1", 125000); // 2m 5s
      useTabStore.getState().updateTabStatus("tab-1", "done");

      const tab = useTabStore.getState().getTab("tab-1")!;
      expect(tab.status).toBe("done");
      expect(tab.statusLabel).toMatch(/2m 5s/);
    });

    it("does not modify other tabs", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-1", status: "idle" }));
      useTabStore.getState().addTab(makeTab({ id: "tab-2", status: "idle" }));
      useTabStore.getState().updateTabStatus("tab-1", "thinking");

      expect(useTabStore.getState().getTab("tab-2")!.status).toBe("idle");
    });

    it("is a no-op for a nonexistent tab", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-1" }));
      useTabStore.getState().updateTabStatus("nonexistent", "error");

      expect(useTabStore.getState().tabs).toHaveLength(1);
      expect(useTabStore.getState().getTab("tab-1")!.status).toBe("idle");
    });
  });

  // ── updateTabDuration ───────────────────────────────────────────────

  describe("updateTabDuration", () => {
    it("updates durationMs on the tab", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-1", status: "idle" }));
      useTabStore.getState().updateTabDuration("tab-1", 5000);

      expect(useTabStore.getState().getTab("tab-1")!.durationMs).toBe(5000);
    });

    it("appends formatted duration to statusLabel when status is thinking or running", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-1", status: "thinking" }));
      useTabStore.getState().updateTabDuration("tab-1", 90000); // 1m 30s

      const label = useTabStore.getState().getTab("tab-1")!.statusLabel;
      expect(label).toMatch(/1m 30s/);
    });

    it("does not append duration to statusLabel for idle status", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-1", status: "idle" }));
      useTabStore.getState().updateTabDuration("tab-1", 5000);

      expect(useTabStore.getState().getTab("tab-1")!.statusLabel).toBe("Idle");
    });
  });

  // ── updateTabName ───────────────────────────────────────────────────

  describe("updateTabName", () => {
    it("updates the tab name", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-1", name: "Old Name" }));
      useTabStore.getState().updateTabName("tab-1", "New Name");

      expect(useTabStore.getState().getTab("tab-1")!.name).toBe("New Name");
    });
  });

  // ── setTabTicket ────────────────────────────────────────────────────

  describe("setTabTicket", () => {
    it("links a ticket to the tab", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-1" }));
      useTabStore.getState().setTabTicket("tab-1", "ISSUE-42");

      expect(useTabStore.getState().getTab("tab-1")!.ticketId).toBe("ISSUE-42");
    });

    it("clears the ticket when set to null", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-1", ticketId: "ISSUE-42" }));
      useTabStore.getState().setTabTicket("tab-1", null);

      expect(useTabStore.getState().getTab("tab-1")!.ticketId).toBeNull();
    });
  });

  // ── getTab ──────────────────────────────────────────────────────────

  describe("getTab", () => {
    it("returns the tab by id", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-1", name: "First" }));
      useTabStore.getState().addTab(makeTab({ id: "tab-2", name: "Second" }));

      const tab = useTabStore.getState().getTab("tab-2");
      expect(tab).toBeDefined();
      expect(tab!.name).toBe("Second");
    });

    it("returns undefined for a nonexistent id", () => {
      expect(useTabStore.getState().getTab("ghost")).toBeUndefined();
    });
  });

  // ── ptySessionId linkage ────────────────────────────────────────────

  describe("ptySessionId linkage", () => {
    it("preserves ptySessionId through the tab lifecycle", () => {
      useTabStore.getState().addTab(makeTab({ id: "tab-1", ptySessionId: "pty-abc" }));
      useTabStore.getState().updateTabStatus("tab-1", "running");
      useTabStore.getState().updateTabDuration("tab-1", 3000);
      useTabStore.getState().updateTabName("tab-1", "Renamed");

      expect(useTabStore.getState().getTab("tab-1")!.ptySessionId).toBe("pty-abc");
    });
  });
});
