import { create } from "zustand";
import { readUsageAnalytics } from "@/lib/tauri";
import { storageKey } from "@/lib/brand";
import {
  computeCostGuardrailStatus,
  DEFAULT_COST_GUARDRAIL_SETTINGS,
  normalizeCostGuardrailSettings,
  type CostGuardrailStatus,
  type CostGuardrailSettings,
  type CostPricingStatus,
} from "@/lib/costGuardrails";

export interface ModelUsage {
  model: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  source: string;
  pricingStatus?: CostPricingStatus;
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
  todayCostUsd?: number;
  currentMonthCostUsd?: number;
  unknownPricingModelUsage?: ModelUsage[];
}

interface AnalyticsStore {
  data: AnalyticsData | null;
  loading: boolean;
  error: string | null;
  guardrailSettings: CostGuardrailSettings;
  guardrailStatus: CostGuardrailStatus;
  load: () => Promise<void>;
  updateGuardrailSettings: (patch: Partial<CostGuardrailSettings>) => void;
  resetGuardrailSettings: () => void;
}

const GUARDRAIL_STORAGE_KEY = storageKey("cost-guardrails");

const initialGuardrailSettings = loadGuardrailSettings();

export const useAnalyticsStore = create<AnalyticsStore>((set, get) => ({
  data: null,
  loading: false,
  error: null,
  guardrailSettings: initialGuardrailSettings,
  guardrailStatus: computeCostGuardrailStatus(null, initialGuardrailSettings),
  load: async () => {
    set({ loading: true, error: null });
    try {
      const raw = await readUsageAnalytics();
      const parsed = JSON.parse(raw) as AnalyticsData;
      set({
        data: parsed,
        guardrailStatus: computeCostGuardrailStatus(parsed, get().guardrailSettings),
        loading: false,
      });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  },
  updateGuardrailSettings: (patch) => {
    set((state) => {
      const next = normalizeCostGuardrailSettings({ ...state.guardrailSettings, ...patch });
      saveGuardrailSettings(next);
      return {
        guardrailSettings: next,
        guardrailStatus: computeCostGuardrailStatus(state.data, next),
      };
    });
  },
  resetGuardrailSettings: () => {
    const next = { ...DEFAULT_COST_GUARDRAIL_SETTINGS };
    saveGuardrailSettings(next);
    set({
      guardrailSettings: next,
      guardrailStatus: computeCostGuardrailStatus(get().data, next),
    });
  },
}));

function loadGuardrailSettings(): CostGuardrailSettings {
  const storage = getLocalStorage();
  if (!storage) return { ...DEFAULT_COST_GUARDRAIL_SETTINGS };

  const raw = storage.getItem(GUARDRAIL_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_COST_GUARDRAIL_SETTINGS };

  try {
    return normalizeCostGuardrailSettings(JSON.parse(raw) as Partial<CostGuardrailSettings>);
  } catch {
    return { ...DEFAULT_COST_GUARDRAIL_SETTINGS };
  }
}

function saveGuardrailSettings(settings: CostGuardrailSettings): void {
  const storage = getLocalStorage();
  if (!storage) return;
  storage.setItem(GUARDRAIL_STORAGE_KEY, JSON.stringify(settings));
}

function getLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
