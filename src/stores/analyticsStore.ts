import { create } from "zustand";
import { readUsageAnalytics } from "@/lib/tauri";

export interface ModelUsage {
  model: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface DailyCost {
  date: string;
  costUsd: number;
}

export interface AnalyticsData {
  totalCostUsd: number;
  totalSessions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  modelUsage: ModelUsage[];
  dailyCosts: DailyCost[];
}

interface AnalyticsStore {
  data: AnalyticsData | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
}

export const useAnalyticsStore = create<AnalyticsStore>((set) => ({
  data: null,
  loading: false,
  error: null,
  load: async () => {
    set({ loading: true, error: null });
    try {
      const raw = await readUsageAnalytics();
      const parsed = JSON.parse(raw) as AnalyticsData;
      set({ data: parsed, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  },
}));
