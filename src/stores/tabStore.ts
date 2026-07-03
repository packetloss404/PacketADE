import { create } from "zustand";

export type SessionStatus =
  | "idle"
  | "starting"
  | "thinking"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "done"
  | "error";

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: "Idle",
  starting: "Starting…",
  thinking: "Thinking…",
  running: "Working…",
  waiting_approval: "Needs approval",
  waiting_input: "Needs input",
  done: "Done",
  error: "Error",
};

export interface SessionTab {
  id: string;
  ptySessionId: string;
  name: string;
  ticketId: string | null;
  status: SessionStatus;
  statusLabel: string;
  startedAt: number;
  durationMs: number;
  projectPath: string;
}

interface TabStore {
  tabs: SessionTab[];
  activeTabId: string | null;

  addTab: (tab: Omit<SessionTab, "statusLabel" | "durationMs">) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTabStatus: (id: string, status: SessionStatus) => void;
  updateTabDuration: (id: string, durationMs: number) => void;
  updateTabName: (id: string, name: string) => void;
  setTabTicket: (id: string, ticketId: string | null) => void;
  getTab: (id: string) => SessionTab | undefined;
}

export const useTabStore = create<TabStore>((set, get) => ({
  tabs: [],
  activeTabId: null,

  addTab: (tab) => {
    const statusLabel = STATUS_LABELS[tab.status];
    const newTab: SessionTab = { ...tab, statusLabel, durationMs: 0 };
    set((s) => ({
      tabs: [...s.tabs, newTab],
      activeTabId: newTab.id,
    }));
  },

  removeTab: (id) => {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeTabId =
        s.activeTabId === id
          ? tabs.length > 0
            ? tabs[tabs.length - 1].id
            : null
          : s.activeTabId;
      return { tabs, activeTabId };
    });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  updateTabStatus: (id, status) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              status,
              statusLabel:
                status === "done"
                  ? `Done in ${formatDuration(t.durationMs)}`
                  : STATUS_LABELS[status],
            }
          : t
      ),
    }));
  },

  updateTabDuration: (id, durationMs) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              durationMs,
              statusLabel:
                t.status === "thinking" || t.status === "running"
                  ? `${STATUS_LABELS[t.status]} (${formatDuration(durationMs)})`
                  : t.status === "done"
                    ? `Done in ${formatDuration(durationMs)}`
                    : t.statusLabel,
            }
          : t
      ),
    }));
  },

  updateTabName: (id, name) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, name } : t)),
    }));
  },

  setTabTicket: (id, ticketId) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ticketId } : t)),
    }));
  },

  getTab: (id) => get().tabs.find((t) => t.id === id),
}));

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}
