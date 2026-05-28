import { beforeEach, describe, expect, it, vi } from "vitest";
import { storageKey } from "@/lib/brand";
import { computeCostGuardrailStatus, normalizeCostGuardrailSettings } from "@/lib/costGuardrails";
import type { AnalyticsData } from "../analyticsStore";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const SETTINGS_KEY = storageKey("cost-guardrails");

function analytics(overrides: Partial<AnalyticsData> = {}): AnalyticsData {
  return {
    totalCostUsd: 0,
    totalSessions: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    modelUsage: [],
    dailyCosts: [],
    todayCostUsd: 0,
    currentMonthCostUsd: 0,
    unknownPricingModelUsage: [],
    ...overrides,
  };
}

async function loadStore() {
  vi.resetModules();
  return import("../analyticsStore");
}

describe("cost guardrails", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
  });

  it("computes warning and hard-limit states from daily spend", () => {
    const settings = normalizeCostGuardrailSettings({ dailyLimitUsd: 10 });
    const warning = computeCostGuardrailStatus(analytics({ todayCostUsd: 8 }), settings, {
      now: new Date("2026-05-28T12:00:00Z"),
    });
    const limit = computeCostGuardrailStatus(analytics({ todayCostUsd: 10.25 }), settings, {
      now: new Date("2026-05-28T12:00:00Z"),
    });

    expect(warning.level).toBe("warning");
    expect(warning.activeScope?.scope).toBe("daily");
    expect(warning.requiresApproval).toBe(false);
    expect(limit.level).toBe("limit");
    expect(limit.requiresApproval).toBe(true);
    expect(limit.canOverride).toBe(true);
  });

  it("computes monthly limits from the backend monthly aggregate", () => {
    const status = computeCostGuardrailStatus(
      analytics({ currentMonthCostUsd: 51 }),
      normalizeCostGuardrailSettings({ monthlyLimitUsd: 50 }),
    );

    expect(status.level).toBe("limit");
    expect(status.activeScope).toMatchObject({
      scope: "monthly",
      spendUsd: 51,
      limitUsd: 50,
    });
  });

  it("surfaces unknown pricing as distinct from free usage", () => {
    const unknownUsage = {
      source: "codex",
      model: "future-model-x",
      sessions: 1,
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0,
      pricingStatus: "unknown" as const,
    };
    const status = computeCostGuardrailStatus(
      analytics({
        modelUsage: [unknownUsage],
        unknownPricingModelUsage: [unknownUsage],
      }),
      normalizeCostGuardrailSettings({ dailyLimitUsd: 10 }),
    );

    expect(status.level).toBe("unknown_pricing");
    expect(status.hasUnknownPricing).toBe(true);
    expect(status.unknownPricingModelUsage).toEqual([unknownUsage]);
  });

  it("persists guardrail settings and recomputes status after analytics load", async () => {
    invokeMock.mockResolvedValueOnce(JSON.stringify(analytics({ todayCostUsd: 8.5 })));

    const { useAnalyticsStore } = await loadStore();
    useAnalyticsStore.getState().updateGuardrailSettings({
      dailyLimitUsd: 10,
      warningThresholdPercent: 70,
    });

    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toMatchObject({
      dailyLimitUsd: 10,
      warningThresholdPercent: 70,
      hardStopThresholdPercent: 100,
    });

    await useAnalyticsStore.getState().load();

    expect(useAnalyticsStore.getState().guardrailStatus.level).toBe("warning");

    const reloaded = await loadStore();
    expect(reloaded.useAnalyticsStore.getState().guardrailSettings).toMatchObject({
      dailyLimitUsd: 10,
      warningThresholdPercent: 70,
    });
  });
});
