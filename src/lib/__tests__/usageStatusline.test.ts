/**
 * usageStatusline — the composer's `ctx … · in … · out …` readout.
 *
 * The load-bearing assertion here is the COST GATE. PacketBench removed its cost
 * reporting surface on 2026-07-31 and kept cost purely as a guardrail input, so
 * the `$` segment must stay off unless the user explicitly turns it on, and must
 * never appear for a model whose pricing is unknown.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  SHOW_COST_STORAGE_KEY,
  fmtCost,
  fmtTokens,
  isCostDisplayEnabled,
  sessionUsageFor,
  setCostDisplayEnabled,
  shouldShowCost,
  usageStatusline,
} from "@/lib/usageStatusline";
import type { AgentMessage } from "@/types/agent-conversation";

function assistant(over: Partial<AgentMessage>): AgentMessage {
  return {
    id: over.id ?? "m",
    role: "assistant",
    content: "",
    timestamp: 1,
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("fmtTokens", () => {
  it("scales into k and M, with the M threshold just under 1M", () => {
    expect(fmtTokens(820)).toBe("820");
    expect(fmtTokens(41_234)).toBe("41.2k");
    expect(fmtTokens(1_200_000)).toBe("1.2M");
    // 999,950 rounds to "1M", never "1000k".
    expect(fmtTokens(999_950)).toBe("1M");
  });
});

describe("fmtCost", () => {
  it("keeps a third digit sub-cent and refuses a misleading zero", () => {
    expect(fmtCost(1.84)).toBe("$1.84");
    expect(fmtCost(0.004)).toBe("$0.004");
    expect(fmtCost(0.0001)).toBe("<$0.001");
  });
});

describe("usageStatusline", () => {
  const usage = {
    contextTokens: 41_200,
    totalInput: 82_000,
    totalOutput: 12_000,
    costUsd: 1.84,
  };

  it("renders the token segments and omits cost by default", () => {
    expect(usageStatusline(usage)).toBe("ctx 41.2k tok · in 82k · out 12k");
  });

  it("appends cost only when explicitly asked to", () => {
    expect(usageStatusline(usage, true)).toBe(
      "ctx 41.2k tok · in 82k · out 12k · $1.84",
    );
  });

  it("drops zero segments and returns null when there is nothing to say", () => {
    expect(
      usageStatusline({ contextTokens: 0, totalInput: 500, totalOutput: 0, costUsd: 0 }),
    ).toBe("in 500");
    expect(
      usageStatusline({ contextTokens: 0, totalInput: 0, totalOutput: 0, costUsd: 0 }),
    ).toBeNull();
    expect(usageStatusline(null)).toBeNull();
  });
});

describe("sessionUsageFor", () => {
  it("sums input/output across turns but takes context from the latest turn", () => {
    const usage = sessionUsageFor({
      model: "claude-opus-4-8",
      messages: [
        assistant({
          id: "a1",
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 500,
          costUsd: 0.5,
        }),
        { id: "u1", role: "user", content: "hi", timestamp: 2 },
        assistant({
          id: "a2",
          inputTokens: 3000,
          outputTokens: 400,
          reasoningTokens: 100,
          costUsd: 1.25,
        }),
      ],
    });
    // in = 1000 + 500 (cache) + 3000; out = 200 + 400 + 100.
    expect(usage).toEqual({
      contextTokens: 3000,
      totalInput: 4500,
      totalOutput: 700,
      costUsd: 1.75,
    });
  });

  it("returns null for a conversation that has reported nothing", () => {
    expect(sessionUsageFor({ model: "claude-opus-4-8", messages: [] })).toBeNull();
  });
});

describe("cost display opt-in", () => {
  const usage = {
    contextTokens: 1000,
    totalInput: 1000,
    totalOutput: 200,
    costUsd: 0.42,
  };
  const priced = { agent: "api-claude" as const, model: "claude-opus-4-8" };

  it("defaults OFF — an untouched install shows no dollar figure", () => {
    expect(isCostDisplayEnabled()).toBe(false);
    expect(shouldShowCost(true, priced, usage)).toBe(false);
  });

  it("shows cost once the setting is on and the model is priced", () => {
    setCostDisplayEnabled(true);
    expect(localStorage.getItem(SHOW_COST_STORAGE_KEY)).toBe("true");
    expect(shouldShowCost(true, priced, usage)).toBe(true);
  });

  it("stays off for an unpriced model even with the setting on", () => {
    setCostDisplayEnabled(true);
    // reportsCost false — no rates for this model at all.
    expect(shouldShowCost(false, priced, usage)).toBe(false);
    // And even if something claimed rates, usage that reads as unknown-priced
    // renders nothing rather than "$0.00".
    expect(
      shouldShowCost(
        true,
        { agent: "api-openrouter", model: "some/unlisted-model" },
        { contextTokens: 100, totalInput: 100, totalOutput: 50, costUsd: 0 },
      ),
    ).toBe(false);
  });

  it("shows nothing when there is no usage yet", () => {
    setCostDisplayEnabled(true);
    expect(shouldShowCost(true, priced, null)).toBe(false);
  });
});
