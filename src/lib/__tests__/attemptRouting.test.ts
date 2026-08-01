import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ATTEMPT_AGENT,
  SUBSCRIPTION_OAUTH_AGENTS,
  localAttemptTargetFromRoute,
  resolveAttemptExecutor,
  resolveLocalAttemptTarget,
} from "@/lib/attemptRouting";
import { useRoutingStore } from "@/stores/routingStore";
import { getDefaultModel } from "@/lib/api-models";

/**
 * WI-1 — GitHub → "Draft patch" used to hardcode `api-claude-oauth` /
 * `claude-oauth`, spending the user's Claude subscription on an agentic run
 * they never picked a provider for. These pin the replacement: the routing
 * settings decide, and no automatic path can reach a subscription login.
 */
describe("attemptRouting", () => {
  beforeEach(() => {
    localStorage.clear();
    useRoutingStore.getState().resetToDefaults();
  });

  it("never resolves to a subscription-OAuth executor", () => {
    for (const oauthAgent of SUBSCRIPTION_OAUTH_AGENTS) {
      const executor = resolveAttemptExecutor({ agentConfigId: oauthAgent });
      expect(executor.agentConfigId).toBe(DEFAULT_ATTEMPT_AGENT);
      expect(SUBSCRIPTION_OAUTH_AGENTS.has(executor.agentConfigId)).toBe(false);
    }
  });

  it("honours a routing-settings pin naming an API executor", () => {
    useRoutingStore.getState().setMapping("implementation", "api-minimax", "MiniMax-M3");

    const target = resolveLocalAttemptTarget("implementation", "/repo");

    expect(target).toMatchObject({
      kind: "local",
      basePath: "/repo",
      baseBranch: "main",
      agentConfigId: "api-minimax",
      provider: "minimax",
      model: "MiniMax-M3",
    });
  });

  it("maps the executor to a canonical get_provider id", () => {
    // `api-claude` must become `anthropic`, not the naive prefix-strip
    // `claude`, which the Rust `get_provider` dispatch does not know.
    expect(localAttemptTargetFromRoute({ agentConfigId: "api-claude" }, "/repo").provider).toBe(
      "anthropic",
    );
  });

  it("falls back to the default executor when the pinned agent cannot run an attempt", () => {
    // `claude-code` is a PTY CLI agent; Flight attempts go through
    // `start_api_agent_session`, so it cannot back one.
    useRoutingStore.getState().setMapping("implementation", "claude-code", "MiniMax-M3");

    const target = resolveLocalAttemptTarget("implementation", "/repo");

    expect(target.agentConfigId).toBe(DEFAULT_ATTEMPT_AGENT);
    expect(target.provider).toBe("anthropic");
    // A model pinned for a different agent must not leak onto the fallback.
    expect(target.model).toBe(getDefaultModel(DEFAULT_ATTEMPT_AGENT));
    expect(target.model.length).toBeGreaterThan(0);
  });

  it("uses the default when the settings have never been touched", () => {
    const target = resolveLocalAttemptTarget("implementation", "/repo");
    expect(target.agentConfigId).toBe(DEFAULT_ATTEMPT_AGENT);
    expect(SUBSCRIPTION_OAUTH_AGENTS.has(target.agentConfigId)).toBe(false);
  });

  it("strips the api- prefix to build the backend provider string", () => {
    const target = localAttemptTargetFromRoute(
      { agentConfigId: "api-openrouter" },
      "/repo",
      "develop",
    );
    expect(target.provider).toBe("openrouter");
    expect(target.baseBranch).toBe("develop");
  });

  it("always produces a non-empty model", () => {
    for (const agent of ["api-claude", "api-openai", "api-minimax", "api-openrouter"]) {
      const executor = resolveAttemptExecutor({ agentConfigId: agent });
      expect(executor.model).not.toBe("");
    }
  });
});
