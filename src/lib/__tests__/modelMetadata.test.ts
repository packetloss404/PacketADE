import { describe, expect, it } from "vitest";
import { API_PROVIDERS } from "@/lib/api-models";
import { pickFailoverModel } from "@/lib/autoFailover";
import { aggregateConversationCost, getModelRates } from "@/lib/conversationCost";
import { pricingStatusForModel } from "@/lib/modelPricing";
import type { AgentConversation } from "@/types/agent-conversation";

const catalogValues = new Set(
  API_PROVIDERS.flatMap((provider) => provider.models.map((model) => model.value)),
);

function conversationWithModel(model: string): AgentConversation {
  return {
    mode: "api",
    model,
    messages: [
      {
        id: "msg_1",
        role: "assistant",
        content: "ok",
        timestamp: 0,
        inputTokens: 1_000,
        outputTokens: 500,
      },
    ],
  } as AgentConversation;
}

describe("model metadata", () => {
  it("returns only catalog-backed failover models", () => {
    const fallbacks = [
      pickFailoverModel("claude-opus-4-7"),
      pickFailoverModel("claude-opus-4-6-20250415"),
      pickFailoverModel("anthropic/claude-opus-4-7"),
      pickFailoverModel("gpt-5.5"),
      pickFailoverModel("gpt-4o"),
      pickFailoverModel("MiniMax-M2.5"),
    ];

    for (const fallback of fallbacks) {
      expect(fallback).not.toBeNull();
      expect(catalogValues.has(fallback!)).toBe(true);
    }
  });

  it("covers fixed-price catalog models used by the cost pill", () => {
    const fixedPriceModels = [...catalogValues].filter(
      (model) => model !== "openrouter/auto",
    );

    for (const model of fixedPriceModels) {
      const { estCost } = aggregateConversationCost(conversationWithModel(model));
      expect(estCost, model).not.toBeNull();
    }
  });

  it("sources every populated ApiModel.pricing from the single conversationCost rate table", () => {
    for (const provider of API_PROVIDERS) {
      for (const model of provider.models) {
        if (model.pricing === undefined) continue;
        expect(model.pricing, model.value).toEqual(getModelRates(model.value));
      }
    }
  });

  // Only the local Ollama engine is genuinely free. Every other catalog row is
  // a paid cloud route, so a "free" verdict there means a rate lookup fell
  // through to the $0 `local` row — the failure mode that let bare `qwen` /
  // `deepseek` / `codellama` prefixes swallow vendor-namespaced paid ids and
  // report $0. Budget guardrails read this status, so a wrong "free" here
  // means no guardrail ever fires. This gate matters most when the OpenRouter
  // row stops being a hardcoded handful and is enumerated live.
  it("marks no paid-provider catalog model as free", () => {
    for (const provider of API_PROVIDERS) {
      for (const model of provider.models) {
        const status = pricingStatusForModel(model.value);
        if (provider.id === "ollama") {
          expect(status, model.value).toBe("free");
        } else {
          expect(status, `${provider.id}/${model.value}`).not.toBe("free");
        }
      }
    }
  });
});
