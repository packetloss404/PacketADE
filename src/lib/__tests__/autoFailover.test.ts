import { describe, expect, it } from "vitest";
import {
  isAccountLevelExhaustion,
  looksLikeRateLimit,
  pickFailoverModel,
} from "@/lib/autoFailover";

describe("autoFailover", () => {
  describe("isAccountLevelExhaustion", () => {
    it("treats a drained quota / balance as account-level", () => {
      // Every one of these is a property of the ACCOUNT, so no other model the
      // same session can reach will succeed either. These are exactly the
      // errors MiniMax's same-pool ladder used to retry into. Each must ALSO
      // be one `looksLikeRateLimit` recognises, or the guard never runs.
      for (const message of [
        "Error code: 429 - insufficient_quota: You exceeded your current quota",
        "Your credit balance is too low to access the Anthropic API",
        "You have hit your usage limit for this billing period",
      ]) {
        expect(looksLikeRateLimit(message), message).toBe(true);
        expect(isAccountLevelExhaustion(message), message).toBe(true);
      }
    });

    it("leaves per-model throttles alone so they still fail over", () => {
      // Capacity errors are per-model, so stepping down a tier genuinely helps.
      for (const message of [
        "429 rate_limit_error: tokens per minute exceeded",
        "Overloaded",
        "overload_error: the model is temporarily overloaded",
      ]) {
        expect(looksLikeRateLimit(message), message).toBe(true);
        expect(isAccountLevelExhaustion(message), message).toBe(false);
      }
    });

    it("ignores unrelated errors", () => {
      expect(isAccountLevelExhaustion("")).toBe(false);
      expect(isAccountLevelExhaustion("connection reset by peer")).toBe(false);
    });
  });

  describe("pickFailoverModel", () => {
    it("keeps every failover target on the current provider", () => {
      // retryLastTurn only swaps SessionConfig.model — the provider, endpoint
      // and API key are fixed for the session — so a cross-vendor target would
      // post an unknown model id to the wrong endpoint.
      const minimaxFallback = pickFailoverModel("MiniMax-M2.5");
      expect(minimaxFallback).not.toBeNull();
      expect(minimaxFallback!.toLowerCase()).toContain("minimax");

      expect(pickFailoverModel("claude-opus-4-7")).toContain("claude-sonnet");
      expect(pickFailoverModel("claude-sonnet-4-6")).toContain("claude-haiku");
    });

    it("returns null for a model outside every catalog", () => {
      expect(pickFailoverModel("totally-unknown-model-xyz")).toBeNull();
    });
  });
});
