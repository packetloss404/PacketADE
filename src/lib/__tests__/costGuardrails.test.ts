import { describe, expect, it } from "vitest";
import {
  computeCostGuardrailStatus,
  isUnknownPricedUsage,
  normalizeCostGuardrailSettings,
} from "@/lib/costGuardrails";

describe("cost guardrails", () => {
  it("marks 80 percent as warning and 100 percent as over budget", () => {
    const settings = normalizeCostGuardrailSettings({
      dailyLimitUsd: 10,
      monthlyLimitUsd: null,
      sessionLimitUsd: null,
      warningThresholdPercent: 80,
      hardStopThresholdPercent: 100,
      requireApprovalAtLimit: true,
    });
    const baseData = {
      totalCostUsd: 0,
      totalSessions: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      modelUsage: [],
      dailyCosts: [],
    };

    expect(
      computeCostGuardrailStatus({ ...baseData, todayCostUsd: 7.99 }, settings).activeScope?.level,
    ).toBe("ok");
    expect(
      computeCostGuardrailStatus({ ...baseData, todayCostUsd: 8 }, settings).activeScope?.level,
    ).toBe("warning");
    expect(
      computeCostGuardrailStatus({ ...baseData, todayCostUsd: 10 }, settings).activeScope?.level,
    ).toBe("limit");
  });

  it("normalizes bad settings into bounded values", () => {
    expect(
      normalizeCostGuardrailSettings({
        dailyLimitUsd: Number.NaN,
        warningThresholdPercent: 999,
        hardStopThresholdPercent: 50,
      }),
    ).toEqual({
      dailyLimitUsd: null,
      monthlyLimitUsd: null,
      sessionLimitUsd: null,
      providerLimitsUsd: {},
      missionLimitsUsd: {},
      warningThresholdPercent: 100,
      hardStopThresholdPercent: 100,
      requireApprovalAtLimit: true,
      overrideUntilByKey: {},
    });
  });

  it("flags token usage that priced as zero for non-local models", () => {
    expect(
      isUnknownPricedUsage({
        source: "api-openai",
        model: "future-model",
        inputTokens: 1000,
        outputTokens: 1000,
        costUsd: 0,
      }),
    ).toBe(true);

    expect(
      isUnknownPricedUsage({
        source: "api-ollama",
        model: "llama3.3:70b",
        inputTokens: 1000,
        outputTokens: 1000,
        costUsd: 0,
      }),
    ).toBe(false);
  });
});
