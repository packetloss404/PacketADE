import { beforeEach, describe, expect, it, vi } from "vitest";
import { storageKey } from "@/lib/brand";
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
  return import("../costGuardrailStore");
}

describe("cost guardrail launch gates", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
  });

  it("blocks launches when the daily hard limit is already exceeded", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ dailyLimitUsd: 5 }));
    invokeMock.mockResolvedValueOnce(JSON.stringify(analytics({ todayCostUsd: 5.01 })));

    const { assertCostGuardrailsAllowLaunch } = await loadStore();

    await expect(assertCostGuardrailsAllowLaunch("api-openai")).rejects.toThrow(
      /Daily spend is at \$5\.01 of its \$5\.00 limit/,
    );
    expect(invokeMock).toHaveBeenCalledWith("read_usage_analytics");
  });

  it("honors active overrides for an exceeded launch cap", async () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        dailyLimitUsd: 5,
        overrideUntilByKey: { daily: Date.now() + 60_000 },
      }),
    );
    invokeMock.mockResolvedValueOnce(JSON.stringify(analytics({ todayCostUsd: 5.01 })));

    const { assertCostGuardrailsAllowLaunch } = await loadStore();

    await expect(assertCostGuardrailsAllowLaunch("api-openai")).resolves.toBeUndefined();
  });

  it("does not load analytics when no launch caps are configured", async () => {
    const { assertCostGuardrailsAllowLaunch } = await loadStore();

    await expect(assertCostGuardrailsAllowLaunch("api-openai")).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
